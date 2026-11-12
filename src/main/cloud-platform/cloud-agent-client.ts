import { sendHeartbeat } from './cloud-host-enrollment'
import {
  createCloudUpgradeAdmission,
  type CloudRevocations,
  type CloudUpgradeDecision,
  type CloudUpgradeHeaders
} from './cloud-upgrade-admission'

/**
 * Host-side client for the cloud platform's control plane.
 *
 * The platform is a registry + auth service, not part of the data path (design
 * §3.3 D1). The host therefore keeps its own view of the signing keys and the
 * revocation sets, refreshed on a timer, and admits upgrades from that view.
 */

export type CloudAgentConfig = {
  /** Public API base, used for /v1/jwks. */
  apiUrl: string
  /** Control-plane base; https here means the requests go over mTLS. */
  internalUrl?: string
  /** Bearer token for /v1/internal/*. */
  internalToken: string
  hostId: string
  hostName: string
  /** Poll cadence for keys + revocations. */
  refreshMs?: number
  /** Per-request timeout; a hung platform must not stall the loop. */
  timeoutMs?: number
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
  /**
   * Enrolled-host mode: revocations and policy come from the heartbeat response
   * instead of `/v1/internal/*`. This is the normal path for a registered host;
   * the internal routes exist for hosts that never enrolled.
   */
  heartbeat?: {
    hostId: string
    credential: string
    /** Reported on every beat so the platform sees address changes. */
    directAddrs?: string[]
  }
}

export type CloudAgentSnapshot = {
  kids: string[]
  revocations: Required<CloudRevocations>
  lastRefreshAt: number | null
  lastError: string | null
  /** Set while the platform reports the host in maintenance. */
  maintenance: { reason: string } | null
}

export type CloudAgentClient = {
  /** Upgrade-time gate backed by the current snapshot. */
  admit: (headers: CloudUpgradeHeaders) => CloudUpgradeDecision
  refresh: () => Promise<void>
  snapshot: () => CloudAgentSnapshot
  /** Called after each successful refresh so the runtime can act on new revocations. */
  onRefresh: (listener: (snapshot: CloudAgentSnapshot) => void) => () => void
  /** Emits E2EE device tokens whose live sessions must be closed. */
  onRevoke: (listener: (deviceTokens: string[]) => void) => () => void
  /** Tickets currently held open (test/diagnostic visibility). */
  admittedCount: () => number
  start: () => void
  stop: () => void
}

const DEFAULT_REFRESH_MS = 10_000
const DEFAULT_TIMEOUT_MS = 3_000

function emptyRevocations(): Required<CloudRevocations> {
  return { projects: [], users: [], devices: [], jtis: [] }
}

/**
 * Returns null for a structurally invalid body so the caller keeps the previous
 * snapshot. Reading `{}` as "nothing is revoked" would re-admit a revoked ticket
 * (review-07 F2).
 */
function parseRevocations(value: unknown): Required<CloudRevocations> | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const candidate = value as Record<string, unknown>
  const list = (key: 'projects' | 'users' | 'devices'): { id: string; since: number }[] | null => {
    const raw = candidate[key]
    if (!Array.isArray(raw)) {
      return null
    }
    const parsed: { id: string; since: number }[] = []
    for (const item of raw) {
      if (!item || typeof item !== 'object') {
        return null
      }
      const entry = item as Record<string, unknown>
      if (typeof entry.id !== 'string' || typeof entry.since !== 'number') {
        return null
      }
      parsed.push({ id: entry.id, since: entry.since })
    }
    return parsed
  }
  const projects = list('projects')
  const users = list('users')
  const devices = list('devices')
  const rawJtis = candidate.jtis
  if (!projects || !users || !devices || !Array.isArray(rawJtis)) {
    return null
  }
  if (!rawJtis.every((jti): jti is string => typeof jti === 'string')) {
    return null
  }
  return { projects, users, devices, jtis: rawJtis }
}

