import type { CloudAgentConfig } from './cloud-agent-config'
import { sendHeartbeat } from './cloud-host-enrollment'
import { cloudHeartbeatBody } from './cloud-heartbeat-body'
import { emptyRevocations, parseRevocations } from './cloud-agent-revocations'
import { parseKeys, parsePolicyResponse } from './cloud-agent-response-parsing'
import {
  createCloudUpgradeAdmission,
  readCloudCredentialFromHeaders,
  rejectCloudUpgrade,
  type CloudRevocations,
  type CloudUpgradeDecision,
  type CloudUpgradeHeaders
} from './cloud-upgrade-admission'
import { createCloudConnectionSessions } from './cloud-connection-sessions'
import { parseCloudPolicies, type CloudPolicies } from './cloud-policies'
import type { CloudProvisionReport } from './cloud-project-provision'
import { createCloudProvisionReportQueue } from './cloud-provision-report-queue'
import { createCloudHostAuditQueue, type CloudHostAuditSink } from './cloud-host-audit'
import { fetchControlPlaneReads } from './cloud-agent-endpoint-fetch'
import {
  createCloudAdmissionLedger,
  isRevokedTicket,
  notifyRevokedTokens,
  type AdmittedTicket
} from './cloud-admission-ledger'

/**
 * Host-side client for the cloud platform's control plane.
 *
 * The platform is a registry + auth service, not part of the data path (design
 * §3.3 D1). The host therefore keeps its own view of the signing keys and the
 * revocation sets, refreshed on a timer, and admits upgrades from that view.
 */

export type CloudAgentSnapshot = {
  kids: string[]
  revocations: Required<CloudRevocations>
  /** Last policy pack the platform delivered; null until one parses. */
  policies: CloudPolicies | null
  policyVersion: number | null
  lastRefreshAt: number | null
  lastError: string | null
  /** Set while the platform reports the host in maintenance. */
  maintenance: { reason: string } | null
  /** True once the platform revoked this host; it never clears. */
  hostRevoked: boolean
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
  /** True after the platform revoked this host; admission refuses everything. */
  isHostRevoked: () => boolean
  /** Queues a provisioning outcome for the next heartbeat; no-op in poll mode. */
  reportProvisioned: (report: CloudProvisionReport) => void
  /** Queues a session refusal for the next heartbeat; no-op in poll mode. */
  reportAudit: CloudHostAuditSink
  start: () => void
  stop: () => void
}

