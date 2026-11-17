import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CLOUD_HOST_STATE_FILENAME,
  cloudHostStatePath,
  isCloudHostStateOnline,
  startingCloudHostState,
  writeStartingCloudHostState
} from './cloud-host-state'

describe('cloud host state file', () => {
  let dir: string
  let statePath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-cloud-host-state-'))
    statePath = cloudHostStatePath(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('derives the documented path inside the profile', () => {
    expect(statePath).toBe(join(dir, CLOUD_HOST_STATE_FILENAME))
    expect(CLOUD_HOST_STATE_FILENAME).toBe('orca-cloud-host-state.json')
  })

  it('starts in starting and clears the previous online state', () => {
    writeFileSync(
      statePath,
      JSON.stringify({
        schemaVersion: 2,
        status: 'online',
        phase: 'heartbeat',
        hostId: 'host_old',
        pid: 111,
        startedAt: 5,
        registeredAt: 6,
        lastHeartbeatAt: 7,
        lastHeartbeatOk: true,
        lastHeartbeatHttpStatus: 200,
        lastErrorCode: 'old_error',
        retryable: true
      })
    )

    writeStartingCloudHostState(statePath, { pid: 222, startedAt: 1_000, now: 1_001 })

    const state: unknown = JSON.parse(readFileSync(statePath, 'utf-8'))
    expect(state).toMatchObject({
      schemaVersion: 2,
      status: 'starting',
      phase: 'config',
      pid: 222,
      startedAt: 1_000,
      updatedAt: 1_001,
      hostId: null,
      registeredAt: null,
      lastHeartbeatAt: null,
      lastHeartbeatOk: false,
      lastHeartbeatHttpStatus: null,
      lastErrorCode: null,
      retryable: false
    })
    expect(isCloudHostStateOnline(startingCloudHostState({ pid: 222, startedAt: 1_000 }))).toBe(
      false
    )
  })

  it('writes atomically through a temp file and rename', () => {
    writeFileSync(statePath, JSON.stringify({ status: 'online', pid: 111 }))
    const before = statSync(statePath)
    if (process.platform !== 'win32') {
      expect(before.ino).toBeGreaterThan(0)
    }

    writeStartingCloudHostState(statePath, { pid: 333, startedAt: 2_000, now: 2_001 })

    expect(readdirSync(dir)).toEqual([CLOUD_HOST_STATE_FILENAME])
    expect(JSON.parse(readFileSync(statePath, 'utf-8'))).toMatchObject({ pid: 333 })
    // A rename publishes a new inode; a direct overwrite would keep the old one.
    if (process.platform !== 'win32') {
      expect(statSync(statePath).ino).not.toBe(before.ino)
    }
  })

  it('accepts online only when the last heartbeat succeeded', () => {
    const state = {
      ...startingCloudHostState({ pid: 1, startedAt: 1, now: 1 }),
      status: 'online' as const,
      lastHeartbeatOk: true
    }
    expect(isCloudHostStateOnline(state)).toBe(true)
    expect(isCloudHostStateOnline({ ...state, status: 'degraded' })).toBe(false)
    expect(isCloudHostStateOnline({ ...state, lastHeartbeatOk: false })).toBe(false)
    expect(isCloudHostStateOnline({ ...state, lastHeartbeatOk: null })).toBe(false)
  })
})
