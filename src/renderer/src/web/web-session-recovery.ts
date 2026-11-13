import { useEffect, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import {
  closeActiveRuntimeClients,
  subscribeCloudSessionEnded
} from './preload-api/web-runtime-session'
import { clearStoredWebRuntimeEnvironment } from './web-runtime-environment'

export type WebSessionRecoveryState =
  | { status: 'active' }
  | { status: 'signed-out'; notice: string }

const ACTIVE: WebSessionRecoveryState = { status: 'active' }

export function cloudSessionEndedNotice(): string {
  return translate(
    'auto.web.WebConnect.cloudSessionEndedLive',
    'Your cloud session ended. Sign in again to reconnect.'
  )
}

/** Drops the spent cloud pairing and its dead socket before the sign-in screen renders. */
export function signOutWebSession(): WebSessionRecoveryState {
  clearStoredWebRuntimeEnvironment()
  closeActiveRuntimeClients()
  return { status: 'signed-out', notice: cloudSessionEndedNotice() }
}

export function useWebSessionRecovery(onSignedOut: () => void): WebSessionRecoveryState {
  const [state, setState] = useState<WebSessionRecoveryState>(ACTIVE)
  const onSignedOutRef = useRef(onSignedOut)
  onSignedOutRef.current = onSignedOut
  useEffect(() => {
    // Why page-lifetime: the cloud client is adopted before the App mounts, so the
    // listener must already exist when a dead ticket is later detected.
    return subscribeCloudSessionEnded(() => {
      setState(signOutWebSession())
      onSignedOutRef.current()
    })
  }, [])
  return state
}
