import {
  hostKeyVerdict,
  loadHostTrust,
  pinHostKey,
  saveHostTrust,
  type HostTrustStore
} from './cloud-host-trust'
import type { CloudConnectTicket } from './cloud-connect-client'

/**
 * TOFU (design §10.4): the first key seen for a host is pinned; a later, different
 * one is a substitution attempt — close anything live with 4433 and refuse.
 * Re-verification goes through `trust()`, never silently.
 */

export const FINGERPRINT_MISMATCH_CLOSE_CODE = 4433

export type HostKeyGuard = {
  /** Throws `FINGERPRINT_MISMATCH` after closing the live socket on a changed key. */
  check: (ticket: CloudConnectTicket) => void
  /** The user re-verified a changed host key. */
  trust: (hostId: string, e2eePublicKeyB64: string) => void
  pinnedFingerprint: (hostId: string) => string | null
  /**
   * Pins the key the last mismatch exposed, without the key crossing the IPC
   * boundary. Returns false when nothing is pending for that host.
   */
  trustPending: (hostId: string) => boolean
}

export function createHostKeyGuard(input: {
  userDataPath?: string
  closeConnection: (code: number, reason: string) => void
  now?: () => number
}): HostKeyGuard {
  const now = input.now ?? (() => Date.now())
  const trust: HostTrustStore = loadHostTrust(input.userDataPath)
  // Why held here: re-verification must not require the renderer to carry a key.
  const pending = new Map<string, string>()
  const persist = (): void => saveHostTrust(input.userDataPath, trust)

  const pin = (hostId: string, e2eePublicKeyB64: string): void => {
    pinHostKey(trust, hostId, e2eePublicKeyB64, now())
    persist()
  }

  return {
    check: (ticket) => {
      const { id: hostId, e2eePublicKeyB64 } = ticket.host
      if (!e2eePublicKeyB64) {
        return
      }
      const verdict = hostKeyVerdict(trust, hostId, e2eePublicKeyB64)
      if (verdict.state === 'mismatch') {
        pending.set(hostId, e2eePublicKeyB64)
        input.closeConnection(FINGERPRINT_MISMATCH_CLOSE_CODE, 'fingerprint_mismatch')
        throw Object.assign(new Error('host public key changed'), {
          code: 'FINGERPRINT_MISMATCH',
          hostId,
          closeCode: FINGERPRINT_MISMATCH_CLOSE_CODE,
          pinnedFingerprint: verdict.pinnedFingerprint,
          seenFingerprint: verdict.seenFingerprint
        })
      }
      if (verdict.state === 'first_use') {
        pin(hostId, e2eePublicKeyB64)
      }
      pending.delete(hostId)
    },
    trust: (hostId, e2eePublicKeyB64) => {
      pin(hostId, e2eePublicKeyB64)
      pending.delete(hostId)
    },
    trustPending: (hostId) => {
      const key = pending.get(hostId)
      if (key === undefined) {
        return false
      }
      pin(hostId, key)
      pending.delete(hostId)
      return true
    },
    pinnedFingerprint: (hostId) => trust.hosts[hostId]?.fingerprint ?? null
  }
}

/** Pulls the re-verification payload off a thrown `FINGERPRINT_MISMATCH`, if it is one. */
export function hostKeyDetails(error: unknown): {
  hostKey?: { hostId: string; pinnedFingerprint: string; seenFingerprint: string }
} {
  if (
    error === null ||
    typeof error !== 'object' ||
    Reflect.get(error, 'code') !== 'FINGERPRINT_MISMATCH'
  ) {
    return {}
  }
  const pinnedFingerprint = Reflect.get(error, 'pinnedFingerprint')
  const seenFingerprint = Reflect.get(error, 'seenFingerprint')
  const hostId = Reflect.get(error, 'hostId')
  if (typeof pinnedFingerprint !== 'string' || typeof seenFingerprint !== 'string') {
    return {}
  }
  return {
    hostKey: {
      hostId: typeof hostId === 'string' ? hostId : '',
      pinnedFingerprint,
      seenFingerprint
    }
  }
}

/** The renderer only says "the user verified this host"; the key stays in main. */
export function trustPendingHostKey(
  client: { trustPendingHostKey: (hostId: string) => boolean } | null,
  hostId: string
): { ok: true } | { ok: false; code: string } {
  if (!client) {
    return { ok: false, code: 'NOT_SIGNED_IN' }
  }
  return client.trustPendingHostKey(hostId)
    ? { ok: true }
    : { ok: false, code: 'HOST_KEY_NOT_PENDING' }
}
