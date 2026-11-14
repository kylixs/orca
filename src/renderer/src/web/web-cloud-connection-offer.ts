import type { WebPairingOffer } from './web-pairing'
import {
  cloudPairingOfferFromTicket,
  requestCloudTicket,
  type CloudPairingOfferOptions,
  type WebCloudSession
} from './web-cloud-session'
import type { RequestOptions } from './web-cloud-request'

/**
 * A minted ticket named a host key other than the one the live connection was
 * verified against (AC-29) — the substitution the first connect refuses,
 * refused here before any child socket opens.
 */
export class WebCloudHostKeyMismatchError extends Error {
  readonly code = 'FINGERPRINT_MISMATCH'
  constructor(
    readonly expectedHostKeyB64: string,
    readonly seenHostKeyB64: string
  ) {
    super('host public key changed')
    this.name = 'WebCloudHostKeyMismatchError'
  }
}

/** The request options, the endpoint override, and the host-key pin one mint checks. */
export type CloudPairingOfferRequestOptions = RequestOptions &
  CloudPairingOfferOptions & {
    /** AC-29: the parent offer's host key; a ticket naming another key is refused. */
    expectedHostKeyB64?: string
  }

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
  const offer = cloudPairingOfferFromTicket(ticket, devicePublicKeyB64, options)
  // Why fail closed: the ticket's host key is host-reported, so pinning a child
  // to the parent's verified key is what keeps a live session from silently
  // opening a stream to a key-swapped host.
  if (
    options.expectedHostKeyB64 !== undefined &&
    offer.publicKeyB64 !== options.expectedHostKeyB64
  ) {
    throw new WebCloudHostKeyMismatchError(options.expectedHostKeyB64, offer.publicKeyB64)
  }
  return offer
}
