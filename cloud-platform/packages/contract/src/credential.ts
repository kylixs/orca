import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  type KeyObject
} from 'node:crypto'

export type Permission =
  | 'open'
  | 'terminal'
  | 'agent'
  | 'file:read'
  | 'file:write'
  | 'browser'
  | 'download'

export type CredentialPayload = {
  v: 1
  jti: string
  sub: string
  aud: string
  host: string
  project: string
  projectRoot: string
  workspaceRoot: string
  deviceId: string
  devicePubKey: string
  deviceToken: string
  perms: Permission[]
  iat: number
  /** Issued-at in milliseconds. `iat` is whole seconds, so revocation (ms) needs this to avoid a same-second lockout. */
  iatMs?: number
  exp: number
}

export type PublicKeyEntry = { kid: string; publicKeyPem: string }

const HEADER = { alg: 'EdDSA', typ: 'JWT' } as const

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

function fromB64url(input: string): Buffer {
  return Buffer.from(input, 'base64url')
}

/** Deterministic JSON: sorted keys, so signature verification is stable across processes. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

export type SigningKey = { kid: string; privateKey: KeyObject; publicKeyPem: string }

export function generateSigningKey(kid: string): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    kid,
    privateKey,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString()
  }
}

export function signCredential(payload: CredentialPayload, key: SigningKey): string {
  const header = { ...HEADER, kid: key.kid }
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(canonicalJson(payload))}`
  const signature = sign(null, Buffer.from(signingInput), key.privateKey)
  return `${signingInput}.${b64url(signature)}`
}

export type VerifyResult =
  | { ok: true; payload: CredentialPayload; kid: string }
  | { ok: false; reason: 'malformed' | 'unknown_kid' | 'bad_signature' | 'expired' | 'not_yet_valid' }

export function verifyCredential(
  token: string,
  keys: Map<string, string>,
  nowSeconds: number,
  clockSkewSeconds = 60
): VerifyResult {
  const parts = token.split('.')
  if (parts.length !== 3) return { ok: false, reason: 'malformed' }
  let header: { alg?: string; kid?: string }
  let payload: CredentialPayload
  try {
    header = JSON.parse(fromB64url(parts[0]).toString('utf8'))
    payload = JSON.parse(fromB64url(parts[1]).toString('utf8'))
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (header.alg !== 'EdDSA' || typeof header.kid !== 'string') {
    return { ok: false, reason: 'malformed' }
  }
  const pem = keys.get(header.kid)
  if (!pem) return { ok: false, reason: 'unknown_kid' }
  let publicKey: KeyObject
  try {
    publicKey = createPublicKey(pem)
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  const signingInput = `${parts[0]}.${parts[1]}`
  const valid = verify(null, Buffer.from(signingInput), publicKey, fromB64url(parts[2]))
  if (!valid) return { ok: false, reason: 'bad_signature' }
  if (typeof payload.exp !== 'number' || nowSeconds > payload.exp + clockSkewSeconds) {
    return { ok: false, reason: 'expired' }
  }
  if (typeof payload.iat !== 'number' || payload.iat - clockSkewSeconds > nowSeconds) {
    return { ok: false, reason: 'not_yet_valid' }
  }
  return { ok: true, payload, kid: header.kid }
}

export function newJti(): string {
  return randomBytes(16).toString('hex')
}

export function newDeviceToken(): string {
  return randomBytes(32).toString('base64url')
}

export function loadSigningKeyFromPem(kid: string, privateKeyPem: string): SigningKey {
  const privateKey = createPrivateKey(privateKeyPem)
  const publicKeyPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString()
  return { kid, privateKey, publicKeyPem }
}
