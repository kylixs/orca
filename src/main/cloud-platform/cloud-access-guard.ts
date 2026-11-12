import {
  DEFAULT_DOWNLOAD_POLICY,
  downloadAllowed,
  readRateFor,
  type CloudPolicies,
  type CloudReadRate
} from './cloud-policies'

/**
 * Host-side enforcement of the platform's policy pack for cloud sessions
 * (design §9): exported/download methods are refused unless policy allows them,
 * and file reads are metered so a client that bypasses the UI cannot pull a
 * repository out quietly.
 *
 * Content reads are deliberately not blocked — a read returns bytes and any
 * client can rebuild a file. The promise is "no dedicated export channel, and
 * every bulk read is accounted", not content-level DLP.
 */

export type CloudAccessGuard = {
  /** False closes every export RPC for this project (policy or stale policy). */
  downloadAllowed: (projectId: string) => boolean
  /** Charges one read against the rolling hour; false means the budget is spent. */
  consumeRead: (projectId: string) => boolean
  /** Records bytes actually returned by a read. */
  accountReply: (projectId: string, bytes: number) => void
  usage: (projectId: string) => { calls: number; bytes: number; rate: CloudReadRate }
}

export type CloudPolicySource = { policies: CloudPolicies | null }

const HOUR_MS = 60 * 60 * 1000

export function createCloudAccessGuard(
  source: () => CloudPolicySource,
  options: { now?: () => number } = {}
): CloudAccessGuard {
  const now = options.now ?? Date.now
  // Why: entries carry their own timestamp so the window slides instead of
  // resetting on a clock hour, which would let a caller spend two budgets at 59:59.
  const windows = new Map<string, { at: number; bytes: number }[]>()

  const policies = (): CloudPolicies => source().policies ?? DEFAULT_DOWNLOAD_POLICY

  const prune = (projectId: string, nowMs: number): { at: number; bytes: number }[] => {
    const entries = (windows.get(projectId) ?? []).filter((entry) => entry.at > nowMs - HOUR_MS)
    windows.set(projectId, entries)
    return entries
  }

  return {
    downloadAllowed: (projectId) => downloadAllowed(policies(), projectId),
    consumeRead: (projectId) => {
      const nowMs = now()
      const entries = prune(projectId, nowMs)
      const rate = readRateFor(policies(), projectId)
      const consumed = entries.reduce((total, entry) => total + entry.bytes, 0)
      // Bytes are only known after the reply, so the byte budget stops the next
      // read rather than the one that returns it.
      if (entries.length >= rate.calls || consumed >= rate.bytes) {
        return false
      }
      entries.push({ at: nowMs, bytes: 0 })
      return true
    },
    accountReply: (projectId, bytes) => {
      const entries = prune(projectId, now())
      // The charge belongs to the read just consumed; the newest entry is it.
      const latest = entries.at(-1)
      if (latest) {
        latest.bytes += Math.max(0, bytes)
      }
    },
    usage: (projectId) => {
      const entries = prune(projectId, now())
      return {
        calls: entries.length,
        bytes: entries.reduce((total, entry) => total + entry.bytes, 0),
        rate: readRateFor(policies(), projectId)
      }
    }
  }
}
