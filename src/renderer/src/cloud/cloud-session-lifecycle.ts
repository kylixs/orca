import { useEffect, useRef, type RefObject } from 'react'
import { readField } from '../../../shared/json-fields'
import type {
  CloudConnectionEvent,
  CloudLoginContext,
  CloudSessionState
} from '../../../shared/cloud-platform-ipc'
import type { CloudBridge } from './use-cloud-session'

type LifecycleInput = {
  bridgeRef: RefObject<CloudBridge | null | undefined>
  applyState: (state: CloudSessionState) => void
  onLoginContext: (context: CloudLoginContext) => void
  onUnavailable: () => void
  onSignedOut: () => void
  onConnectionClosed: (event: CloudConnectionEvent) => void
}

function isCloudState(value: unknown): value is CloudSessionState {
  const status = readField(value, 'status')
  return status === 'signed-out' || status === 'signed-in'
}

/**
 * Boot/restore and connection events for the session hook. Kept out of the hook
 * body so its render logic stays readable; callbacks are read through a ref so
 * the subscription is installed once.
 */
export function useCloudSessionLifecycle(input: LifecycleInput): void {
  const latest = useRef(input)
  latest.current = input

  useEffect(() => {
    const active = latest.current.bridgeRef.current
    if (!active) {
      // Not a cloud build: the UI must say so rather than showing a dead form.
      latest.current.onUnavailable()
      return
    }
    let cancelled = false
    // Why fire-and-forget: the prefill must never delay the session restore; a
    // failure just means the user types the address themselves.
    active
      .getLoginContext()
      .then((context) => {
        if (!cancelled && context) {
          latest.current.onLoginContext(context)
        }
      })
      .catch(() => undefined)
    const restore = (): void => {
      void active
        .getState()
        .then((state) => {
          if (!cancelled && isCloudState(state)) {
            latest.current.applyState(state)
          }
        })
        .catch(() => {
          if (!cancelled) {
            latest.current.onSignedOut()
          }
        })
    }
    restore()
    const unsubscribe = active.onConnectionChanged((event) => {
      if (event.closeCode !== null) {
        latest.current.onConnectionClosed(event)
      }
      if (event.reason === 'session_expired') {
        // Why re-read: main already signed out; trusting cached state would strand
        // the user on a workbench whose every action now fails.
        restore()
      }
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])
}
