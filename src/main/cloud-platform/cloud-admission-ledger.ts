import type { CloudRevocations } from './cloud-upgrade-admission'

/**
 * The tickets this host admitted, keyed by jti. A ticket is a bearer credential,
 * so its text is also the socket handle the gate and the close path use.
 */

export type AdmittedTicket = {
  deviceToken: string
  deviceId: string
  sub: string
  project: string
  iatMs: number
  /** The ticket text as carried in the subprotocol. */
  credential: string
}

export type CloudAdmissionLedger = {
  /** A copied ticket must not upgrade twice before it expires. */
  isReplayed: (jti: string) => boolean
  remember: (input: { jti: string; ticket: AdmittedTicket; expiresAtMs: number }) => void
  entries: () => MapIterator<[string, AdmittedTicket]>
  forget: (jti: string) => AdmittedTicket | null
  /** Host-wide revocation: every admitted ticket is dead, whatever its age. */
  drain: () => AdmittedTicket[]
  size: () => number
}

export function createCloudAdmissionLedger(now: () => number): CloudAdmissionLedger {
  const usedJtis = new Map<string, number>()
  const admitted = new Map<string, AdmittedTicket>()
  return {
    isReplayed: (jti) => {
      const nowMs = now()
      for (const [used, expiresAtMs] of usedJtis) {
        if (expiresAtMs <= nowMs) {
          usedJtis.delete(used)
        }
      }
      return usedJtis.has(jti)
    },
    remember: ({ jti, ticket, expiresAtMs }) => {
      usedJtis.set(jti, expiresAtMs)
      admitted.set(jti, ticket)
    },
    entries: () => admitted.entries(),
    forget: (jti) => {
      const ticket = admitted.get(jti) ?? null
      admitted.delete(jti)
      return ticket
    },
    drain: () => {
      const drained = [...admitted.values()]
      admitted.clear()
      return drained
    },
    size: () => admitted.size
  }
}

/** Tickets admitted before the revocation `since` are dead, whatever their socket state. */
export function isRevokedTicket(
  jti: string,
  ticket: AdmittedTicket,
  revocations: Required<CloudRevocations>
): boolean {
  const deviceSince = revocations.devices.find((entry) => entry.id === ticket.deviceId)?.since
  const userSince = revocations.users.find(
    (entry) => entry.id === ticket.sub.replace(/^user:/, '')
  )?.since
  const projectSince = revocations.projects.find((entry) => entry.id === ticket.project)?.since
  return (
    (deviceSince !== undefined && ticket.iatMs <= deviceSince) ||
    (userSince !== undefined && ticket.iatMs <= userSince) ||
    (projectSince !== undefined && ticket.iatMs <= projectSince) ||
    revocations.jtis.includes(jti)
  )
}

/** One callback per batch of dead device tokens; an empty batch notifies nobody. */
export function notifyRevokedTokens(
  listeners: ReadonlySet<(deviceTokens: string[]) => void>,
  deviceTokens: readonly string[]
): void {
  if (deviceTokens.length === 0) {
    return
  }
  for (const listener of listeners) {
    listener([...deviceTokens])
  }
}
