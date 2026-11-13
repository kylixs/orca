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
}

export function createHostKeyGuard(input: {
  userDataPath?: string
  closeConnection: (code: number, reason: string) => void
  now?: () => number
}): HostKeyGuard {
  const now = input.now ?? (() => Date.now())
  const trust: HostTrustStore = loadHostTrust(input.userDataPath)
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
        input.closeConnection(FINGERPRINT_MISMATCH_CLOSE_CODE, 'fingerprint_mismatch')
        throw Object.assign(new Error('host public key changed'), {
          code: 'FINGERPRINT_MISMATCH',
          closeCode: FINGERPRINT_MISMATCH_CLOSE_CODE,
          pinnedFingerprint: verdict.pinnedFingerprint,
          seenFingerprint: verdict.seenFingerprint
        })
      }
      if (verdict.state === 'first_use') {
        pin(hostId, e2eePublicKeyB64)
      }
    },
    trust: (hostId, e2eePublicKeyB64) => pin(hostId, e2eePublicKeyB64),
    pinnedFingerprint: (hostId) => trust.hosts[hostId]?.fingerprint ?? null
  }
}
