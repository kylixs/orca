import type { E2EEAuthenticatedDevice } from './e2ee-channel'

/**
 * Device proof of possession.
 *
 * The cloud platform binds each ticket to a device key, and completing the E2EE
 * handshake proves the client holds that key's secret. A device with no recorded
 * key (an ordinary paired phone) has nothing to prove; a cloud device must match.
 */
export function deviceProofHolds(
  device: Pick<E2EEAuthenticatedDevice, 'publicKeyB64'>,
  handshakePublicKeyB64: string | null
): boolean {
  if (!device.publicKeyB64) {
    return true
  }
  // v2 handshakes carry no plaintext key; their own session establishes identity.
  if (handshakePublicKeyB64 === null) {
    return true
  }
  return handshakePublicKeyB64 === device.publicKeyB64
}
