import { readCloudCredentialFromHeaders, type CloudUpgradeHeaders } from './cloud-upgrade-admission'
import { createCloudSessionLimits, type CloudSessionIdentity } from './cloud-session-limits'

/**
 * Bookkeeping between the pre-handshake ticket check and the live socket it
 * becomes. The ticket text is what the socket carries, so it keys the identity;
 * the identity's device token keys the cap.
 */

export type CloudConnectionSessions = {
  remember: (credential: string, identity: CloudSessionIdentity) => void
  /** Forgets the ticket and returns its slot; safe on paths that never took one. */
  forget: (credential: string) => void
  gate: {
    accept: (headers: CloudUpgradeHeaders) => boolean
    release: (headers: CloudUpgradeHeaders) => void
  }
  activeCount: () => number
  releaseAll: () => void
}

export function createCloudConnectionSessions(
  options: { perUserProject?: number; perHost?: number } = {}
): CloudConnectionSessions {
  const limits = createCloudSessionLimits(options)
  const identities = new Map<string, CloudSessionIdentity>()

  const forget = (credential: string): void => {
    const identity = identities.get(credential)
    if (identity === undefined) {
      return
    }
    identities.delete(credential)
    limits.release(identity.token)
  }

  return {
    remember: (credential, identity) => {
      identities.set(credential, identity)
    },
    forget,
    gate: {
      accept: (headers) => {
        const credential = readCloudCredentialFromHeaders(headers)
        const identity = credential === null ? undefined : identities.get(credential)
        // No identity means this peer was not admitted by the cloud gate (the
        // transport only installs this gate when it is). Charge nothing rather
        // than reject a peer whose ticket bookkeeping was already consumed.
        return identity === undefined ? true : limits.tryOpen(identity)
      },
      release: (headers) => {
        const credential = readCloudCredentialFromHeaders(headers)
        if (credential !== null) {
          forget(credential)
        }
      }
    },
    activeCount: () => limits.activeCount(),
    releaseAll: () => {
      for (const identity of identities.values()) {
        limits.release(identity.token)
      }
      identities.clear()
    }
  }
}
