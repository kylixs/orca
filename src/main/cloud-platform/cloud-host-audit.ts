import { randomBytes } from 'node:crypto'
import type { CloudDenialCode } from './cloud-denial-details'

/**
 * Security refusals the host records locally and reports on its next heartbeat
 * (design §5.1: 批量上报连接、鉴权失败、导出拦截事件，本地缓冲，断网不丢).
 *
 * The buffer is in memory: it survives a platform outage, not a host restart —
 * a refusals log that outlives the process would be a second audit store with
 * its own retention and integrity story, which the platform already owns.
 *
 * U66 file events (`file_download`/`file_copy`/`download_blocked`) ride the same
 * channel (§2.10): client-declared reports enqueue here through the host's
 * `audit.recordFileEvent` RPC and reach the chain on the next beat.
 */

export type CloudHostAuditEventType =
  | 'connection_rejected'
  | 'path_denied'
  | 'method_denied'
  | 'file_download'
  | 'file_copy'
  | 'download_blocked'

export type CloudHostAuditInput = {
  eventType: CloudHostAuditEventType
  /** Only the security refusals default; file events declare their own outcome. */
  result?: 'success' | 'failure' | 'denied'
  /** Only known once a ticket verified; a forged upgrade has no device. */
  deviceId?: string
  subject?: string
  projectId?: string
  method?: string
  denial?: CloudDenialCode
  reason?: string
  /** Correlates a client action across the client RPC and the chain entry (§2.10.3). */
  traceId?: string
  /** Whitelisted §2.5 fields only; the intake validates before it enqueues. */
  metadata?: Record<string, unknown>
}

export type CloudHostAuditRecord = CloudHostAuditInput & {
  result: 'success' | 'failure' | 'denied'
}

/** What one heartbeat carries; the platform enforces its own, smaller cap. */
export const MAX_PENDING_EVENTS = 200
/** The platform parses at most this many reports per beat (host-audit-ingest.ts). */
export const MAX_EVENTS_PER_BEAT = 100

/** Gap visibility for the heartbeat (§2.10.4, wire-additive; old platforms ignore it). */
export type CloudAuditGap = {
  bootId: string
  pending: number
  dropped: number
  suppressed: number
  rateLimited: number
}

export type CloudHostAuditSink = (event: CloudHostAuditInput) => void

export type CloudHostAuditBatch = {
  events: CloudHostAuditRecord[]
  /** Marker for the last buffered event included in this batch. */
  seq: number
}

export type CloudHostAuditQueue = CloudHostAuditSink & {
  take: () => CloudHostAuditBatch
  /** Drops what the platform accepted; anything recorded after the batch survives. */
  clearThrough: (seq: number) => void
  pending: () => number
  /** Merges a best-effort savedName supplement into the pending same-trace download (§2.10.3). */
  mergeSavedName: (traceId: string, deviceId: string, savedName: string) => boolean
  /** Counters the heartbeat's `auditGap` carries; never reset except by a restart (new bootId). */
  gaps: () => CloudAuditGap
  noteDropped: (count?: number) => void
  noteRateLimited: () => void
  noteSuppressed: (count?: number) => void
}

export function createCloudHostAuditQueue(enabled: boolean): CloudHostAuditQueue {
  let seq = 0
  let pending: { seq: number; event: CloudHostAuditRecord }[] = []
  // §2.10.4: gap visibility is best-effort per boot; a restart yields a fresh bootId.
  const bootId = randomBytes(8).toString('hex')
  let dropped = 0
  let suppressed = 0
  let rateLimited = 0
  const queue = (input: CloudHostAuditInput): void => {
    if (!enabled) {
      return
    }
    pending.push({
      seq: ++seq,
      event: { ...input, result: input.result ?? 'denied' }
    })
    // A refused flood must not grow a heartbeat body without bound: keep the newest,
    // and say how many the backstop consumed instead of dropping silently (R-04).
    if (pending.length > MAX_PENDING_EVENTS) {
      const excess = pending.length - MAX_PENDING_EVENTS
      dropped += excess
      pending = pending.slice(excess)
    }
  }
  return Object.assign(queue, {
    take: (): CloudHostAuditBatch => {
      // Why slice: the platform reads only the first 100 reports per beat, so
      // handing it 200 and clearing through the last one lost 100-200 forever
      // (§1.3). The remainder stays pending and rides the next beat.
      const batch = pending.slice(0, MAX_EVENTS_PER_BEAT)
      return { events: batch.map((entry) => entry.event), seq: batch.at(-1)?.seq ?? 0 }
    },
    clearThrough: (acceptedSeq: number): void => {
      pending = pending.filter((entry) => entry.seq > acceptedSeq)
    },
    pending: (): number => pending.length,
    mergeSavedName: (traceId: string, deviceId: string, savedName: string): boolean => {
      const target = pending.find(
        (entry) =>
          entry.event.eventType === 'file_download' &&
          entry.event.traceId === traceId &&
          entry.event.deviceId === deviceId
      )
      if (!target) {
        return false
      }
      target.event.metadata = { ...target.event.metadata, savedName }
      return true
    },
    gaps: (): CloudAuditGap => ({
      bootId,
      pending: pending.length,
      dropped,
      suppressed,
      rateLimited
    }),
    noteDropped: (count = 1): void => {
      dropped += count
    },
    noteRateLimited: (): void => {
      rateLimited += 1
    },
    noteSuppressed: (count = 1): void => {
      suppressed += count
    }
  })
}
