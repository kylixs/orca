import type { CloudSessionState } from '../../../shared/cloud-platform-ipc'
import type { WebCloudAuthTokens } from '../web/web-cloud-auth'
import {
  loadOrCreateWebCloudDeviceKey,
  type WebCloudDeviceIdentity,
  type WebCloudDeviceKeyStorage
} from '../web/web-cloud-device-key'
import { listCloudProjects, type WebCloudSession } from '../web/web-cloud-session'
import { restoreWebCloudSession } from '../web/web-cloud-session-restore'
import {
  deletePersistedWebCloudSession,
  readPersistedWebCloudSession,
  writePersistedWebCloudSession,
  type WebCloudSessionStorage
} from '../web/web-cloud-session-storage'
import { isSessionExpired, summarize } from './cloud-browser-bridge-replies'

/**
 * The admin page's saved login. A reload restores it from storage with the device
 * identity that key store already persisted; a dead platform session clears it,
 * while a network failure keeps it so the next load can try again.
 */

export type BrowserSavedSession = {
  store: WebCloudSessionStorage
  apiUrl: string
  deviceKeyStore: WebCloudDeviceKeyStorage
  fetchImpl?: typeof fetch
  now?: () => number
  getSession: () => WebCloudSession | null
  setSession: (session: WebCloudSession | null) => void
  setIdentity: (identity: WebCloudDeviceIdentity | null) => void
  setState: (state: CloudSessionState) => void
}

export function persistBrowserSession(
  saved: BrowserSavedSession,
  tokens: WebCloudAuthTokens
): void {
  const active = saved.getSession()
  if (!active) {
    return
  }
  const written = writePersistedWebCloudSession(saved.store, {
    version: 1,
    apiUrl: active.apiUrl,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    deviceId: active.deviceId,
    displayName: active.user.displayName,
    savedAtMs: Date.now()
  })
  if (!written) {
    // Why warn only: the request that triggered rotation already succeeded.
    console.warn('[cloud] failed to persist the browser session')
  }
}

export function clearBrowserSession(saved: BrowserSavedSession): void {
  deletePersistedWebCloudSession(saved.store)
}

export async function restoreBrowserSession(saved: BrowserSavedSession): Promise<void> {
  const persisted = readPersistedWebCloudSession(saved.store, saved.apiUrl)
  if (!persisted) {
    return
  }
  const identity = loadOrCreateWebCloudDeviceKey(saved.deviceKeyStore)
  const restored = restoreWebCloudSession({
    persisted,
    onTokensChanged: (tokens) => persistBrowserSession(saved, tokens),
    ...(saved.fetchImpl ? { fetchImpl: saved.fetchImpl } : {}),
    ...(saved.now ? { now: saved.now } : {})
  })
  saved.setSession(restored)
  saved.setIdentity(identity)
  try {
    const projects = await listCloudProjects(
      restored,
      saved.fetchImpl ? { fetchImpl: saved.fetchImpl } : {}
    )
    saved.setState({
      status: 'signed-in',
      displayName: persisted.displayName,
      projects: projects.map(summarize)
    })
  } catch (error) {
    saved.setSession(null)
    saved.setIdentity(null)
    if (isSessionExpired(error)) {
      clearBrowserSession(saved)
    } else {
      // Why keep it: a transient network failure retries on the next page load.
      console.warn('[cloud] session restore failed; keeping the saved login')
    }
  }
}
