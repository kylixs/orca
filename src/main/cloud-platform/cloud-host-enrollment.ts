import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { hardenExistingSecureFile, writeSecureJsonFile } from '../../shared/secure-file'
import { readField, readNumber, readObjectValue, readString } from '../../shared/json-fields'

/**
 * Host enrolment with the cloud platform.
 *
 * A registration token is single-use (design §11: `/v1/hosts/tokens`), so the
 * credential the platform returns is persisted: restarting a dev machine must
 * not require a fresh operator-issued token, and must not silently come up
 * unregistered.
 */

export const CLOUD_HOST_CREDENTIAL_FILENAME = 'orca-cloud-host.json'

export type CloudHostCredential = {
  hostId: string
  hostName: string
  credential: string
  registeredAt: number
}

/**
 * The address part of an advertised direct address: `[v6]:port`, `v4:port`, a
 * bare IPv6 literal, or a bare host. The port is not part of the label.
 */
export function ipOfDirectAddr(addr: string): string | null {
  const value = addr.trim()
  if (value === '') {
    return null
  }
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    return end > 1 ? value.slice(1, end) : null
  }
  const first = value.indexOf(':')
  const last = value.lastIndexOf(':')
  if (first === -1) {
    return value
  }
  // One colon separates host and port; several mean a bare IPv6 literal.
  return first === last ? value.slice(0, first) : value
}

/**
 * Route keys are the SNI labels clients dial through the relay, so they must be
 * dot-free (the relay refuses dotted labels) and keep resolving — the advertised
 * IP, not an intranet hostname. No address falls back to the hostname.
 */
export function defaultRelayRoute(directAddrs: string[], hostName: string): string {
  const addr = directAddrs.map(ipOfDirectAddr).find((ip) => ip !== null)
  return addr ? `ip-${addr.replace(/[.:]/g, '-')}` : hostName
}

export type EnrollInput = {
  apiUrl: string
  /** One-time token minted by an admin (`POST /v1/hosts/tokens`). */
  hostToken: string
  hostName: string
  directAddrs: string[]
  relayTarget?: string
  relayRoute?: string
  e2eePublicKeyB64?: string
  /** SHA-256 of the TLS certificate clients will see on the direct address. */
  tlsFingerprint?: string
  orcaVersion?: string
  /** Parent directory the platform may create self-service projects under. */
  projectsRoot?: string
}

function isCloudHostCredential(value: unknown): value is CloudHostCredential {
  return (
    readString(value, 'hostId') !== null &&
    readString(value, 'hostName') !== null &&
    readString(value, 'credential') !== null &&
    readNumber(value, 'registeredAt') !== null
  )
}

export function readStoredHostCredential(userDataPath: string): CloudHostCredential | null {
  const path = join(userDataPath, CLOUD_HOST_CREDENTIAL_FILENAME)
  if (!existsSync(path)) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return isCloudHostCredential(parsed) ? parsed : null
  } catch {
    // An unreadable credential is the same as none: the caller falls back to
    // enrolment, which requires a fresh token — never a silent unregistered host.
    return null
  }
}

export function storeHostCredential(userDataPath: string, value: CloudHostCredential): void {
  const path = join(userDataPath, CLOUD_HOST_CREDENTIAL_FILENAME)
  mkdirSync(dirname(path), { recursive: true })
  if (!writeSecureJsonFile(path, value)) {
    throw new Error('failed to persist cloud host credential')
  }
  hardenExistingSecureFile(path)
}

/** Why structured: a caller must tell a spent token (401) from a transport failure. */
export type CloudHostEnrolmentError = {
  /** Stable code, or a local code for transport/protocol failures. */
  code: string
  /** Whether the same request may succeed later (network/5xx). */
  retryable: boolean
  /** HTTP status when the platform answered; absent when the request never landed. */
  httpStatus?: number
  /** Transport message or missing-field description, for logs. */
  detail?: string
}

export type EnrollOutcome =
  | { ok: true; value: CloudHostCredential }
  | { ok: false; error: CloudHostEnrolmentError }

