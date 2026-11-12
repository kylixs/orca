import WebSocket from 'ws'
import type { PairingOffer } from './pairing'
import { remoteRuntimeConnectOptions } from './remote-runtime-connect-bound'
import { REMOTE_RUNTIME_MAX_WEBSOCKET_FRAME_BYTES } from './remote-runtime-memory-limits'
import type { RemoteRuntimeSubscriptionOptions } from './remote-runtime-subscription-contract'

export const CLOUD_CREDENTIAL_PROTOCOL_PREFIX = 'orca-cred.'
export const CLOUD_DEVICE_PUBKEY_HEADER = 'x-orca-device-pubkey'

/**
 * Opens the subscription socket. A cloud ticket rides in the upgrade
 * subprotocol and the device key in a header; `ws` only accepts both as
 * constructor options, so an ordinary paired host keeps the exact same call.
 */
export function openRemoteRuntimeSocket(
  pairing: PairingOffer,
  options?: RemoteRuntimeSubscriptionOptions
): WebSocket {
  const cloud = options?.cloudUpgrade
  const connectOptions = remoteRuntimeConnectOptions(
    {
      maxPayload: REMOTE_RUNTIME_MAX_WEBSOCKET_FRAME_BYTES,
      ...(options?.perMessageDeflate === false ? { perMessageDeflate: false } : {}),
      ...(cloud
        ? {
            headers: { [CLOUD_DEVICE_PUBKEY_HEADER]: cloud.devicePubKey },
            ...(cloud.servername ? { servername: cloud.servername } : {}),
            ...(cloud.tlsRejectUnauthorized === false ? { rejectUnauthorized: false } : {})
          }
        : {})
    },
    options?.connectTimeoutMs
  )
  if (!cloud) {
    return new WebSocket(pairing.endpoint, connectOptions)
  }
  return new WebSocket(
    pairing.endpoint,
    ['orca-runtime', `${CLOUD_CREDENTIAL_PROTOCOL_PREFIX}${cloud.credential}`],
    connectOptions
  )
}
