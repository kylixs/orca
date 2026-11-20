import { randomUUID } from 'node:crypto'
import {
  generateSigningKey,
  type PublicKeyEntry,
  type SigningKey
} from '../../../packages/contract/src/credential.ts'

/**
 * Rotating signing keys (design §6.5 C 4429 / AC-31). A rotation must not
 * invalidate tickets already in flight, and a host that has not refetched the
 * JWKS in a while must still verify them — so retired public keys stay
 * published for a retention window rather than disappearing with the rotation.
 */

export const KEY_RETENTION_MS = 60 * 24 * 60 * 60 * 1000

export type RetiredSigningKey = PublicKeyEntry & { retiredAt: number; retainUntil: number }

export type SigningKeyRing = {
  current: () => SigningKey
  /** Current + retained public keys, as `/v1/jwks` must serve them. */
  publicKeys: () => PublicKeyEntry[]
  retired: () => RetiredSigningKey[]
  rotate: () => { current: SigningKey; retired: SigningKey }
  /** Drops keys whose retention has lapsed; returns how many were dropped. */
  prune: (nowMs: number) => number
}

function kid(nowMs: number): string {
  // Why a suffix: two rotations in the same millisecond must not share a kid.
  return `kid-${nowMs}-${randomUUID().slice(0, 8)}`
}

export function createSigningKeyRing(
  now: () => number,
  retentionMs = KEY_RETENTION_MS
): SigningKeyRing {
  let active = generateSigningKey(kid(now()))
  let retiredKeys: RetiredSigningKey[] = []

  const prune = (nowMs: number): number => {
    const before = retiredKeys.length
    retiredKeys = retiredKeys.filter((entry) => entry.retainUntil > nowMs)
    return before - retiredKeys.length
  }

  return {
    current: () => active,
    publicKeys: () => {
      prune(now())
      return [
        { kid: active.kid, publicKeyPem: active.publicKeyPem },
        ...retiredKeys.map(({ kid: retiredKid, publicKeyPem }) => ({
          kid: retiredKid,
          publicKeyPem
        }))
      ]
    },
    retired: () => [...retiredKeys],
    rotate: () => {
      const nowMs = now()
      prune(nowMs)
      const previous = active
      retiredKeys.push({
        kid: previous.kid,
        publicKeyPem: previous.publicKeyPem,
        retiredAt: nowMs,
        retainUntil: nowMs + retentionMs
      })
      active = generateSigningKey(kid(nowMs))
      return { current: active, retired: previous }
    },
    prune
  }
}
