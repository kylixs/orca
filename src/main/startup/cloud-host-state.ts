import { join } from 'node:path'
import { writeDurableSecureJsonFile } from '../../shared/secure-file'

/**
 * Host-mode readiness file (design U181 §4.2). The installer reads this file
 * instead of logs or `/health`; a stale `online` from a previous process must
 * never satisfy it, so startup rewrites `starting` before any network request.
 */

export const CLOUD_HOST_STATE_FILENAME = 'orca-cloud-host-state.json'
export const CLOUD_HOST_STATE_SCHEMA_VERSION = 2

export type CloudHostStateStatus =
  | 'starting'
  | 'enrolling'
  | 'registered'
  | 'online'
  | 'degraded'
  | 'error'
  | 'stopped'

export type CloudHostStatePhase = 'config' | 'runtime' | 'enrolment' | 'heartbeat' | 'serving'

/** Schema v2; never carries a credential or host token. */
export type CloudHostState = {
  schemaVersion: typeof CLOUD_HOST_STATE_SCHEMA_VERSION
  status: CloudHostStateStatus
  phase: CloudHostStatePhase
  hostId: string | null
  hostName: string | null
  platformUrl: string | null
  pid: number
  startedAt: number
  registeredAt: number | null
  lastHeartbeatAt: number | null
  lastHeartbeatOk: boolean | null
  lastHeartbeatHttpStatus: number | null
  lastErrorCode: string | null
  lastErrorDetail: string | null
  retryable: boolean
  updatedAt: number
}

export type CloudHostStateSeed = {
  pid: number
  startedAt: number
  hostName?: string | null
  platformUrl?: string | null
  now?: number
}

export function cloudHostStatePath(userDataPath: string): string {
  return join(userDataPath, CLOUD_HOST_STATE_FILENAME)
}

export function startingCloudHostState(seed: CloudHostStateSeed): CloudHostState {
  return {
    schemaVersion: CLOUD_HOST_STATE_SCHEMA_VERSION,
    status: 'starting',
    phase: 'config',
    hostId: null,
    hostName: seed.hostName ?? null,
    platformUrl: seed.platformUrl ?? null,
    pid: seed.pid,
    startedAt: seed.startedAt,
    registeredAt: null,
    lastHeartbeatAt: null,
    lastHeartbeatOk: false,
    lastHeartbeatHttpStatus: null,
    lastErrorCode: null,
    lastErrorDetail: null,
    retryable: false,
    updatedAt: seed.now ?? Date.now()
  }
}

/** Startup write: a new pid/startedAt invalidates the previous process's `online`. */
export function writeStartingCloudHostState(
  statePath: string,
  seed: CloudHostStateSeed
): CloudHostState {
  const state = startingCloudHostState(seed)
  writeCloudHostState(statePath, state)
  return state
}

/** Atomic (temp file + fsync + rename), 0600, 0700 directory. */
export function writeCloudHostState(statePath: string, state: CloudHostState): void {
  writeDurableSecureJsonFile(statePath, state)
}

/** Online is a heartbeat verdict, not a registration or refresh timestamp. */
export function isCloudHostStateOnline(state: CloudHostState): boolean {
  return state.status === 'online' && state.lastHeartbeatOk === true
}
