import type { PairingOffer } from '../../shared/pairing'
import type { CloudConnectTicket, CloudEndpoint } from './cloud-connect-client'
import { readTicketClaims } from './cloud-connect-response'

/**
 * Maps a cloud ticket onto Orca's existing pairing offer, so the renderer can
 * attach with `subscribeRemoteRuntimeRequest` instead of a parallel client.
 *
 * The two extra pieces the shared client did not previously have — the ticket in
 * the upgrade subprotocol and the device key header — travel separately as
 * `cloudUpgrade`, leaving ordinary paired hosts untouched.
 */

export type CloudProjectLinkResult =
  | { ok: true; link: CloudProjectLink }
  | { ok: false; code: string; message?: string }

export type CloudProjectLink = {
  offer: PairingOffer
  cloudUpgrade: {
    credential: string
    devicePubKey: string
    servername?: string
    tlsRejectUnauthorized?: boolean
  }
  route: 'direct' | 'relay'
  workspaceRoot: string
  /** The repository root the host signs into the ticket; the native row's path. */
  projectRoot: string
  expiresIn: number
}

const PAIRING_OFFER_VERSION = 2

/**
 * Returns null when the ticket cannot drive a real connection: the renderer would
 * otherwise fail at handshake time with no explanation.
 */
export function buildCloudProjectLink(input: {
  ticket: CloudConnectTicket
  endpoint: CloudEndpoint
  route: 'direct' | 'relay'
  tlsRejectUnauthorized?: boolean
}): CloudProjectLink | null {
  const { ticket, endpoint, route } = input
  const claims = readTicketClaims(ticket.credential)
  if (!claims.deviceToken || !claims.devicePubKey || !ticket.host.e2eePublicKeyB64) {
    return null
  }
  const hostKey = Buffer.from(ticket.host.e2eePublicKeyB64, 'base64')
  // A 32-byte Curve25519 key is what the E2EE handshake requires; anything else
  // means the host never reported one (it enrols before its runtime starts).
  if (hostKey.length !== 32) {
    return null
  }
  return {
    offer: {
      v: PAIRING_OFFER_VERSION,
      endpoint: endpoint.url,
      deviceToken: claims.deviceToken,
      publicKeyB64: ticket.host.e2eePublicKeyB64,
      ...(claims.deviceId ? { pairedDeviceId: claims.deviceId } : {}),
      scope: 'runtime'
    },
    cloudUpgrade: {
      credential: ticket.credential,
      devicePubKey: claims.devicePubKey,
      ...(route === 'relay' && endpoint.sni ? { servername: endpoint.sni } : {}),
      ...(input.tlsRejectUnauthorized === false ? { tlsRejectUnauthorized: false } : {})
    },
    route,
    workspaceRoot: ticket.workspace.workspaceRoot,
    projectRoot: ticket.workspace.projectRoot,
    expiresIn: ticket.expiresIn
  }
}
