import type {
  RuntimeHostStatusSnapshot,
  RuntimeHostStatusResponse
} from '../../../shared/runtime-host-status'
import type { WebRuntimeSubscribeOptions } from './web-runtime-subscription-contract'
import type { WebRuntimeClient } from './web-runtime-client'

/** The handle one streamed subscription answers with. */
export type WebRuntimeSubscriptionHandle = {
  unsubscribe: () => void
  sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => void
}

export type SubscribeOptions = WebRuntimeSubscribeOptions

export type WebRuntimeClientStatusOptions = {
  environmentId: string
  pairingRevision: number
  publish: (snapshot: RuntimeHostStatusSnapshot) => void
  verified: (response: RuntimeHostStatusResponse) => void
}

/**
 * The client surface the preload session relies on. A cloud handoff adopts a client
 * that was created before the environment existed, so the session attaches status
 * wiring afterwards instead of constructing a second client.
 */
export type WebRuntimeSessionClient = Pick<
  WebRuntimeClient,
  'call' | 'subscribe' | 'close' | 'attachStatusOwner' | 'statusOwner' | 'connectionState'
> & {
  /** Optional: scripted doubles and legacy adopters sign no further tickets. */
  attachTicketReSigner?: WebRuntimeClient['attachTicketReSigner']
}
