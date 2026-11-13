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

export type EnrollInput = {
  apiUrl: string
  /** One-time token minted by an admin (`POST /v1/hosts/tokens`). */
  hostToken: string
  hostName: string
  directAddrs: string[]
  relayTarget?: string
  relayRoute?: string
  e2eePublicKeyB64?: string
  orcaVersion?: string
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
        orcaVersion: input.orcaVersion ?? '',
        protocolVersion: 3,
        networkZone: 'intranet',
        directAddrs: input.directAddrs,
        relayTarget: input.relayTarget ?? '',
        relayRoute: input.relayRoute ?? input.hostName,
        runtimeCapabilities: ['pty', 'files', 'agent', 'managed-credential']
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
      maintenance: maintenance === null ? null : { reason: readString(maintenance, 'reason') ?? '' }
    }
  } catch {
    return null
  }
}
