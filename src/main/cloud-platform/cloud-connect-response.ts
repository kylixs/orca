/**
 * Desktop facade over the reply parsing the browser client also uses. The
 * implementation lives in `src/shared` so both sides read one contract.
 */
export {
  parseConnectTicketReply as parseConnectTicket,
  parseProjectListReply as parseProjectList,
  readTicketClaims
} from '../../shared/cloud-platform-reply'
export type { CloudTicketClaims as TicketClaims } from '../../shared/cloud-platform-reply'
