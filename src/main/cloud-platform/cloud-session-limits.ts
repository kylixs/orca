/**
 * Per-host concurrency caps for cloud sessions (design §8.4): at most 3 live
 * sessions per user per project, and 32 per host. The platform is not in the
 * data path, so it cannot see these connections — the host is the only place the
 * limit can actually be enforced.
 *
 * A session is a client working on a project, not one transport socket. Every
 * ticket a client mints carries its `deviceId`, and one entry chain holds
 * several sockets at once — the project socket, one per stream (terminal, file
 * watch), plus a short socket per RPC — so sockets are grouped by that device:
 * a device is one session against the per-user-project cap, and its fan-out is
 * bounded separately so a single client still cannot open sockets without end.
 */

export type CloudSessionIdentity = {
  /** Ticket `sub`: the user the cap is expressed against. */
  user: string
  project: string
  /** The E2EE device token; unique per ticket, so it identifies the socket. */
  token: string
  /** Ticket `deviceId`: shared by every ticket one client session mints. */
  device: string
}

export type CloudSessionLimits = {
  /** Reserves a slot; false means the caller must refuse the socket. */
  tryOpen: (session: CloudSessionIdentity) => boolean
  /** Idempotent: close paths can run twice. */
  release: (token: string) => void
  activeCount: () => number
  /** Live sockets for the user and project (the transport view, not sessions). */
  activeFor: (user: string, project: string) => number
  /** Distinct devices with a live socket: the §8.4 session count. */
  activeSessionCountFor: (user: string, project: string) => number
}

export const MAX_SESSIONS_PER_USER_PROJECT = 3
export const MAX_SESSIONS_PER_HOST = 32
/** One session's transport fan-out; a desktop entry burst peaks far below this. */
export const MAX_SOCKETS_PER_DEVICE_SESSION = 12

export function createCloudSessionLimits(
  options: {
    perUserProject?: number
    perHost?: number
    perDeviceSockets?: number
  } = {}
): CloudSessionLimits {
  const perUserProject = options.perUserProject ?? MAX_SESSIONS_PER_USER_PROJECT
  const perHost = options.perHost ?? MAX_SESSIONS_PER_HOST
  const perDeviceSockets = options.perDeviceSockets ?? MAX_SOCKETS_PER_DEVICE_SESSION
  const sessions = new Map<string, { user: string; project: string; device: string }>()

  const countFor = (user: string, project: string): number => {
    let count = 0
    for (const session of sessions.values()) {
      if (session.user === user && session.project === project) {
        count += 1
      }
    }
    return count
  }

  const countForDevice = (user: string, project: string, device: string): number => {
    let count = 0
    for (const session of sessions.values()) {
      if (session.user === user && session.project === project && session.device === device) {
        count += 1
      }
    }
    return count
  }

  const activeSessionCountFor = (user: string, project: string): number => {
    const devices = new Set<string>()
    for (const session of sessions.values()) {
      if (session.user === user && session.project === project) {
        devices.add(session.device)
      }
    }
    return devices.size
  }

  return {
    tryOpen: (session) => {
      // A re-open of the same token replaces its slot instead of consuming a
      // second one, so a duplicate connection event cannot exhaust the cap.
      if (!sessions.has(session.token)) {
        const deviceSockets = countForDevice(session.user, session.project, session.device)
        if (sessions.size >= perHost) {
          return false
        }
        // A device seen for the first time consumes a session slot; its later
        // sockets ride inside that session.
        if (
          deviceSockets === 0 &&
          activeSessionCountFor(session.user, session.project) >= perUserProject
        ) {
          return false
        }
        if (deviceSockets >= perDeviceSockets) {
          return false
        }
      }
      sessions.set(session.token, {
        user: session.user,
        project: session.project,
        device: session.device
      })
      return true
    },
    release: (token) => {
      sessions.delete(token)
    },
    activeCount: () => sessions.size,
    activeFor: (user, project) => countFor(user, project),
    activeSessionCountFor
  }
}