/** Actionable operator text for the failures a restart cannot repair. */
const ENROLMENT_GUIDANCE: Record<string, string> = {
  host_token_invalid:
    '令牌已被使用或过期。若平台 /v1/hosts 已存在同名主机，则上一次注册已成功但响应丢失；请确认该主机后重新生成安装命令（不要重复使用本命令）。',
  host_revoked: '主机已被平台吊销。请管理员恢复该主机，或更换主机名后重新生成安装命令。',
  host_name_required: '缺少主机名。请在 host.env 中设置 ORCA_CLOUD_HOST_NAME 后重启服务。'
}

/** Carries the classification and the operator-facing remedy to the process entry. */
export class CloudHostEnrolmentFailure extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly httpStatus: number | null

  constructor(failure: CloudHostEnrolmentError) {
    const status = failure.httpStatus === undefined ? '' : ` (HTTP ${failure.httpStatus})`
    const guidance = ENROLMENT_GUIDANCE[failure.code]
    super(
      `cloud host enrolment failed: ${failure.code}${status}${failure.detail ? `: ${failure.detail}` : ''}${guidance ? `. ${guidance}` : ''}`
    )
    this.name = 'CloudHostEnrolmentFailure'
    this.code = failure.code
    this.retryable = failure.retryable
    this.httpStatus = failure.httpStatus ?? null
  }
}

const NON_RETRYABLE_CODES: Record<number, string> = {
  400: 'host_name_required',
  401: 'host_token_invalid',
  409: 'host_revoked'
}

/** Platform wire codes that the host mode contract publishes in lowercase. */
const PLATFORM_CODE_ALIASES: Record<string, string> = {
  HOST_TOKEN_INVALID: 'host_token_invalid',
  HOST_REVOKED: 'host_revoked',
  HOST_NAME_REQUIRED: 'host_name_required'
}

/** Stable code/retryability for an HTTP failure, preferring the platform's own code. */
function enrolmentErrorFromStatus(
  status: number,
  platformCode: string | null
): CloudHostEnrolmentError {
  const retryable = status >= 500
  const normalized =
    platformCode === null ? null : (PLATFORM_CODE_ALIASES[platformCode] ?? platformCode)
  return {
    code: normalized ?? NON_RETRYABLE_CODES[status] ?? (retryable ? 'http_5xx' : 'register_failed'),
    retryable,
    httpStatus: status
  }
}

/** Design §3.3: host mode retries transport/5xx inside the process, then exits 1. */
export const HOST_ENROLMENT_RETRY_DELAYS_MS: readonly number[] = [1_000, 5_000, 15_000]

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export type EnrolmentRetryOptions = {
  fetchImpl?: typeof fetch
  /** Test seam; production uses 1s/5s/15s. */
  retryDelaysMs?: readonly number[]
  sleep?: (ms: number) => Promise<void>
}

export async function enrollCloudHostWithRetry(
  input: EnrollInput,
  options: EnrolmentRetryOptions = {}
): Promise<EnrollOutcome> {
  const delays = options.retryDelaysMs ?? HOST_ENROLMENT_RETRY_DELAYS_MS
  const wait = options.sleep ?? sleepMs
  let outcome = await enrollCloudHost(input, options.fetchImpl)
  for (const delay of delays) {
    if (outcome.ok || !outcome.error.retryable) {
      return outcome
    }
    await wait(delay)
    outcome = await enrollCloudHost(input, options.fetchImpl)
  }
  return outcome
}

