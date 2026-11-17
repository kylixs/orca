/**
 * Heartbeat retry schedule (U181 F5): network/5xx failures keep the host running
 * but back off 10s → 30s → 60s; the next success returns it to the 10s cadence.
 * The caller keeps its existing interval and asks whether a tick may proceed.
 */

export const HEARTBEAT_BACKOFF_DELAYS_MS: readonly number[] = [10_000, 30_000, 60_000]

export type HeartbeatBackoff = {
  /** True when a scheduled tick is allowed to hit the platform. */
  allows: (at: number) => boolean
  recordSuccess: () => void
  recordFailure: (at: number) => void
  snapshot: () => { failures: number; nextAttemptAt: number | null }
}

export function createHeartbeatBackoff(
  delays: readonly number[] = HEARTBEAT_BACKOFF_DELAYS_MS
): HeartbeatBackoff {
  let failures = 0
  let nextAttemptAt: number | null = null
  return {
    allows: (at) => nextAttemptAt === null || at >= nextAttemptAt,
    recordSuccess: () => {
      failures = 0
      nextAttemptAt = null
    },
    recordFailure: (at) => {
      const delay = delays[Math.min(failures, delays.length - 1)] ?? 0
      failures += 1
      nextAttemptAt = at + delay
    },
    snapshot: () => ({ failures, nextAttemptAt })
  }
}