function parseKeys(value: unknown): { kid: string; publicKeyPem: string }[] {
  if (!value || typeof value !== 'object') {
    return []
  }
  const keys = (value as { keys?: unknown }).keys
  if (!Array.isArray(keys)) {
    return []
  }
  return keys.flatMap((item) => {
    if (!item || typeof item !== 'object') {
      return []
    }
    const entry = item as Record<string, unknown>
    return typeof entry.kid === 'string' && typeof entry.publicKeyPem === 'string'
      ? [{ kid: entry.kid, publicKeyPem: entry.publicKeyPem }]
      : []
  })
}

/**
 * Cloud mode is opt-in via env. Half-configured is an operator error: starting a
 * host that silently skips the admission check would be worse than not starting.
 */
export function cloudAgentConfigFromEnv(env: NodeJS.ProcessEnv): CloudAgentConfig | null {
  const apiUrl = env.ORCA_CLOUD_API_URL
  if (!apiUrl) {
    return null
  }
  const internalToken = env.ORCA_CLOUD_INTERNAL_TOKEN
  const hostId = env.ORCA_CLOUD_HOST_ID
  const hostName = env.ORCA_CLOUD_HOST_NAME
  const missing = [
    ['ORCA_CLOUD_INTERNAL_TOKEN', internalToken],
    ['ORCA_CLOUD_HOST_ID', hostId],
    ['ORCA_CLOUD_HOST_NAME', hostName]
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name)
  if (missing.length > 0) {
    throw new Error(`Cloud mode is incomplete: missing ${missing.join(', ')}`)
  }
  return {
    apiUrl,
    internalUrl: env.ORCA_CLOUD_INTERNAL_URL,
    internalToken: internalToken!,
    hostId: hostId!,
    hostName: hostName!
  }
}

