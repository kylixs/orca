import {
  isRevokedTicket,
  notifyRevokedTokens,
  type AdmittedTicket,
  type CloudAdmissionLedger
} from './cloud-admission-ledger'
import type { CloudRevocations } from './cloud-upgrade-admission'

/** Live sockets keyed by the ticket text they were admitted with. */
type RevocableSessions = { forget: (credential: string) => void }
type RevocationListeners = Set<(deviceTokens: string[]) => void>

export type CloudRevocationNotifier = {
  emitRevokedSessions: () => void
  /** Host-wide revocation: every admitted ticket is dead, whatever its age. */
  revokeAllAdmitted: () => void
}

export function createCloudRevocationNotifier(input: {
  ledger: Pick<CloudAdmissionLedger, 'entries' | 'forget' | 'drain'>
  sessions: RevocableSessions
  revocations: () => Required<CloudRevocations>
  listeners: RevocationListeners
}): CloudRevocationNotifier {
  const emitRevokedSessions = (): void => {
    const revokedTokens: string[] = []
    for (const [jti, ticket] of input.ledger.entries()) {
      if (!isRevokedTicket(jti, ticket, input.revocations())) {
        continue
      }
      input.ledger.forget(jti)
      input.sessions.forget(ticket.credential)
      revokedTokens.push(ticket.deviceToken)
    }
    notifyRevokedTokens(input.listeners, revokedTokens)
  }

  const revokeAllAdmitted = (): void => {
    const drained = input.ledger.drain()
    for (const ticket of drained) {
      input.sessions.forget(ticket.credential)
    }
    notifyRevokedTokens(
      input.listeners,
      drained.map((ticket: AdmittedTicket) => ticket.deviceToken)
    )
  }

  return { emitRevokedSessions, revokeAllAdmitted }
}
