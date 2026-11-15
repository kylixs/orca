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

export type EnrollOutcome = { ok: true; value: CloudHostCredential } | { ok: false; error: string }

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
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  if (!res.ok) {
    const code = readString(readField(await res.json().catch(() => null), 'error'), 'code')
    return { ok: false, error: code ?? `register failed: ${res.status}` }
  }
  const body: unknown = await res.json()
  const hostId = readString(body, 'hostId')
  const credential = readString(body, 'credential')
  if (hostId === null || credential === null) {
    return { ok: false, error: 'register response missing hostId/credential' }
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

export async function sendHeartbeat(
  apiUrl: string,
  credential: string,
  hostId: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 3_000
): Promise<HeartbeatResult | null> {
  try {
    const res = await fetchImpl(`${apiUrl}/v1/hosts/${hostId}/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!res.ok) {
      return null
    }
    const parsed: unknown = await res.json()
    const policyVersion = readNumber(parsed, 'policyVersion')
    if (policyVersion === null) {
      return null
    }
    const maintenance = readObjectValue(readField(parsed, 'maintenance'))
    return {
      policyVersion,
      policies: readField(parsed, 'policies'),
      revoked: readField(parsed, 'revoked'),
      maintenance:
        maintenance === null ? null : { reason: readString(maintenance, 'reason') ?? '' },
      hostRevoked: readField(parsed, 'hostRevoked') === true,
      provisionAssignments: readField(parsed, 'provisionAssignments'),
      auditCapabilities: readField(parsed, 'auditCapabilities')
    }
  } catch {
    return null
  }
}
