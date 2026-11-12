/**
 * Per-host concurrency caps for cloud sessions (design §8.4): at most 3 live
 * connections per user per project, and 32 per host. The platform is not in the
 * data path, so it cannot see these connections — the host is the only place the
 * limit can actually be enforced.
 *
 * A ticket is single-use but a session outlives it, so this counts live sockets
 * rather than tickets: a slot is taken when a socket opens and released when it
 * closes, which also covers peers that drop mid-handshake.
 */

export type CloudSessionIdentity = {
  /** Ticket `sub`: the user the cap is expressed against. */
  user: string
  project: string
  /** The E2EE device token; unique per ticket, so it identifies the socket. */
  token: string
}

export type CloudSessionLimits = {
  /** Reserves a slot; false means the caller must refuse the socket. */
  tryOpen: (session: CloudSessionIdentity) => boolean
  /** Idempotent: close paths can run twice. */
  release: (token: string) => void
  activeCount: () => number
  activeFor: (user: string, project: string) => number
}

export const MAX_SESSIONS_PER_USER_PROJECT = 3
export const MAX_SESSIONS_PER_HOST = 32

export function createCloudSessionLimits(
  options: { perUserProject?: number; perHost?: number } = {}
): CloudSessionLimits {
  const perUserProject = options.perUserProject ?? MAX_SESSIONS_PER_USER_PROJECT
  const perHost = options.perHost ?? MAX_SESSIONS_PER_HOST
  const sessions = new Map<string, { user: string; project: string }>()

  const countFor = (user: string, project: string): number => {
    let count = 0
    for (const session of sessions.values()) {
      if (session.user === user && session.project === project) {
        count += 1
      }
    }
    return count
  }

  return {
    tryOpen: (session) => {
      // A re-open of the same token replaces its slot instead of consuming a
      // second one, so a duplicate connection event cannot exhaust the cap.
      if (!sessions.has(session.token)) {
        if (sessions.size >= perHost) {
          return false
        }
        if (countFor(session.user, session.project) >= perUserProject) {
          return false
        }
      }
      sessions.set(session.token, { user: session.user, project: session.project })
      return true
    },
    release: (token) => {
      sessions.delete(token)
    },
    activeCount: () => sessions.size,
    activeFor: (user, project) => countFor(user, project)
  }
}
