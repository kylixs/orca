import type { CloudProvisionReport } from './cloud-project-provision'

/**
 * Outcomes waiting for the next heartbeat. Bounded so a long platform outage
 * cannot grow one heartbeat body without limit.
 */

const MAX_PENDING_REPORTS = 32

export type CloudProvisionReportBatch = {
  reports: CloudProvisionReport[]
  /** Marker for the last queued report included in this batch. */
  seq: number
}

export type CloudProvisionReportQueue = {
  /** A repeated provision of the same project supersedes its older outcome. */
  queue: (report: CloudProvisionReport) => void
  take: () => CloudProvisionReportBatch
  /** Drops what the platform accepted; anything queued after the batch survives. */
  clearThrough: (seq: number) => void
}

/** `enabled` is false for a poll-mode host: it has no heartbeat to carry a report. */
export function createCloudProvisionReportQueue(enabled: boolean): CloudProvisionReportQueue {
  let seq = 0
  let pending: { seq: number; report: CloudProvisionReport }[] = []
  return {
    queue: (report) => {
      if (!enabled) {
        return
      }
      pending = pending.filter((entry) => entry.report.projectId !== report.projectId)
      pending.push({ seq: ++seq, report })
      if (pending.length > MAX_PENDING_REPORTS) {
        pending = pending.slice(-MAX_PENDING_REPORTS)
      }
    },
    take: () => ({
      reports: pending.map((entry) => entry.report),
      seq
    }),
    clearThrough: (acceptedSeq) => {
      pending = pending.filter((entry) => entry.seq > acceptedSeq)
    }
  }
}
