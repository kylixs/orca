/**
 * The API replica's half of the shared login-lockout counter (AC-02).
 *
 * Counting five failures per process lets an attacker spread attempts across
 * replicas and never lock the account, so the count lives in one shared service.
 * A service that cannot be reached must not open the account: the caller treats a
 * failure here as "still locked down" and answers 503 rather than guessing.
 */

export type LockoutState = { locked: boolean; remaining: number; lockedUntil: number }

export type LoginLockout = {
  isLocked: (username: string) => Promise<LockoutState>
  recordFailure: (username: string) => Promise<LockoutState>
  clear: (username: string) => Promise<void>
}

const UNREACHABLE: LockoutState = { locked: false, remaining: -1, lockedUntil: 0 }

export function createRemoteLoginLockout(options: {
  url: string
  internalToken: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}): LoginLockout {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 2_000

  const call = async (path: string, init: RequestInit = {}): Promise<LockoutState> => {
    const res = await fetchImpl(`${options.url}${path}`, {
      ...init,
      headers: { ...init.headers, 'x-internal-token': options.internalToken },
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!res.ok) {
      throw Object.assign(new Error(`login lockout answered ${res.status}`), {
        code: 'LOCKOUT_UNAVAILABLE'
      })
    }
    return (await res.json()) as LockoutState
  }

  const post = (path: string, username: string): Promise<LockoutState> =>
    call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username })
    })

  return {
    isLocked: async (username) => {
      try {
        return await call(`/v1/state?username=${encodeURIComponent(username)}`)
      } catch {
        return UNREACHABLE
      }
    },
    recordFailure: (username) => post('/v1/failure', username),
    clear: async (username) => {
      await post('/v1/clear', username)
    }
  }
}

/** `remaining < 0` marks "the counter could not be reached", which callers must not read as success. */
export function lockoutUnavailable(state: LockoutState): boolean {
  return state.remaining < 0
}
