import type { CloudDenialCode } from './cloud-denial-details'

/**
 * Security refusals the host records locally and reports on its next heartbeat
 * (design §5.1: 批量上报连接、鉴权失败、导出拦截事件，本地缓冲，断网不丢).
 *
 * The buffer is in memory: it survives a platform outage, not a host restart —
 * a refusals log that outlives the process would be a second audit store with
 * its own retention and integrity story, which the platform already owns.
 */

export type CloudHostAuditEventType = 'connection_rejected' | 'path_denied' | 'method_denied'

export type CloudHostAuditInput = {
  eventType: CloudHostAuditEventType
  /** Only known once a ticket verified; a forged upgrade has no device. */
  deviceId?: string
  subject?: string
  projectId?: string
  method?: string
  denial?: CloudDenialCode
  reason?: string
}

export type CloudHostAuditRecord = CloudHostAuditInput & { result: 'denied' }

export type CloudHostAuditSink = (event: CloudHostAuditInput) => void

/** What one heartbeat carries; the platform enforces its own, smaller cap. */
const MAX_PENDING_EVENTS = 200

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
}

/** `enabled` is false for a poll-mode host: it has no heartbeat to carry a batch. */
export function createCloudHostAuditQueue(enabled: boolean): CloudHostAuditQueue {
  let seq = 0
  let pending: { seq: number; event: CloudHostAuditRecord }[] = []
  const queue = (input: CloudHostAuditInput): void => {
    if (!enabled) {
      return
    }
    pending.push({ seq: ++seq, event: { ...input, result: 'denied' } })
    // A refused flood must not grow a heartbeat body without bound: keep the newest.
    if (pending.length > MAX_PENDING_EVENTS) {
      pending = pending.slice(-MAX_PENDING_EVENTS)
    }
  }
  return Object.assign(queue, {
    take: (): CloudHostAuditBatch => ({
      events: pending.map((entry) => entry.event),
      seq
    }),
    clearThrough: (acceptedSeq: number): void => {
      pending = pending.filter((entry) => entry.seq > acceptedSeq)
    },
    pending: (): number => pending.length
  })
}
