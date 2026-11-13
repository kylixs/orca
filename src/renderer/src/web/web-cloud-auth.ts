import { readNumber, readString } from '../../../shared/json-fields'
import { webCloudSessionExpiredError } from './web-cloud-error'

/**
 * Browser-side token renewal. One login owns one instance, so concurrent
 * requests share a single refresh; tokens stay in memory and are never persisted.
 */

export type WebCloudAuthFingerprints = {
  access: string
  refresh: string | null
}

export type WebCloudAuthTokens = {
  accessToken: string
  refreshToken: string
}

export type WebCloudAuth = {
  readonly accessToken: string
  readonly refreshToken: string | null
  /** Absolute ms expiry; null when the platform predates `expiresIn`. */
  readonly accessTokenExpiresAt: number | null
  /** Refreshes only inside the lead window; a 401 caller forces it instead. */
  ensureFresh: () => Promise<void>
  /** Single-flight; rejects `SESSION_EXPIRED` once the refresh token is dead. */
  refresh: (force?: boolean) => Promise<void>
  /** Non-reversible digests for diagnostics and tests; never the tokens. */
  fingerprints: () => WebCloudAuthFingerprints
}

export type WebCloudAuthInit = {
  apiUrl: string
  accessToken: string
  refreshToken: string | null
  /** Access-token lifetime in seconds, as the login/refresh response states it. */
  expiresIn?: number | null
  fetchImpl?: typeof fetch
  now?: () => number
  /** Refresh this long before expiry; tests with short TTLs shrink it. */
  refreshLeadMs?: number
  /** Notifies the session store after rotation so a reload keeps the newest token. */
  onTokensChanged?: (tokens: WebCloudAuthTokens) => void
}

const DEFAULT_REFRESH_LEAD_MS = 60_000

/** FNV-1a: token-shaped strings still need a digest, and browsers have no crypto import. */
function fingerprint(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export function createWebCloudAuth(init: WebCloudAuthInit): WebCloudAuth {
  const fetchImpl = init.fetchImpl ?? globalThis.fetch
  const now = init.now ?? (() => Date.now())
  const baseUrl = init.apiUrl.replace(/\/+$/, '')
  const leadMs = init.refreshLeadMs ?? DEFAULT_REFRESH_LEAD_MS
  let accessToken = init.accessToken
  let refreshToken = init.refreshToken
  let expiresAt =
    typeof init.expiresIn === 'number' ? now() + Math.max(0, init.expiresIn) * 1000 : null
  // Why: a dead refresh token must not be sent to the platform on every request.
  let expired = false
  let pending: Promise<void> | null = null

  const needsRefresh = (): boolean => expiresAt !== null && expiresAt - now() <= leadMs

  async function performRefresh(): Promise<void> {
    if (expired || refreshToken === null) {
      throw webCloudSessionExpiredError()
    }
    let nextAccess: string | null = null
    let nextRefresh: string | null = null
    let nextExpiresIn: number | null = null
    try {
      const response = await fetchImpl(`${baseUrl}/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken })
      })
      const body: unknown = await response.json().catch(() => null)
      if (response.ok) {
        nextAccess = readString(body, 'accessToken')
        nextRefresh = readString(body, 'refreshToken')
        nextExpiresIn = readNumber(body, 'expiresIn')
      }
    } catch {
      nextAccess = null
    }
    if (nextAccess === null) {
      expired = true
      throw webCloudSessionExpiredError()
    }
    accessToken = nextAccess
    // A pre-rotation platform may omit the new token; keeping ours stays usable.
    refreshToken = nextRefresh ?? refreshToken
    expiresAt = nextExpiresIn === null ? null : now() + Math.max(0, nextExpiresIn) * 1000
    // Why: a failure to persist must not fail a request that just succeeded.
    try {
      init.onTokensChanged?.({ accessToken, refreshToken })
    } catch {
      // Best-effort persistence only.
    }
  }

  function refresh(force = false): Promise<void> {
    // Why first: once the refresh token is dead, even a "not yet due" call must fail.
    if (expired) {
      return Promise.reject(webCloudSessionExpiredError())
    }
    if (!force && !needsRefresh()) {
      return Promise.resolve()
    }
    if (pending === null) {
      pending = performRefresh().finally(() => {
        pending = null
      })
    }
    return pending
  }

  return {
    get accessToken() {
      return accessToken
    },
    get refreshToken() {
      return refreshToken
    },
    get accessTokenExpiresAt() {
      return expiresAt
    },
    ensureFresh: () => refresh(false),
    refresh,
    fingerprints: () => ({
      access: fingerprint(accessToken),
      refresh: refreshToken === null ? null : fingerprint(refreshToken)
    })
  }
}
