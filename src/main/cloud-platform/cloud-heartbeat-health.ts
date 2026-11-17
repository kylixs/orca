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
  recordRefreshFailure: () => void
  snapshot: () => CloudHeartbeatHealth
}

export function createCloudHeartbeatHealth(): CloudHeartbeatHealthTracker {
  let lastHeartbeatAt: number | null = null
  let lastHeartbeatOk: boolean | null = null
  let lastHeartbeatHttpStatus: number | null = null
  let lastErrorCode: string | null = null
  return {
    record: (attempt, at) => {
      lastHeartbeatOk = attempt.ok
      lastHeartbeatHttpStatus = attempt.httpStatus
      lastErrorCode = attempt.errorCode
      if (attempt.ok) {
        lastHeartbeatAt = at
      }
    },
    recordRefreshFailure: () => {
      lastHeartbeatOk = false
      lastHeartbeatHttpStatus = null
      lastErrorCode = 'heartbeat_failed'
    },
    snapshot: () => ({
      lastHeartbeatAt,
      lastHeartbeatOk,
      lastHeartbeatHttpStatus,
      lastErrorCode
    })
  }
}
