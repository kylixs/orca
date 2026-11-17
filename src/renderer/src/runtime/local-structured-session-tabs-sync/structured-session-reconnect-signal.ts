/**
 * One-shot fan-out for structured-session stream reconnects. Listeners are scoped to a
 * subscription; emitting with none attached is a no-op so the sync lane stays standalone.
 */
type ReconnectListener = () => void

const listeners = new Set<ReconnectListener>()

export function subscribeStructuredSessionReconnect(listener: ReconnectListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function emitStructuredSessionReconnect(): void {
  for (const listener of listeners) {
    listener()
  }
}

export function resetStructuredSessionReconnectSignalForTests(): void {
  listeners.clear()
}
