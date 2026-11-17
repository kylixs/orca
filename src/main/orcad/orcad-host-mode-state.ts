import process from 'node:process'
import type { CloudHeartbeatHealth } from '../cloud-platform/cloud-heartbeat-health'
import {
  cloudHostStatePath,
  startingCloudHostState,
  writeCloudHostState,
  type CloudHostState,
  type CloudHostStatePhase
} from '../startup/cloud-host-state'
import { hostModeExitCodeForFailure } from './orcad-exit-code'

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
  /** Set once a terminal verdict stopped the process, so it stops exactly once. */
  terminal: boolean
  /** Set once a graceful stop persisted `stopped`. */
  stopped: boolean
  /** Last persisted snapshot, so `stopped` keeps hostId/registeredAt/heartbeat fields. */
  lastState: CloudHostState | null
}

/** The admission slice state publication reads; narrow so tests need no client. */
export type HostModeAdmission = {
  ready: Promise<void>
  client: {
    snapshot(): CloudHeartbeatHealth
    onRefresh?: (listener: () => void) => () => void
  } | null
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
  const statePath = cloudHostStatePath(input.userDataPath)
  const initial = startingCloudHostState({
    pid: input.pid,
    startedAt: input.startedAt,
    hostName: input.hostName ?? null,
    platformUrl: input.platformUrl ?? null,
    now: input.now
  })
  writeCloudHostState(statePath, initial)
  return {
    statePath,
    pid: input.pid,
    startedAt: input.startedAt,
    hostName: input.hostName ?? null,
    platformUrl: input.platformUrl ?? null,
    terminal: false,
    stopped: false,
    lastState: initial
  }
}

function persist(context: HostModeStateContext, state: CloudHostState): CloudHostState {
  writeCloudHostState(context.statePath, state)
  context.lastState = state
  return state
}

function baseState(context: HostModeStateContext, now: number): CloudHostState {
  const { pid, startedAt, hostName, platformUrl } = context
  return startingCloudHostState({ pid, startedAt, hostName, platformUrl, now })
}

/** Design §4.2.3: entering registration, before the register request is sent. */
export function writeHostModeEnrollingState(
  context: HostModeStateContext,
  input: { now?: number } = {}
): CloudHostState {
  const now = input.now ?? Date.now()
  return persist(context, {
    ...baseState(context, now),
    status: 'enrolling',
    phase: 'enrolment'
  })
}

/** Design §4.2.4: the credential exists, before the first heartbeat verdict lands. */
export function writeHostModeRegisteredState(
  context: HostModeStateContext,
  host: { hostId: string; registeredAt: number },
  input: { now?: number } = {}
): CloudHostState {
  const now = input.now ?? Date.now()
  return persist(context, {
    ...baseState(context, now),
    status: 'registered',
    phase: 'heartbeat',
    hostId: host.hostId,
    registeredAt: host.registeredAt
  })
}

/** Admission callbacks that publish §4.2.3–4; desktop launches have no state file. */
export function hostModeStateHooks(context: HostModeStateContext | null): {
  onEnrolling?: () => void
  onRegistered?: (host: { hostId: string; registeredAt: number }) => void
} {
  if (!context) {
    return {}
  }
  return {
    onEnrolling: () => writeHostModeEnrollingState(context),
    onRegistered: (host) => writeHostModeRegisteredState(context, host)
  }
}

/** Design §4.2.8: a graceful stop persists `stopped` once; failures own the final state. */
export function writeHostModeStoppedStateOnShutdown(
  context: HostModeStateContext | null,
  cleanupState: { failed: boolean },
  now = Date.now()
): CloudHostState | null {
  if (
    !context ||
    cleanupState.failed ||
    context.terminal ||
    context.stopped ||
    context.lastState?.status === 'error' // keeps the failure code, not a clean stop
  ) {
    return null
  }
  context.stopped = true
  const last = context.lastState ?? baseState(context, now)
  return persist(context, { ...last, status: 'stopped', updatedAt: now })
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
    ...baseState(context, now),
    status: 'online',
    phase: 'heartbeat',
    hostId: input.hostId,
    registeredAt: context.lastState?.registeredAt ?? null,
    lastHeartbeatAt: input.health.lastHeartbeatAt,
    lastHeartbeatOk: true,
    lastHeartbeatHttpStatus: input.health.lastHeartbeatHttpStatus,
    lastErrorCode: null,
    retryable: false
  }
  return persist(context, state)
}

type HostModeHeartbeatVerdict =
  | { kind: 'online' }
  | { kind: 'failure'; code: string; fatal: boolean }

/**
 * Shared by the first beat and every later one, so `online`/`degraded`/`error`
 * cannot drift between the startup path and the watcher.
 */
