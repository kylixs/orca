import type { PairingOffer } from '../../shared/pairing'
import type { CloudConnectTicket, CloudEndpoint } from './cloud-connect-client'

/**
 * Maps a cloud ticket onto Orca's existing pairing offer, so the renderer can
 * attach with `subscribeRemoteRuntimeRequest` instead of a parallel client.
 *
 * The two extra pieces the shared client did not previously have — the ticket in
 * the upgrade subprotocol and the device key header — travel separately as
 * `cloudUpgrade`, leaving ordinary paired hosts untouched.
 */

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
  expiresIn: number
}

const PAIRING_OFFER_VERSION = 2

function claimsOf(credential: string): { deviceToken?: string; deviceId?: string } | null {
  try {
    return JSON.parse(Buffer.from(credential.split('.')[1], 'base64url').toString()) as {
      deviceToken?: string
      deviceId?: string
    }
  } catch {
    return null
  }
}

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
  const claims = claimsOf(ticket.credential)
  const devicePubKey = deviceKeyOf(ticket.credential)
  if (!claims?.deviceToken || !devicePubKey || !ticket.host.e2eePublicKeyB64) {
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
      devicePubKey: deviceKeyOf(ticket.credential),
      ...(route === 'relay' && endpoint.sni ? { servername: endpoint.sni } : {}),
      ...(input.tlsRejectUnauthorized === false ? { tlsRejectUnauthorized: false } : {})
    },
    route,
    workspaceRoot: ticket.workspace.workspaceRoot,
    expiresIn: ticket.expiresIn
  }
}

/** The ticket's device binding; the host compares it to `x-orca-device-pubkey`. */
function deviceKeyOf(credential: string): string {
  try {
    const claims = JSON.parse(Buffer.from(credential.split('.')[1], 'base64url').toString()) as {
      devicePubKey?: string
    }
    return claims.devicePubKey ?? ''
  } catch {
    return ''
  }
}
