import { readArray, readNumber, readString } from '../../shared/json-fields'
import { parseCloudPolicies, type CloudPolicies } from './cloud-policies'

/** Response shapes the host accepts from the platform's key and policy endpoints. */

export type PlatformSigningKey = { kid: string; publicKeyPem: string }

export function parseKeys(value: unknown): PlatformSigningKey[] {
  return (readArray(value, 'keys') ?? []).flatMap((item) => {
    const kid = readString(item, 'kid')
    const publicKeyPem = readString(item, 'publicKeyPem')
    return kid !== null && publicKeyPem !== null ? [{ kid, publicKeyPem }] : []
  })
}

/** What consuming one JWKS response settles: the kept key set and its fetch time. */
export type AppliedJwks = {
  keys: Map<string, string>
  fetchedAt: number | null
  error: string | null
}

/**
 * `/v1/internal/jwks` consumption. A bad response is recorded as the tick's
 * error, never thrown — a bad key endpoint must not skip the revocation pass —
 * and a partial body keeps the last good keys rather than admitting nothing.
 */
export async function applyJwksResponse(
  jwksRes: { ok: boolean; status: number; json: () => Promise<unknown> } | null,
  currentKeys: Map<string, string>,
  fetchedAt: number | null,
  now: () => number
): Promise<AppliedJwks> {
  if (jwksRes === null) {
    return { keys: currentKeys, fetchedAt, error: 'jwks fetch failed' }
  }
  if (!jwksRes.ok) {
    return { keys: currentKeys, fetchedAt, error: `jwks fetch failed: ${jwksRes.status}` }
  }
  const parsedKeys = parseKeys(await jwksRes.json())
  if (parsedKeys.length === 0) {
    return { keys: currentKeys, fetchedAt, error: null }
  }
  return {
    keys: new Map(parsedKeys.map((entry) => [entry.kid, entry.publicKeyPem])),
    fetchedAt: now(),
    error: null
  }
}

export type PolicyResponse = { policies: CloudPolicies; version: number | null }

/**
 * `/v1/internal/policy` body. Null when the pack is not understood, so the caller
 * keeps the previous one instead of reopening exports on a truncated reply.
 */
export function parsePolicyResponse(value: unknown): PolicyResponse | null {
  const policies = parseCloudPolicies(value)
  return policies === null ? null : { policies, version: readNumber(value, 'version') }
}

/**
 * §2.9 heartbeat capability advertisement. Null when the platform did not send
 * the field (pre-U66 platforms) — callers decide what absence means; a malformed
 * body parses as absent rather than half-understood.
 */
export function parseAuditCapabilities(value: unknown): { fileEvents: boolean } | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const fileEvents = Reflect.get(value, 'fileEvents')
  return typeof fileEvents === 'boolean' ? { fileEvents } : null
}
