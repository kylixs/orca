import { sendHeartbeat } from './cloud-host-enrollment'
import { emptyRevocations, parseRevocations } from './cloud-agent-revocations'
import { readArray, readString } from '../../shared/json-fields'
import {
  createCloudUpgradeAdmission,
  readCloudCredentialFromHeaders,
  rejectCloudUpgrade,
  type CloudRevocations,
  type CloudUpgradeDecision,
  type CloudUpgradeHeaders
} from './cloud-upgrade-admission'
import { createCloudConnectionSessions } from './cloud-connection-sessions'

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
  refreshMs?: number
  /** Per-request timeout; a hung platform must not stall the loop. */
  timeoutMs?: number
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Injected for tests; defaults to `Date.now`. */
  now?: () => number
  /** How long signing keys stay usable without a successful refetch. */
  keysTtlMs?: number
  /** Design §8.4 caps; overrides exist for tests, production uses the defaults. */
  maxSessionsPerUserProject?: number
  maxSessionsPerHost?: number
  /**
   * Enrolled-host mode: revocations and policy come from the heartbeat response
   * instead of `/v1/internal/*`. This is the normal path for a registered host;
   * the internal routes exist for hosts that never enrolled.
   */
  heartbeat?: {
    hostId: string
    credential: string
    /**
     * Addresses reported on every beat so the platform sees the port the runtime
     * actually bound, not one guessed before it listened.
     */
    directAddrs?: string[] | (() => string[])
    /** Reported so the platform can hand the host key to clients with the ticket. */
    e2eePublicKeyB64?: () => string | null
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

/**
 * Session-cap gate for accepted upgrades. The ticket is verified before the
 * handshake, but a session only exists once a socket does, so the cap is charged
 * here and the peer is closed with 4431 rather than refused pre-handshake.
 */
export type CloudSessionConnectionGate = {
  accept: (headers: CloudUpgradeHeaders) => boolean
  release: (headers: CloudUpgradeHeaders) => void
}

export type CloudAgentClient = {
  /** Upgrade-time gate backed by the current snapshot. */
  admit: (headers: CloudUpgradeHeaders) => CloudUpgradeDecision
  connectionGate: CloudSessionConnectionGate
  activeSessionCount: () => number
  refresh: () => Promise<void>
  snapshot: () => CloudAgentSnapshot
  onRefresh: (listener: (snapshot: CloudAgentSnapshot) => void) => () => void
  /** Emits E2EE device tokens whose live sessions must be closed. */
  onRevoke: (listener: (deviceTokens: string[]) => void) => () => void
  admittedCount: () => number
  start: () => void
  stop: () => void
}

const DEFAULT_REFRESH_MS = 10_000
const DEFAULT_TIMEOUT_MS = 3_000

function parseKeys(value: unknown): { kid: string; publicKeyPem: string }[] {
  return (readArray(value, 'keys') ?? []).flatMap((item) => {
    const kid = readString(item, 'kid')
    const publicKeyPem = readString(item, 'publicKeyPem')
    return kid !== null && publicKeyPem !== null ? [{ kid, publicKeyPem }] : []
  })
}

export function createCloudAgentClient(config: CloudAgentConfig): CloudAgentClient {
  const fetchImpl = config.fetchImpl ?? fetch
  const refreshMs = config.refreshMs ?? DEFAULT_REFRESH_MS
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const internalUrl = config.internalUrl ?? config.apiUrl

  const now = config.now ?? Date.now
  let keys = new Map<string, string>()
  let keysFetchedAt: number | null = null
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
  const usedJtis = new Map<string, number>()
  const admitted = new Map<
    string,
    {
      deviceToken: string
      deviceId: string
      sub: string
      project: string
      iatMs: number
      /** The ticket text as carried in the subprotocol; the socket's handle. */
      credential: string
    }
  >()
  // Why: the socket is identified by its ticket, so an admitted ticket's identity
  // must outlive `admit` for the connection gate and its close path.
  const sessions = createCloudConnectionSessions({
    perUserProject: config.maxSessionsPerUserProject,
    perHost: config.maxSessionsPerHost
  })

  const snapshot = (): CloudAgentSnapshot => ({
    kids: [...keys.keys()],
    revocations,
    lastRefreshAt,
    lastError,
    maintenance: lastMaintenance
  })

  function reportedAddrs(): { directAddrs?: string[] } {
    const configured = config.heartbeat?.directAddrs
    if (!configured) {
      return {}
    }
    const value = typeof configured === 'function' ? configured() : configured
    return value.length > 0 ? { directAddrs: value } : {}
  }

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
        keysFetchedAt = now()
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
          ...reportedAddrs(),
          ...(config.heartbeat.e2eePublicKeyB64?.()
            ? { e2eePublicKeyB64: config.heartbeat.e2eePublicKeyB64() ?? undefined }
            : {})
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
      sessions.forget(ticket.credential)
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
        revocations,
        now,
        keysFetchedAt,
        keysTtlMs: config.keysTtlMs
      })(headers)
      if (!decision.ok) {
        return decision
      }
      const { jti, deviceToken, deviceId, sub, project, exp } = decision.payload
      const iatMs = decision.payload.iatMs ?? decision.payload.iat * 1000
      // A ticket is a bearer credential: without this cache a copied one upgrades
      // again until it expires, even though the platform minted it once.
      const nowMs = now()
      for (const [used, expiresAtMs] of usedJtis) {
        if (expiresAtMs <= nowMs) {
          usedJtis.delete(used)
        }
      }
      if (usedJtis.has(jti)) {
        return rejectCloudUpgrade('replayed', '该连接凭证已被使用。')
      }
      // The ticket text is what the socket carries, so it is the handle the
      // connection gate and its close path use.
      const credential = readCloudCredentialFromHeaders(headers)
      if (credential === null) {
        return rejectCloudUpgrade('credential_missing', '缺少连接凭证。')
      }
      usedJtis.set(jti, exp * 1000 + 5_000)
      admitted.set(jti, { deviceToken, deviceId, sub, project, iatMs, credential })
      sessions.remember(credential, { user: sub, project, token: deviceToken })
      return decision
    },
    connectionGate: sessions.gate,
    activeSessionCount: sessions.activeCount,
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
      sessions.releaseAll()
      listeners.clear()
      revokeListeners.clear()
    }
  }
}
