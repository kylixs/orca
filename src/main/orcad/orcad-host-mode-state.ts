import process from 'node:process'
import type { CloudHeartbeatHealth } from '../cloud-platform/cloud-heartbeat-health'
import {
  cloudHostStatePath,
  startingCloudHostState,
  writeCloudHostState,
  writeStartingCloudHostState,
  type CloudHostState
} from '../startup/cloud-host-state'

/**
 * Host-mode lifecycle around the U181 §4.2 state file. Only the host process
 * writes it, so `starting` must land after the instance lock (a second process
 * losing the lock would otherwise erase the live host's `online`).
 */

export type HostModeStateContext = {
  statePath: string
  pid: number
  startedAt: number
  hostName: string | null
  platformUrl: string | null
}

/** The admission slice state publication reads; narrow so tests need no client. */
export type HostModeAdmission = {
  ready: Promise<void>
  client: { snapshot(): CloudHeartbeatHealth } | null
  host(): { hostId: string } | null
}

export function beginHostModeState(input: {
  userDataPath: string
  pid: number
  startedAt: number
  hostName?: string | null
  platformUrl?: string | null
  now?: number
}): HostModeStateContext {
  const context: HostModeStateContext = {
    statePath: cloudHostStatePath(input.userDataPath),
    pid: input.pid,
    startedAt: input.startedAt,
    hostName: input.hostName ?? null,
    platformUrl: input.platformUrl ?? null
  }
  writeStartingCloudHostState(context.statePath, {
    pid: context.pid,
    startedAt: context.startedAt,
    hostName: context.hostName,
    platformUrl: context.platformUrl,
    now: input.now
  })
  return context
}

/** Online is a heartbeat verdict; a failed or absent verdict keeps the previous state. */
export function writeHostModeOnlineState(
  context: HostModeStateContext,
  input: { hostId: string | null; health: CloudHeartbeatHealth; now?: number }
): CloudHostState | null {
  if (input.health.lastHeartbeatOk !== true) {
    return null
  }
  const now = input.now ?? Date.now()
  const state: CloudHostState = {
    ...startingCloudHostState({
      pid: context.pid,
      startedAt: context.startedAt,
      hostName: context.hostName,
      platformUrl: context.platformUrl,
      now
    }),
    status: 'online',
    phase: 'heartbeat',
    hostId: input.hostId,
    lastHeartbeatAt: input.health.lastHeartbeatAt,
    lastHeartbeatOk: true,
    lastHeartbeatHttpStatus: input.health.lastHeartbeatHttpStatus,
    lastErrorCode: null,
    retryable: false
  }
  writeCloudHostState(context.statePath, state)
  return state
}

/**
 * First heartbeat path: `ready` only resolves once the client has attempted a
 * beat, so a true `lastHeartbeatOk` is that beat's verdict. Rejections and
 * failed verdicts stay in `starting`; failure classification belongs to H6/H7.
 */
export async function publishHostModeOnlineWhenReady(
  context: HostModeStateContext,
  admission: HostModeAdmission
): Promise<CloudHostState | null> {
  await admission.ready
  const health = admission.client?.snapshot()
  if (!health) {
    return null
  }
  return writeHostModeOnlineState(context, {
    hostId: admission.host()?.hostId ?? null,
    health
  })
}

/** orcad's startup entry: host identity comes from the same env admission reads. */
export function beginHostModeStateFromEnv(
  userDataPath: string,
  pid = process.pid,
  startedAt = Date.now()
): HostModeStateContext {
  return beginHostModeState({
    userDataPath,
    pid,
    startedAt,
    hostName: process.env.ORCA_CLOUD_HOST_NAME ?? null,
    platformUrl: process.env.ORCA_CLOUD_API_URL ?? null
  })
}

/** Fire-and-forget after the RPC start; readiness must not wait on the platform. */
export function publishHostModeOnlineAfterStart(
  context: HostModeStateContext | null,
  admission: HostModeAdmission | null
): void {
  if (!context || !admission) {
    return
  }
  void publishHostModeOnlineWhenReady(context, admission).catch((error: unknown) => {
    console.warn('[orcad] could not publish host state online:', error)
  })
}
