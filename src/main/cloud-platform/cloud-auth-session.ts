import { createHash } from 'node:crypto'
import { readNumber, readString } from '../../shared/json-fields'

/**
 * One platform login's bearer credentials. Every forked project client shares
 * this object, so a refresh mints one token set for all of them.
 */

export type CloudAuthFingerprints = {
  access: string
  refresh: string | null
}

export type CloudAuthSession = {
  readonly accessToken: string
  readonly refreshToken: string | null
  /** Absolute ms expiry; null when the platform predates `expiresIn`. */
  readonly accessTokenExpiresAt: number | null
  /** Refreshes only when inside the lead window (or a 401 forced it). */
  ensureFresh: () => Promise<void>
  /** Single-flight; rejects `SESSION_EXPIRED` once the refresh token is dead. */
  refresh: (force?: boolean) => Promise<void>
  /** Non-reversible digests for diagnostics and tests; never the tokens. */
  fingerprints: () => CloudAuthFingerprints
}

export type CloudAuthSessionInit = {
  apiUrl: string
  accessToken: string
  refreshToken: string | null
  /** Access-token lifetime in seconds, as the login/refresh response states it. */
  expiresIn?: number | null
  fetchImpl?: typeof fetch
  now?: () => number
  /** Refresh this long before expiry; tests with short TTLs shrink it. */
  refreshLeadMs?: number
}

const DEFAULT_REFRESH_LEAD_MS = 60_000

export function cloudSessionExpiredError(): Error & { code: 'SESSION_EXPIRED' } {
  return Object.assign(new Error('session expired'), { code: 'SESSION_EXPIRED' as const })
}

function fingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16)
}

export function createCloudAuthSession(init: CloudAuthSessionInit): CloudAuthSession {
  const fetchImpl = init.fetchImpl ?? fetch
  const now = init.now ?? (() => Date.now())
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
      throw cloudSessionExpiredError()
    }
    try {
      const res = await fetchImpl(`${init.apiUrl}/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken })
      })
      const body: unknown = await res.json().catch(() => null)
      const nextAccess = res.ok ? readString(body, 'accessToken') : null
      if (nextAccess === null) {
        throw cloudSessionExpiredError()
      }
      accessToken = nextAccess
      // A pre-rotation platform may omit the new token; keeping ours stays usable.
      refreshToken = readString(body, 'refreshToken') ?? refreshToken
      const expiresIn = readNumber(body, 'expiresIn')
      expiresAt = expiresIn === null ? null : now() + Math.max(0, expiresIn) * 1000
    } catch {
      expired = true
      throw cloudSessionExpiredError()
    }
  }

  function refresh(force = false): Promise<void> {
    // Why first: once the refresh token is dead, even a "not yet due" call must fail.
    if (expired) {
      return Promise.reject(cloudSessionExpiredError())
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