function heartbeatVerdict(health: CloudHeartbeatHealth): HostModeHeartbeatVerdict | null {
  if (health.lastHeartbeatOk === true) {
    return { kind: 'online' }
  }
  if (health.lastErrorCode === null) {
    return null
  }
  // 401 and a revoked host are terminal; every other failure may clear on retry.
  const fatal =
    health.lastErrorCode === 'heartbeat_unauthorized' || health.lastErrorCode === 'host_revoked'
  return { kind: 'failure', code: health.lastErrorCode, fatal }
}

/** Persist one heartbeat verdict; a terminal one stops the host exactly once. */
function applyHostModeHeartbeatVerdict(input: {
  context: HostModeStateContext
  admission: HostModeAdmission
  health: CloudHeartbeatHealth
  onTerminal?: (exitCode: number) => void
}): CloudHostState | null {
  if (input.context.terminal) {
    return null
  }
  const verdict = heartbeatVerdict(input.health)
  if (!verdict) {
    return null
  }
  const hostId = input.admission.host()?.hostId ?? null
  if (verdict.kind === 'online') {
    return writeHostModeOnlineState(input.context, { hostId, health: input.health })
  }
  const state = writeHostModeFailureState(input.context, {
    code: verdict.code,
    retryable: !verdict.fatal,
    status: verdict.fatal ? 'error' : 'degraded',
    phase: 'heartbeat',
    hostId,
    health: input.health
  })
  if (verdict.fatal) {
    input.context.terminal = true
    input.onTerminal?.(hostModeExitCodeForFailure(verdict.code, false))
  }
  return state
}

/**
 * First heartbeat path: `ready` only resolves once the client has attempted a
 * beat, so its verdict is the launch's first verdict — `online` on success,
 * `degraded` while a retryable failure continues, `error` + exit 78 on rejection.
 */
export async function publishHostModeInitialStateWhenReady(
  context: HostModeStateContext,
  admission: HostModeAdmission,
  onTerminal?: (exitCode: number) => void
): Promise<CloudHostState | null> {
  await admission.ready
  const health = admission.client?.snapshot()
  if (!health) {
    return null
  }
  return applyHostModeHeartbeatVerdict({ context, admission, health, onTerminal })
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
export function publishHostModeInitialStateAfterStart(
  context: HostModeStateContext | null,
  admission: HostModeAdmission | null,
  onTerminal?: (exitCode: number) => void
): void {
  if (!context || !admission) {
    return
  }
  void publishHostModeInitialStateWhenReady(context, admission, onTerminal).catch(
    (error: unknown) => {
      console.warn('[orcad] could not publish host state:', error)
    }
  )
}

export type HostModeFailureStateInput = {
  code: string
  retryable: boolean
  phase: CloudHostStatePhase
  /** `error` for terminal faults, `degraded` for a failure the next beat may clear. */
  status?: 'error' | 'degraded'
  hostId?: string | null
  health?: CloudHeartbeatHealth
  detail?: string | null
  now?: number
}

/** Design §4.2.7: persist the stable code and retryability before the process exits. */
export function writeHostModeFailureState(
  context: HostModeStateContext,
  input: HostModeFailureStateInput
): CloudHostState {
  const now = input.now ?? Date.now()
  const state: CloudHostState = {
    ...baseState(context, now),
    status: input.status ?? 'error',
    phase: input.phase,
    hostId: input.hostId ?? context.lastState?.hostId ?? null,
    registeredAt: context.lastState?.registeredAt ?? null,
    lastHeartbeatAt: input.health?.lastHeartbeatAt ?? null,
    lastHeartbeatOk: input.health?.lastHeartbeatOk ?? false,
    lastHeartbeatHttpStatus: input.health?.lastHeartbeatHttpStatus ?? null,
    lastErrorCode: input.code,
    lastErrorDetail: input.detail ?? null,
    retryable: input.retryable
  }
  return persist(context, state)
}

/** Startup failure path: the phase comes from where the failure was raised. */
export function recordHostModeEnrolmentFailure(
  context: HostModeStateContext,
  failure: { code: string; retryable: boolean; phase: CloudHostStatePhase },
  hostId: string | null = null
): CloudHostState {
  return writeHostModeFailureState(context, {
    code: failure.code,
    retryable: failure.retryable,
    phase: failure.phase,
    hostId
  })
}

/**
 * Watches post-online heartbeat verdicts. A rejected credential or a revoked host
 * is terminal: either would otherwise leave the host spinning forever.
 */
export function watchHostModeHeartbeat(input: {
  context: HostModeStateContext
  admission: HostModeAdmission
  onTerminal: (exitCode: number) => void
}): () => void {
  const client = input.admission.client
  if (!client?.onRefresh) {
    return () => {}
  }
  let terminal = false
  return client.onRefresh(() => {
    if (terminal || input.context.terminal) {
      return
    }
    const health = client.snapshot()
    const verdict = heartbeatVerdict(health)
    if (!verdict) {
      return
    }
    if (verdict.kind === 'failure' && verdict.fatal) {
      terminal = true
    }
    applyHostModeHeartbeatVerdict({
      context: input.context,
      admission: input.admission,
      health,
      onTerminal: input.onTerminal
    })
  })
}
