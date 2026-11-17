import { createHeartbeatBackoff } from './cloud-heartbeat-backoff'
import type { HeartbeatAttempt } from './cloud-host-enrollment'

/** Structured heartbeat verdict surfaced on `CloudAgentSnapshot` (U181 §4.4). */
export type CloudHeartbeatHealth = {
  /** Last successful heartbeat; failures preserve it. */
  lastHeartbeatAt: number | null
  /** null until the first beat; online requires true. */
  lastHeartbeatOk: boolean | null
  /** HTTP status of the last beat; null when the request never got a response. */
  lastHeartbeatHttpStatus: number | null
  /** Stable failure code; null after a successful beat. */
  lastErrorCode: string | null
}

export type CloudHeartbeatHealthTracker = {
  record: (attempt: HeartbeatAttempt, at: number) => void
  /** A thrown refresh never reached a verdict on the beat. */
  recordRefreshFailure: (at?: number) => void
  /** Tick gate: false while a degraded heartbeat is backing off. */
  allowsAttempt: (at: number) => boolean
  snapshot: () => CloudHeartbeatHealth
}

export function createCloudHeartbeatHealth(): CloudHeartbeatHealthTracker {
  const backoff = createHeartbeatBackoff()
  let lastHeartbeatAt: number | null = null
  let lastHeartbeatOk: boolean | null = null
  let lastHeartbeatHttpStatus: number | null = null
  let lastErrorCode: string | null = null
  return {
    record: (attempt, at) => {
      // A 200 that reports the host revoked is terminal, not a healthy beat.
      const revoked = attempt.ok && attempt.result.hostRevoked
      lastHeartbeatOk = attempt.ok && !revoked
      lastHeartbeatHttpStatus = attempt.httpStatus
      lastErrorCode = revoked ? 'host_revoked' : attempt.errorCode
      if (attempt.ok) {
        lastHeartbeatAt = at
        backoff.recordSuccess()
      } else {
        backoff.recordFailure(at)
      }
    },
    recordRefreshFailure: (at = Date.now()) => {
      lastHeartbeatOk = false
      lastHeartbeatHttpStatus = null
      lastErrorCode = 'heartbeat_failed'
      backoff.recordFailure(at)
    },
    allowsAttempt: backoff.allows,
    snapshot: () => ({
      lastHeartbeatAt,
      lastHeartbeatOk,
      lastHeartbeatHttpStatus,
      lastErrorCode
    })
  }
}
