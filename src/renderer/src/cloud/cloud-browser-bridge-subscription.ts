import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { failure, type OpenConnection } from './cloud-browser-bridge-replies'

/** A live subscription whose `unsubscribe` also releases the host stream. */
export type CloudSubscription = { unsubscribe: () => void }

export type CloudSubscriptionCallbacks = {
  onEvent: (event: unknown) => void
  onClose: () => void
  onError?: (error: { code: string; message: string }) => void
}

export type CloudSubscribeOutcome =
  | { ok: true; subscription: CloudSubscription }
  | { ok: false; code: string; message?: string }

/**
 * One streamed runtime subscription over a project's live browser socket
 * (`terminal.subscribe` is the M118 consumer). The host answers the opening
 * frame with `{streaming: true}` replies on the same id, then an `{type:'end'}`
 * frame; the transport hands each to `onResponse` and the last one to `onClose`.
 */
export async function subscribeOverConnection(
  entry: OpenConnection | null,
  method: string,
  params: Record<string, unknown>,
  callbacks: CloudSubscriptionCallbacks
): Promise<CloudSubscribeOutcome> {
  if (!entry) {
    return { ok: false, code: 'NOT_CONNECTED' }
  }
  const { subscribe } = entry.client
  if (typeof subscribe !== 'function') {
    return { ok: false, code: 'STREAM_UNSUPPORTED' }
  }
  const onFrame = (response: RuntimeRpcResponse<unknown>): void => {
    if (response.ok) {
      callbacks.onEvent(response.result)
      return
    }
    callbacks.onError?.({ code: response.error.code, message: response.error.message })
  }
  try {
    const handle = await subscribe.call(entry.client, method, params, {
      onResponse: onFrame,
      onClose: () => callbacks.onClose(),
      onError: (error) => callbacks.onError?.(error)
    })
    return { ok: true, subscription: { unsubscribe: handle.unsubscribe } }
  } catch (error) {
    return failure(error, 'STREAM_FAILED')
  }
}
