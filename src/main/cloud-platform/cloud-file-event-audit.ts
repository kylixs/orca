import { parseAuditCapabilities } from './cloud-agent-response-parsing'
import type { CloudAuditGap, CloudHostAuditInput, CloudHostAuditQueue } from './cloud-host-audit'

/**
 * U66 §2.10 host-side intake for `audit.recordFileEvent` (R-01).
 *
 * The runtime RPC validates the §2.5 field whitelist before it calls in; this
 * layer owns the delivery policy: capability gating (§2.9), the 120/min
 * per-session rate limit, queue backpressure, same-trace dedupe and the
 * `savedName` merge (§2.10.3). Every refusal updates the queue's gap counters
 * so the heartbeat's `auditGap` makes the loss visible instead of silent.
 */

/** The three client-declared event families §2.10.1 routes through this RPC. */
export type CloudFileEventReport = {
  eventType: 'file_download' | 'file_copy' | 'download_blocked'
  result: 'success' | 'failure' | 'denied'
  traceId?: string
  metadata?: Record<string, unknown>
}

export type CloudFileEventIdentity = {
  /** The ticket's platform device id; the platform resolves the actor from it. */
  deviceId: string
  /** `user:<username>` straight from the ticket's sub (§2.1 subject form). */
  subject: string
  projectId: string
}

export type CloudFileEventReply =
  | { queued: true; merged?: boolean; excerptDropped?: boolean }
  | {
      queued: false
      reason:
        | 'audit-unavailable'
        | 'capability-unsupported'
        | 'rate-limited'
        | 'queue-full'
        | 'duplicate'
        | 'unmatched-saved-name'
    }

export type CloudFileEventAudit = (
  report: CloudFileEventReport,
  identity: CloudFileEventIdentity
) => CloudFileEventReply

/** The RPC handler's view: the transport has already bound the session identity. */
export type CloudFileEventSubmit = (report: CloudFileEventReport) => CloudFileEventReply

export type CloudFileEventAuditOptions = {
  /** The heartbeat queue; also owns the gap counters the auditGap carries. */
  queue: CloudHostAuditQueue
  fileEventsCapable: () => boolean
  rateLimit?: number
  rateWindowMs?: number
  maxPending?: number
  now?: () => number
}

export const DEFAULT_FILE_EVENT_RATE_LIMIT = 120
export const DEFAULT_FILE_EVENT_RATE_WINDOW_MS = 60_000

/** Bounded memory for the same-trace dedupe; far above any honest action rate. */
const TRACE_MEMORY_ENTRIES = 256

export function createCloudFileEventAudit(
  options: CloudFileEventAuditOptions
): CloudFileEventAudit {
  const rateLimit = options.rateLimit ?? DEFAULT_FILE_EVENT_RATE_LIMIT
  const rateWindowMs = options.rateWindowMs ?? DEFAULT_FILE_EVENT_RATE_WINDOW_MS
  const maxPending = options.maxPending ?? 200
  const now = options.now ?? Date.now
  const sentAt = new Map<string, number[]>()
  const seenTraces = new Map<string, number>()

  function noteSend(projectId: string, current: number): void {
    const window = (sentAt.get(projectId) ?? []).filter((at) => current - at < rateWindowMs)
    window.push(current)
    sentAt.set(projectId, window)
  }

  return (report, identity) => {
    if (!options.fileEventsCapable()) {
      options.queue.noteSuppressed()
      return { queued: false, reason: 'capability-unsupported' }
    }
    const current = now()
    const window = (sentAt.get(identity.projectId) ?? []).filter(
      (at) => current - at < rateWindowMs
    )
    sentAt.set(identity.projectId, window)
    if (window.length >= rateLimit) {
      options.queue.noteRateLimited()
      return { queued: false, reason: 'rate-limited' }
    }
    if (options.queue.pending() >= maxPending) {
      // §2.10.2: refuse instead of forcing a drop; the queue's own backstop
      // counters remain for bursts that slip past this check.
      return { queued: false, reason: 'queue-full' }
    }

    const metadata: Record<string, unknown> = { ...report.metadata }
    // §2.10.2: the host assigns confidence — a client report is fixed to
    // client-declared, whatever the client claimed; `host-attested` is only
    // reachable from host-side producers.
    metadata.captureConfidence = 'client-declared'
    // §2.6: excerpts stay off for the first release; the host is authoritative.
    const excerptDropped =
      metadata.excerpt !== undefined ||
      metadata.excerptBytes !== undefined ||
      metadata.excerptTruncated !== undefined
    delete metadata.excerpt
    delete metadata.excerptBytes
    delete metadata.excerptTruncated

    // §2.10.3: a savedName supplement merges into the pending same-trace event,
    // or is dropped — it never becomes a second download.
    const isSupplement =
      metadata.savedName !== undefined &&
      metadata.method === undefined &&
      metadata.path === undefined
    if (isSupplement) {
      const merged = options.queue.mergeSavedName(
        report.traceId ?? '',
        identity.deviceId,
        String(metadata.savedName)
      )
      if (merged) {
        return { queued: true, merged: true }
      }
      options.queue.noteDropped()
      return { queued: false, reason: 'unmatched-saved-name' }
    }

    // §2.4: one action, one event — a retried traceId while the first is still
    // pending must not queue a second entry.
    if (report.traceId && report.eventType !== 'file_copy') {
      const traceKey = `${identity.projectId}\u0000${report.traceId}`
      const seenAt = seenTraces.get(traceKey)
      if (seenAt !== undefined && current - seenAt < rateWindowMs) {
        return { queued: false, reason: 'duplicate' }
      }
      seenTraces.set(traceKey, current)
      if (seenTraces.size > TRACE_MEMORY_ENTRIES) {
        const oldest = seenTraces.keys().next().value
        if (oldest !== undefined) {
          seenTraces.delete(oldest)
        }
      }
    }

    noteSend(identity.projectId, current)
    const event: CloudHostAuditInput = {
      eventType: report.eventType,
      result: report.result,
      deviceId: identity.deviceId,
      subject: identity.subject,
      projectId: identity.projectId,
      traceId: report.traceId,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {})
    }
    options.queue(event)
    return excerptDropped ? { queued: true, excerptDropped: true } : { queued: true }
  }
}

/** What the cloud agent client needs to deliver file events on its heartbeat. */
export type CloudFileEventDelivery = {
  audit: CloudFileEventAudit
  /** Absorbs the heartbeat response's raw `auditCapabilities` (§2.9). */
  noteCapabilities: (raw: unknown) => void
  capabilities: () => { fileEvents: boolean } | null
}

/**
 * §2.9 capability negotiation. The platform declares `auditCapabilities` on the
 * heartbeat response (server.ts carries `fileEvents: true` since U66 phase 2),
 * so gating is strict: only a declared capability delivers, and anything else —
 * an old platform that predates the field, or an explicit `fileEvents:false` —
 * is suppressed and counted, never silently dropped.
 */
export function createCloudFileEventDelivery(queue: CloudHostAuditQueue): CloudFileEventDelivery {
  let capabilities: { fileEvents: boolean } | null = null
  return {
    audit: createCloudFileEventAudit({
      queue,
      fileEventsCapable: () => capabilities?.fileEvents === true
    }),
    noteCapabilities: (raw) => {
      capabilities = parseAuditCapabilities(raw)
    },
    capabilities: () => capabilities
  }
}

export type { CloudAuditGap }
