import type { RemoteRuntimeClientError } from './remote-runtime-client-error'
import type { RuntimeCapability } from './protocol-version'
import type { RuntimeRpcResponse } from './runtime-rpc-envelope'
import type { RemoteRuntimeSocketLivenessOptions } from './remote-runtime-socket-liveness'
import type {
  RemoteRuntimeOutboundMemoryBudget,
  RemoteRuntimeOutboundQueueOptions
} from './remote-runtime-subscription-outbound'

export type RemoteRuntimeTransportSubscription = {
  requestId: string
  close: () => void
  sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => boolean
  sendRequest?: (
    method: string,
    params: unknown,
    timeoutMs: number
  ) => Promise<RuntimeRpcResponse<unknown>>
}

export type RemoteRuntimeTransportSubscriptionCallbacks<TResult = unknown> = {
  onResponse: (response: RuntimeRpcResponse<TResult>) => void
  onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
  onError: (error: RemoteRuntimeClientError) => void
  onClose?: () => void
}

/** The cloud ticket a host demands at the WebSocket upgrade. */
export type CloudUpgradeOption = {
  credential: string
  devicePubKey: string
  /** Test-only: accept a host certificate the CA did not sign. */
  tlsRejectUnauthorized?: boolean
  /** SNI for relay routes. */
  servername?: string
}

/**
 * The key pair the E2EE handshake uses. Cloud links supply the device key so the
 * host can check it against the key the platform bound into the ticket.
 */
export type RemoteRuntimeClientKeyPair = {
  publicKey: Uint8Array
  secretKey: Uint8Array
}

export type RemoteRuntimeSubscriptionOptions = RemoteRuntimeSocketLivenessOptions & {
  signal?: AbortSignal
  clientCapabilities?: readonly RuntimeCapability[]
  perMessageDeflate?: boolean
  outboundQueue?: RemoteRuntimeOutboundQueueOptions
  outboundMemoryBudget?: RemoteRuntimeOutboundMemoryBudget
  // Why: overridable so the connect-bound regression test can pin the ordering against the
  // subscription-start timer without spending production wall-clock.
  connectTimeoutMs?: number
  /**
   * Cloud ticket presented at the WebSocket upgrade (`x-orca-reject` on failure).
   * Absent means an ordinary paired host, which needs no upgrade credential and
   * must keep connecting exactly as before.
   */
  cloudUpgrade?: CloudUpgradeOption
  /** Defaults to a fresh key pair, which no cloud host will accept as a device proof. */
  clientKeyPair?: RemoteRuntimeClientKeyPair
}
