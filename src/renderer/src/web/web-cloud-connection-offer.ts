import type { WebPairingOffer } from './web-pairing'
import {
  cloudPairingOfferFromTicket,
  requestCloudTicket,
  type CloudPairingOfferOptions,
  type WebCloudSession
} from './web-cloud-session'
import type { RequestOptions } from './web-cloud-request'

/** Both the request options and the endpoint override one offer minting needs. */
export type CloudPairingOfferRequestOptions = RequestOptions & CloudPairingOfferOptions

/**
 * Mints a fresh single-use upgrade ticket and the offer that presents it. A
 * cloud ticket is one connection wide, so every extra socket a client opens —
 * a stream subscription's child socket — signs its own through here (W5c).
 */
export async function requestCloudPairingOffer(
  session: WebCloudSession,
  projectId: string,
  devicePublicKeyB64: string,
  options: CloudPairingOfferRequestOptions = {}
): Promise<WebPairingOffer> {
  const ticket = await requestCloudTicket(session, projectId, devicePublicKeyB64, options)
  return cloudPairingOfferFromTicket(ticket, devicePublicKeyB64, options)
}