const DEFAULT_REFRESH_MS = 10_000
const DEFAULT_TIMEOUT_MS = 3_000

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
  let hostRevoked = false
  let policies: CloudPolicies | null = null
  let policyVersion: number | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let inFlight: Promise<void> | null = null
  const provisionReports = createCloudProvisionReportQueue(config.heartbeat !== undefined)
  const auditEvents = createCloudHostAuditQueue(config.heartbeat !== undefined)
  const listeners = new Set<(snapshot: CloudAgentSnapshot) => void>()
  const revokeListeners = new Set<(deviceTokens: string[]) => void>()
  // Why: revocation arrives as platform device/user/project ids, but the socket is
  // keyed by the E2EE device token from the ticket — keep the mapping from admission.
  const ledger = createCloudAdmissionLedger(now)
  // Why: the socket is identified by its ticket, so an admitted ticket's identity
  // must outlive `admit` for the connection gate and its close path.
  const sessions = createCloudConnectionSessions({
    perUserProject: config.maxSessionsPerUserProject,
    perHost: config.maxSessionsPerHost,
    perDeviceSockets: config.maxSocketsPerDeviceSession
  })

  const snapshot = (): CloudAgentSnapshot => ({
    kids: [...keys.keys()],
    revocations,
    policies,
    policyVersion,
    lastRefreshAt,
    lastError,
    maintenance: lastMaintenance,
    hostRevoked
  })

  async function refreshOnce(): Promise<void> {
    const reads = await fetchControlPlaneReads({
      fetchImpl,
      apiUrl: config.apiUrl,
      internalUrl,
      internalToken: config.internalToken,
      timeoutMs,
      heartbeatMode: config.heartbeat !== undefined
    })
    const jwksRes = reads.jwks
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
      // Snapshot before sending; keep the entries until the platform accepts the beat.
      const provisionBatch = provisionReports.take()
      const auditBatch = auditEvents.take()
      // Heartbeat is the enrolled host's revocation channel (design §4.1). It is
      // preferred over the internal routes, which a registered host may not reach.
      const beat = await sendHeartbeat(
        config.apiUrl,
        config.heartbeat.credential,
        config.heartbeat.hostId,
        cloudHeartbeatBody(config.heartbeat, provisionBatch.reports, auditBatch.events),
        fetchImpl,
        timeoutMs
      )
      if (beat) {
        // Why by sequence: a report queued while this beat was in flight is newer
        // than anything the platform just accepted.
        provisionReports.clearThrough(provisionBatch.seq)
        auditEvents.clearThrough(auditBatch.seq)
        const parsed = parseRevocations(beat.revoked)
        if (parsed) {
          revocations = parsed
        }
        // Keep the last good pack: a malformed one must not silently reopen exports.
        const parsedPolicies = parseCloudPolicies(beat.policies)
        if (parsedPolicies) {
          policies = parsedPolicies
        }
        policyVersion = beat.policyVersion
        lastMaintenance = beat.maintenance
        if (beat.hostRevoked) {
          // Why: a host-wide revocation has no per-ticket `since`; every admitted
          // ticket is dead, and the platform will never admit another.
          hostRevoked = true
          lastError = 'host_revoked'
          revokeAllAdmitted()
        }
      } else {
        lastError = 'heartbeat failed'
      }
    } else if (reads.revoked?.ok) {
      const parsed = parseRevocations(await reads.revoked.json())
      if (parsed) {
        revocations = parsed
      }
    }
    if (!config.heartbeat && reads.policy?.ok) {
      const parsed = parsePolicyResponse(await reads.policy.json())
      if (parsed) {
        policies = parsed.policies
        policyVersion = parsed.version
      }
    }
    lastRefreshAt = Date.now()
    const current = snapshot()
    for (const listener of listeners) {
      listener(current)
    }
    emitRevokedSessions()
    if (hostRevoked) {
      stopClient()
    }
  }

  /**
   * Tickets admitted before the revocation `since` are dead; their live sockets
   * must be closed too, otherwise a revoked device keeps its session forever.
   */
  function emitRevokedSessions(): void {
    const revokedTokens: string[] = []
    for (const [jti, ticket] of ledger.entries()) {
      if (!isRevokedTicket(jti, ticket, revocations)) {
        continue
      }
      ledger.forget(jti)
      sessions.forget(ticket.credential)
      revokedTokens.push(ticket.deviceToken)
    }
    notifyRevokedTokens(revokeListeners, revokedTokens)
  }

  /** Host-wide revocation: close every admitted socket, regardless of its ticket age. */
  function revokeAllAdmitted(): void {
    const drained = ledger.drain()
    for (const ticket of drained) {
      sessions.forget(ticket.credential)
    }
    notifyRevokedTokens(
      revokeListeners,
      drained.map((ticket: AdmittedTicket) => ticket.deviceToken)
    )
  }

  function stopClient(): void {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    sessions.releaseAll()
    listeners.clear()
    revokeListeners.clear()
  }

  /** Single-flight: a hung platform must not stack one request per tick. */
  function refresh(): Promise<void> {
    // Why: after revocation the heartbeat is useless and the timer is stopped;
    // a stray manual call must not resurrect it.
    if (hostRevoked) {
      return Promise.resolve()
    }
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
      // Why every refusal is audited here: this is the one gate all upgrades pass,
      // and a failed ticket has no device to record it from anywhere else.
      const refuse = (reason: string, message: string) => {
        auditEvents({ eventType: 'connection_rejected', reason })
        return rejectCloudUpgrade(reason, message)
      }
      // A revoked host refuses upgrades even with a still-fresh ticket.
      if (hostRevoked) {
        return refuse('host_revoked', '主机已被吊销。')
      }
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
        auditEvents({ eventType: 'connection_rejected', reason: decision.reason })
        return decision
      }
      const { jti, deviceToken, deviceId, sub, project, exp } = decision.payload
      const iatMs = decision.payload.iatMs ?? decision.payload.iat * 1000
      if (ledger.isReplayed(jti)) {
        return refuse('replayed', '该连接凭证已被使用。')
      }
      // The ticket text is what the socket carries, so it is the handle the
      // connection gate and its close path use.
      const credential = readCloudCredentialFromHeaders(headers)
      if (credential === null) {
        return refuse('credential_missing', '缺少连接凭证。')
      }
      ledger.remember({
        jti,
        ticket: { deviceToken, deviceId, sub, project, iatMs, credential },
        expiresAtMs: exp * 1000 + 5_000
      })
      sessions.remember(credential, { user: sub, project, token: deviceToken, device: deviceId })
      return decision
    },
    connectionGate: sessions.gate,
    activeSessionCount: sessions.activeCount,
    onRevoke: (listener) => {
      revokeListeners.add(listener)
      return () => revokeListeners.delete(listener)
    },
    admittedCount: () => ledger.size(),
    isHostRevoked: () => hostRevoked,
    reportProvisioned: provisionReports.queue,
    reportAudit: auditEvents,
    refresh,
    snapshot,
    onRefresh: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    start: () => {
      // A revoked host that restarts must not resume polling.
      if (timer || hostRevoked) {
        return
      }
      void refresh()
      timer = setInterval(() => {
        void refresh()
      }, refreshMs)
      // Why: the host must not stay alive only to poll a control plane.
      timer.unref?.()
    },
    stop: stopClient
  }
}
