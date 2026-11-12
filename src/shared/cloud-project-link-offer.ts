import type { CloudProjectLinkPayload } from './cloud-platform-ipc'
import type { PairingOffer } from './pairing'

/**
 * The IPC payload carries the cloud ticket alongside the offer; Orca's remote
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
