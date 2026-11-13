import type { WebCloudAuthTokens } from './web-cloud-auth'
import { createWebCloudAuth } from './web-cloud-auth'
import type { WebCloudSession } from './web-cloud-session'
import type { PersistedWebCloudSession } from './web-cloud-session-storage'

/**
 * Rebuilds an in-memory session from the saved login. The device identity is not
 * part of this record: the caller supplies the one already persisted by
 * `web-cloud-device-key`, which is the key the platform and host know.
 */

export type RestoreWebCloudSessionOptions = {
  persisted: PersistedWebCloudSession
  fetchImpl?: typeof fetch
  now?: () => number
  refreshLeadMs?: number
  /** Rotation hook: the bridge writes the newest tokens back to storage. */
  onTokensChanged?: (tokens: WebCloudAuthTokens) => void
}

export function restoreWebCloudSession(options: RestoreWebCloudSessionOptions): WebCloudSession {
  const { persisted } = options
  const auth = createWebCloudAuth({
    apiUrl: persisted.apiUrl,
    accessToken: persisted.accessToken,
    refreshToken: persisted.refreshToken,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.refreshLeadMs === undefined ? {} : { refreshLeadMs: options.refreshLeadMs }),
    ...(options.onTokensChanged ? { onTokensChanged: options.onTokensChanged } : {})
  })
  return {
    apiUrl: persisted.apiUrl,
    accessToken: persisted.accessToken,
    refreshToken: persisted.refreshToken,
    // Only the display name reaches bridge state; the saved shape carries no profile.
    user: {
      id: '',
      username: '',
      displayName: persisted.displayName,
      dept: null,
      roles: [],
      permissions: []
    },
    deviceId: persisted.deviceId,
    obtainedAtMs: persisted.savedAtMs,
    auth
  }
}