export async function enrollCloudHost(
  input: EnrollInput,
  fetchImpl: typeof fetch = fetch
): Promise<EnrollOutcome> {
  let res: Response
  try {
    res = await fetchImpl(`${input.apiUrl}/v1/hosts/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${input.hostToken}` },
      body: JSON.stringify({
        name: input.hostName,
        fingerprint: `host:${input.hostName}`,
        e2eePublicKeyB64: input.e2eePublicKeyB64 ?? '',
        ...(input.tlsFingerprint ? { tlsFingerprint: input.tlsFingerprint } : {}),
        orcaVersion: input.orcaVersion ?? '',
        protocolVersion: 3,
        networkZone: 'intranet',
        directAddrs: input.directAddrs,
        relayTarget: input.relayTarget ?? '',
        relayRoute: input.relayRoute ?? defaultRelayRoute(input.directAddrs, input.hostName),
        runtimeCapabilities: ['pty', 'files', 'agent', 'managed-credential'],
        ...(input.projectsRoot ? { projectsRoot: input.projectsRoot } : {})
      }),
      signal: AbortSignal.timeout(10_000)
    })
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'network',
        retryable: true,
        detail: error instanceof Error ? error.message : String(error)
      }
    }
  }
  if (!res.ok) {
    const code = readString(readField(await res.json().catch(() => null), 'error'), 'code')
    return { ok: false, error: enrolmentErrorFromStatus(res.status, code) }
  }
  const body: unknown = await res.json()
  const hostId = readString(body, 'hostId')
  const credential = readString(body, 'credential')
  if (hostId === null || credential === null) {
    return {
      ok: false,
      error: {
        code: 'protocol',
        retryable: false,
        httpStatus: res.status,
        detail: 'register response missing hostId/credential'
      }
    }
  }
  return {
    ok: true,
    value: {
      hostId,
      hostName: input.hostName,
      credential,
      registeredAt: Date.now()
    }
  }
}

/** Advertised addresses, resolved per beat; omitted when none are configured. */
export function heartbeatAddrsField(configured: string[] | (() => string[]) | undefined): {
  directAddrs?: string[]
} {
  if (!configured) {
    return {}
  }
  const value = typeof configured === 'function' ? configured() : configured
  return value.length > 0 ? { directAddrs: value } : {}
}

export type HeartbeatResult = {
  policyVersion: number
  policies: unknown
  revoked: unknown
  maintenance: { reason: string } | null
  /** The platform has revoked this host; every session it hosts must be closed. */
  hostRevoked: boolean
  /**
   * Raw U37 provision assignments; parsed defensively by the client. Absent on
   * platforms older than the field, which reads as no assignments.
   */
  provisionAssignments: unknown
  /**
   * §2.9 wire-additive capability advertisement. Absent on platforms older than
   * U66 file events; the client parses it defensively and never gates on the
   * field being missing (see cloud-file-event-audit.ts for the delivery rule).
   */
  auditCapabilities: unknown
}

export type HeartbeatErrorCode = 'heartbeat_unauthorized' | 'heartbeat_failed' | 'host_revoked'

/** Why structured: a rejected beat must keep its HTTP status, not collapse into null. */
export type HeartbeatAttempt =
  | { ok: true; httpStatus: number; errorCode: null; result: HeartbeatResult }
  | { ok: false; httpStatus: number | null; errorCode: HeartbeatErrorCode; result: null }

export async function sendHeartbeat(
  apiUrl: string,
  credential: string,
  hostId: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 3_000
): Promise<HeartbeatAttempt> {
  let httpStatus: number | null = null
  try {
    const res = await fetchImpl(`${apiUrl}/v1/hosts/${hostId}/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    })
    httpStatus = res.status
    if (!res.ok) {
      const errorCode: HeartbeatErrorCode =
        httpStatus === 401
          ? 'heartbeat_unauthorized'
          : httpStatus === 409
            ? 'host_revoked'
            : 'heartbeat_failed'
      return {
        ok: false,
        httpStatus,
        errorCode,
        result: null
      }
    }
    const parsed: unknown = await res.json()
    const policyVersion = readNumber(parsed, 'policyVersion')
    if (policyVersion === null) {
      return { ok: false, httpStatus, errorCode: 'heartbeat_failed', result: null }
    }
    const maintenance = readObjectValue(readField(parsed, 'maintenance'))
    return {
      ok: true,
      httpStatus,
      errorCode: null,
      result: {
        policyVersion,
        policies: readField(parsed, 'policies'),
        revoked: readField(parsed, 'revoked'),
        maintenance:
          maintenance === null ? null : { reason: readString(maintenance, 'reason') ?? '' },
        hostRevoked: readField(parsed, 'hostRevoked') === true,
        provisionAssignments: readField(parsed, 'provisionAssignments'),
        auditCapabilities: readField(parsed, 'auditCapabilities')
      }
    }
  } catch {
    // A network failure has no status; keep null rather than inventing one.
    return { ok: false, httpStatus, errorCode: 'heartbeat_failed', result: null }
  }
}
