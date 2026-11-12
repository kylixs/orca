import type { PairingOffer } from './pairing'

/**
 * A prepared cloud link as the main process hands it to a caller in-process.
 * It carries the ticket, so it is never sent to a renderer.
 */
export type CloudProjectLinkPayload = {
  offer: {
    v: number
    endpoint: string
    deviceToken: string
    publicKeyB64: string
    pairedDeviceId?: string
    scope?: string
  }
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

/**
 * The prepared link carries the cloud ticket alongside the offer; Orca's remote
 * client takes the offer alone. Returns null when the payload is not a runtime
 * offer this client can use.
 */
export function pairingOfferFromCloudLink(link: CloudProjectLinkPayload): PairingOffer | null {
  const { offer } = link
  if (offer.v !== 2 || offer.scope !== 'runtime') {
    return null
  }
  return {
    v: 2,
    endpoint: offer.endpoint,
    deviceToken: offer.deviceToken,
    publicKeyB64: offer.publicKeyB64,
    ...(offer.pairedDeviceId ? { pairedDeviceId: offer.pairedDeviceId } : {}),
    scope: 'runtime'
  }
}
