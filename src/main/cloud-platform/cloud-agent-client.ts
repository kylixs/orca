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
}

export type CloudAgentSnapshot = {
  kids: string[]
  revocations: Required<CloudRevocations>
  lastRefreshAt: number | null
  lastError: string | null
}

export type CloudAgentClient = {
  /** Upgrade-time gate backed by the current snapshot. */
  admit: (headers: CloudUpgradeHeaders) => CloudUpgradeDecision
  refresh: () => Promise<void>
  snapshot: () => CloudAgentSnapshot
  /** Called after each successful refresh so the runtime can act on new revocations. */
  onRefresh: (listener: (snapshot: CloudAgentSnapshot) => void) => () => void
  start: () => void
  stop: () => void
}

const DEFAULT_REFRESH_MS = 10_000
const DEFAULT_TIMEOUT_MS = 3_000

function emptyRevocations(): Required<CloudRevocations> {
  return { projects: [], users: [], devices: [], jtis: [] }
}

/** Structural check: a version-skewed platform must not poison the revocation set. */
function parseRevocations(value: unknown): Required<CloudRevocations> {
  const result = emptyRevocations()
  if (!value || typeof value !== 'object') {
    return result
  }
  const candidate = value as Record<string, unknown>
  const list = (key: 'projects' | 'users' | 'devices'): { id: string; since: number }[] =>
    Array.isArray(candidate[key])
      ? (candidate[key] as unknown[]).flatMap((item) => {
          if (!item || typeof item !== 'object') {
            return []
          }
          const entry = item as Record<string, unknown>
          return typeof entry.id === 'string' && typeof entry.since === 'number'
            ? [{ id: entry.id, since: entry.since }]
            : []
        })
      : []
  result.projects = list('projects')
  result.users = list('users')
  result.devices = list('devices')
  result.jtis = Array.isArray(candidate.jtis)
    ? (candidate.jtis as unknown[]).filter((jti): jti is string => typeof jti === 'string')
    : []
  return result
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
  let timer: ReturnType<typeof setInterval> | null = null
  let inFlight: Promise<void> | null = null
  const listeners = new Set<(snapshot: CloudAgentSnapshot) => void>()

  const snapshot = (): CloudAgentSnapshot => ({
    kids: [...keys.keys()],
    revocations,
    lastRefreshAt,
    lastError
  })

  async function refreshOnce(): Promise<void> {
    const signal = AbortSignal.timeout(timeoutMs)
    const headers = { 'x-internal-token': config.internalToken }
    const [jwksRes, revokedRes] = await Promise.all([
      fetchImpl(`${config.apiUrl}/v1/jwks`, { signal }),
      fetchImpl(`${internalUrl}/v1/internal/revocations`, { signal, headers })
    ])
    if (!jwksRes.ok) {
      throw new Error(`jwks fetch failed: ${jwksRes.status}`)
    }
    const parsedKeys = parseKeys(await jwksRes.json())
    // Keep the last good keys rather than admitting nothing on a partial body.
    if (parsedKeys.length > 0) {
      keys = new Map(parsedKeys.map((entry) => [entry.kid, entry.publicKeyPem]))
    }
    if (revokedRes.ok) {
      revocations = parseRevocations(await revokedRes.json())
    }
    lastRefreshAt = Date.now()
    lastError = null
    const current = snapshot()
    for (const listener of listeners) {
      listener(current)
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
    admit: (headers) =>
      createCloudUpgradeAdmission({
        hostId: config.hostId,
        hostName: config.hostName,
        keys,
        revocations
      })(headers),
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
    }
  }
}