export function createCloudAgentClient(config: CloudAgentConfig): CloudAgentClient {
  const fetchImpl = config.fetchImpl ?? fetch
  const refreshMs = config.refreshMs ?? DEFAULT_REFRESH_MS
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const internalUrl = config.internalUrl ?? config.apiUrl

  let keys = new Map<string, string>()
  let revocations = emptyRevocations()
  let lastRefreshAt: number | null = null
  let lastError: string | null = null
  let lastMaintenance: { reason: string } | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let inFlight: Promise<void> | null = null
  const listeners = new Set<(snapshot: CloudAgentSnapshot) => void>()
  const revokeListeners = new Set<(deviceTokens: string[]) => void>()
  // Why: revocation arrives as platform device/user/project ids, but the socket is
  // keyed by the E2EE device token from the ticket — keep the mapping from admission.
  const admitted = new Map<
    string,
    { deviceToken: string; deviceId: string; sub: string; project: string; iatMs: number }
  >()

  const snapshot = (): CloudAgentSnapshot => ({
    kids: [...keys.keys()],
    revocations,
    lastRefreshAt,
    lastError,
    maintenance: lastMaintenance
  })

  async function refreshOnce(): Promise<void> {
    // Per-request signals: a shared one would abort the healthy response when the
    // other endpoint hangs (review-07 F1).
    const headers = { 'x-internal-token': config.internalToken }
    // Independent outcomes: a broken JWKS endpoint must not stop revocation from
    // being applied, or an unreachable key endpoint would keep a revoked device
    // online (review-07 F1).
    const [jwksRes, revokedRes] = await Promise.allSettled([
      fetchImpl(`${config.apiUrl}/v1/jwks`, { signal: AbortSignal.timeout(timeoutMs) }),
      config.heartbeat
        ? Promise.resolve(null)
        : fetchImpl(`${internalUrl}/v1/internal/revocations`, {
            signal: AbortSignal.timeout(timeoutMs),
            headers
          })
    ]).then((results) =>
      results.map((result) => (result.status === 'fulfilled' ? result.value : null))
    )
    if (jwksRes === null) {
      lastError = 'jwks fetch failed'
    } else if (!jwksRes.ok) {
      // Record, never throw: a bad key endpoint must not skip the revocation pass.
      lastError = `jwks fetch failed: ${jwksRes.status}`
    } else {
      const parsedKeys = parseKeys(await jwksRes.json())
      // Keep the last good keys rather than admitting nothing on a partial body.
      if (parsedKeys.length > 0) {
        keys = new Map(parsedKeys.map((entry) => [entry.kid, entry.publicKeyPem]))
      }
    }
    if (config.heartbeat) {
      // Heartbeat is the enrolled host's revocation channel (design §4.1). It is
      // preferred over the internal routes, which a registered host may not reach.
      const beat = await sendHeartbeat(
        config.apiUrl,
        config.heartbeat.credential,
        config.heartbeat.hostId,
        {
          status: 'online',
          ...(config.heartbeat.directAddrs ? { directAddrs: config.heartbeat.directAddrs } : {})
        },
        fetchImpl,
        timeoutMs
      )
      if (beat) {
        const parsed = parseRevocations(beat.revoked)
        if (parsed) {
          revocations = parsed
        }
        lastMaintenance = beat.maintenance
      } else {
        lastError = 'heartbeat failed'
      }
    } else if (revokedRes?.ok) {
      const parsed = parseRevocations(await revokedRes.json())
      if (parsed) {
        revocations = parsed
      }
    }
    lastRefreshAt = Date.now()
    const current = snapshot()
    for (const listener of listeners) {
      listener(current)
    }
    emitRevokedSessions()
  }

  /**
   * Tickets admitted before the revocation `since` are dead; their live sockets
   * must be closed too, otherwise a revoked device keeps its session forever.
   */
  function emitRevokedSessions(): void {
    const revokedTokens: string[] = []
    for (const [jti, ticket] of admitted) {
      const deviceSince = revocations.devices.find((entry) => entry.id === ticket.deviceId)?.since
      const userSince = revocations.users.find(
        (entry) => entry.id === ticket.sub.replace(/^user:/, '')
      )?.since
      const projectSince = revocations.projects.find((entry) => entry.id === ticket.project)?.since
      const dead =
        (deviceSince !== undefined && ticket.iatMs <= deviceSince) ||
        (userSince !== undefined && ticket.iatMs <= userSince) ||
        (projectSince !== undefined && ticket.iatMs <= projectSince) ||
        revocations.jtis.includes(jti)
      if (!dead) {
        continue
      }
      admitted.delete(jti)
      revokedTokens.push(ticket.deviceToken)
    }
    if (revokedTokens.length === 0) {
      return
    }
    for (const listener of revokeListeners) {
      listener(revokedTokens)
    }
  }

  /** Single-flight: a hung platform must not stack one request per tick. */
  function refresh(): Promise<void> {
    if (inFlight) {
      return inFlight
    }
    inFlight = refreshOnce()
      .catch((error: unknown) => {
        lastError = error instanceof Error ? error.message : String(error)
      })
      .finally(() => {
        inFlight = null
      })
    return inFlight
  }

  return {
    admit: (headers) => {
      const decision = createCloudUpgradeAdmission({
        hostId: config.hostId,
        hostName: config.hostName,
        keys,
        revocations
      })(headers)
      if (decision.ok) {
        const { jti, deviceToken, deviceId, sub, project, iat } = decision.payload
        admitted.set(jti, { deviceToken, deviceId, sub, project, iatMs: iat * 1000 })
      }
      return decision
    },
    onRevoke: (listener) => {
      revokeListeners.add(listener)
      return () => revokeListeners.delete(listener)
    },
    admittedCount: () => admitted.size,
    refresh,
    snapshot,
    onRefresh: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    start: () => {
      if (timer) {
        return
      }
      void refresh()
      timer = setInterval(() => {
        void refresh()
      }, refreshMs)
      // Why: the host must not stay alive only to poll a control plane.
      timer.unref?.()
    },
    stop: () => {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      listeners.clear()
      revokeListeners.clear()
    }
  }
}
