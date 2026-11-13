import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify
} from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Signed audit anchors (design §13.2): every few minutes the writer signs the
 * current chain tip `(seq, hash, at)`. An anchor is the only thing that can prove
 * the log was not rewritten wholesale — the hash chain alone is self-consistent
 * after a full re-forge, but an anchor copy held elsewhere is not.
 *
 * Anchors are stored append-only next to the log, and the signing key lives in
 * its own file so it can be held separately in production.
 */

export type AuditAnchor = {
  seq: number
  /** `hash` of the event at `seq`; this is the tip as of `at`. */
  hash: string
  at: number
  /** base64 Ed25519 signature over the canonical anchor body. */
  signature: string
}

export type AnchorKey = { publicKeyPem: string; privateKeyPem: string }

export function anchorPayload(anchor: Omit<AuditAnchor, 'signature'>): string {
  return `${anchor.seq}|${anchor.hash}|${anchor.at}`
}

export function createAnchorKey(): AnchorKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  }
}

/** Loads the anchor key, creating and persisting it on first use. */
export function loadOrCreateAnchorKey(path: string): AnchorKey {
  if (existsSync(path)) {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    const publicKeyPem = Reflect.get(parsed as object, 'publicKeyPem')
    const privateKeyPem = Reflect.get(parsed as object, 'privateKeyPem')
    if (typeof publicKeyPem === 'string' && typeof privateKeyPem === 'string') {
      return { publicKeyPem, privateKeyPem }
    }
    // Why throw: signing with a fresh key after a corrupt one would orphan every
    // anchor an operator already recorded.
    throw new Error(`anchor key file is malformed: ${path}`)
  }
  const key = createAnchorKey()
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, JSON.stringify(key), { mode: 0o600 })
  return key
}

export function signAuditAnchor(
  privateKeyPem: string,
  body: Omit<AuditAnchor, 'signature'>
): AuditAnchor {
  const signature = sign(null, Buffer.from(anchorPayload(body)), createPrivateKey(privateKeyPem))
  return { ...body, signature: signature.toString('base64') }
}

/** Independent check: only needs the public key and the anchor itself. */
export function verifyAuditAnchor(publicKeyPem: string, anchor: AuditAnchor): boolean {
  try {
    return verify(
      null,
      Buffer.from(anchorPayload(anchor)),
      createPublicKey(publicKeyPem),
      Buffer.from(anchor.signature, 'base64')
    )
  } catch {
    return false
  }
}

/**
 * Whether the anchored event still sits in the chain with the anchored hash.
 * A rebuilt (re-forged) chain anchors to a different hash here, which is exactly
 * what an anchor is for.
 */
export function anchorMatchesChain(
  events: readonly { seq: number; hash: string }[],
  anchor: AuditAnchor
): boolean {
  return events.some((event) => event.seq === anchor.seq && event.hash === anchor.hash)
}

export type AnchorStore = {
  key: AnchorKey
  list: () => AuditAnchor[]
  /** Signs and appends one anchor for the given tip. */
  append: (tip: { seq: number; hash: string }, at: number) => AuditAnchor
  lastSeq: () => number
}

function isAnchor(value: unknown): value is AuditAnchor {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof Reflect.get(value, 'seq') === 'number' &&
    typeof Reflect.get(value, 'hash') === 'string' &&
    typeof Reflect.get(value, 'at') === 'number' &&
    typeof Reflect.get(value, 'signature') === 'string'
  )
}

export function openAnchorStore(options: { path: string; keyPath: string }): AnchorStore {
  const key = loadOrCreateAnchorKey(options.keyPath)
  const anchors: AuditAnchor[] = []
  if (existsSync(options.path)) {
    for (const line of readFileSync(options.path, 'utf8').split('\n')) {
      if (line.trim() === '') continue
      const parsed: unknown = JSON.parse(line)
      // Why throw: an unreadable anchor line is evidence of tampering, not noise.
      if (!isAnchor(parsed)) throw new Error(`anchor file is malformed: ${options.path}`)
      anchors.push(parsed)
    }
  }
  return {
    key,
    list: () => anchors.map((anchor) => ({ ...anchor })),
    lastSeq: () => anchors.at(-1)?.seq ?? 0,
    append: (tip, at) => {
      const anchor = signAuditAnchor(key.privateKeyPem, { seq: tip.seq, hash: tip.hash, at })
      anchors.push(anchor)
      mkdirSync(dirname(options.path), { recursive: true })
      appendFileSync(options.path, `${JSON.stringify(anchor)}\n`, { encoding: 'utf8', mode: 0o600 })
      return anchor
    }
  }
}
