import { createPublicKey, verify, type KeyObject } from 'node:crypto'

// Host-side twin of cloud-platform/packages/contract/src/credential.ts.
// Kept dependency-free (node:crypto only) so it can be imported both by the main
// process and by the platform's Node test runner; a parity test in
// cloud-platform/test/cloud-admission-parity.test.ts fails if the two drift.

export type CloudPermission =
  | 'open'
  | 'terminal'
  | 'agent'
  | 'file:read'
  | 'file:write'
  | 'browser'
  | 'download'

export type CloudCredentialPayload = {
  v: 1
  jti: string
  sub: string
  aud: string
  host: string
  project: string
  projectRoot: string
  workspaceRoot: string
  /** Optional: absent on tickets minted before project provisioning existed. */
  repoUrl?: string
  defaultBranch?: string
  deviceId: string
  devicePubKey: string
  deviceToken: string
  perms: CloudPermission[]
  iat: number
  /** Millisecond issue time; absent for tickets minted before it was added. */
  iatMs?: number
  exp: number
}

export type CloudCredentialVerdict =
  | { ok: true; payload: CloudCredentialPayload; kid: string }
  | {
      ok: false
      reason: 'malformed' | 'unknown_kid' | 'bad_signature' | 'expired' | 'not_yet_valid'
    }

// Why local: this module must stay dependency-free — the platform's parity test
// imports it directly under plain Node type stripping.
function ownEntries(value: unknown): [string, unknown][] {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.entries(value)
    : []
}

/** Deterministic JSON (sorted keys) so the signature input matches the platform's. */
export function canonicalCloudJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalCloudJson).join(',')}]`
  }
  const entries = ownEntries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalCloudJson(v)}`).join(',')}}`
}

export function verifyCloudCredential(
  token: string,
  keys: Map<string, string>,
  nowSeconds: number,
  clockSkewSeconds = 60
): CloudCredentialVerdict {
  const parts = token.split('.')
  if (parts.length !== 3) {
    return { ok: false, reason: 'malformed' }
  }
  let header: { alg?: string; kid?: string }
  let payload: CloudCredentialPayload
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (header.alg !== 'EdDSA' || typeof header.kid !== 'string') {
    return { ok: false, reason: 'malformed' }
  }
  const pem = keys.get(header.kid)
  if (!pem) {
    return { ok: false, reason: 'unknown_kid' }
  }
  let publicKey: KeyObject
  try {
    publicKey = createPublicKey(pem)
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  const signingInput = `${parts[0]}.${parts[1]}`
  const valid = verify(
    null,
    Buffer.from(signingInput),
    publicKey,
    Buffer.from(parts[2], 'base64url')
  )
  if (!valid) {
    return { ok: false, reason: 'bad_signature' }
  }
  if (typeof payload.exp !== 'number' || nowSeconds > payload.exp + clockSkewSeconds) {
    return { ok: false, reason: 'expired' }
  }
  if (typeof payload.iat !== 'number' || payload.iat - clockSkewSeconds > nowSeconds) {
    return { ok: false, reason: 'not_yet_valid' }
  }
  return { ok: true, payload, kid: header.kid }
}
