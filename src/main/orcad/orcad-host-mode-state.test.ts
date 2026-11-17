import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cloudHostStatePath, isCloudHostStateOnline } from '../startup/cloud-host-state'
import type { CloudHeartbeatHealth } from '../cloud-platform/cloud-heartbeat-health'
import {
  beginHostModeState,
  publishHostModeOnlineWhenReady,
  watchHostModeHeartbeat,
  writeHostModeOnlineState,
  type HostModeAdmission
} from './orcad-host-mode-state'

const OK_HEALTH: CloudHeartbeatHealth = {
  lastHeartbeatAt: 1_700_000_000_000,
  lastHeartbeatOk: true,
  lastHeartbeatHttpStatus: 200,
  lastErrorCode: null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readState(statePath: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(statePath, 'utf-8'))
  if (!isRecord(parsed)) {
    throw new Error('host state file is not an object')
  }
  return parsed
}

function admission(health: CloudHeartbeatHealth, ready = Promise.resolve()): HostModeAdmission {
  return {
    ready,
    client: { snapshot: () => health },
    host: () => ({ hostId: 'host_123' })
  }
}

describe('host mode state file', () => {
  let dir: string
  let statePath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-host-mode-state-'))
    statePath = cloudHostStatePath(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes starting with the new pid and startedAt before any heartbeat can complete', async () => {
    let seenBeforeHeartbeat: unknown = null
    const ready = Promise.resolve().then(() => {
      seenBeforeHeartbeat = readState(statePath).status
    })
    const context = beginHostModeState({
      userDataPath: dir,
      pid: 4321,
      startedAt: 1_700_000_000_000,
      hostName: 'host-a',
      platformUrl: 'https://cloud.example.com',
      now: 1_700_000_000_001
    })

    const state = readState(statePath)
    expect(state).toMatchObject({
      status: 'starting',
      pid: 4321,
      startedAt: 1_700_000_000_000
    })

    await publishHostModeOnlineWhenReady(context, admission(OK_HEALTH, ready))
    expect(seenBeforeHeartbeat).toBe('starting')
  })

  it('publishes online only after the first heartbeat succeeds, with its verdict fields', async () => {
    const context = beginHostModeState({
      userDataPath: dir,
      pid: 1,
      startedAt: 2,
      hostName: 'host-a',
      platformUrl: 'https://cloud.example.com'
    })

    const online = await publishHostModeOnlineWhenReady(context, admission(OK_HEALTH))

    expect(online).not.toBeNull()
    expect(isCloudHostStateOnline(online!)).toBe(true)
    const persisted: unknown = JSON.parse(readFileSync(statePath, 'utf-8'))
    expect(persisted).toMatchObject({
      status: 'online',
      phase: 'heartbeat',
      hostId: 'host_123',
      lastHeartbeatAt: OK_HEALTH.lastHeartbeatAt,
      lastHeartbeatOk: true,
      lastHeartbeatHttpStatus: 200,
      lastErrorCode: null,
      pid: 1,
      startedAt: 2
    })
  })

  it('leaves starting when the first heartbeat failed', async () => {
    const context = beginHostModeState({ userDataPath: dir, pid: 1, startedAt: 2 })
    const failed = { ...OK_HEALTH, lastHeartbeatAt: null, lastHeartbeatOk: false }

    const online = await publishHostModeOnlineWhenReady(context, admission(failed))

    expect(online).toBeNull()
    expect(readState(statePath).status).toBe('starting')
  })

  it('does not publish online without a heartbeat verdict', () => {
    const context = beginHostModeState({ userDataPath: dir, pid: 1, startedAt: 2 })

    const direct = writeHostModeOnlineState(context, {
      hostId: 'host_123',
      health: { ...OK_HEALTH, lastHeartbeatOk: null }
    })

    expect(direct).toBeNull()
    expect(readState(statePath).status).toBe('starting')
  })
})

describe('host mode heartbeat watcher', () => {
  let dir: string
  let statePath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-host-mode-watch-'))
    statePath = cloudHostStatePath(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function watch(initial: CloudHeartbeatHealth) {
    let health = initial
    const listeners = new Set<() => void>()
    const admission = {
      ready: Promise.resolve(),
      client: {
        snapshot: () => health,
        onRefresh: (listener: () => void) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        }
      },
      host: () => ({ hostId: 'host_123' })
    }
    const context = beginHostModeState({
      userDataPath: dir,
      pid: 9,
      startedAt: 10,
      hostName: 'host-a',
      platformUrl: 'https://cloud.example.com'
    })
    const onTerminal = vi.fn()
    const unwatch = watchHostModeHeartbeat({ context, admission, onTerminal })
    return {
      onTerminal,
      beat(next: CloudHeartbeatHealth) {
        health = next
        for (const listener of listeners) {
          listener()
        }
      },
      listeners: () => listeners.size,
      unwatch
    }
  }

  it('writes the terminal verdict and reports exit 78 on a sustained 401', () => {
    const watcher = watch(OK_HEALTH)

    watcher.beat({
      lastHeartbeatAt: OK_HEALTH.lastHeartbeatAt,
      lastHeartbeatOk: false,
      lastHeartbeatHttpStatus: 401,
      lastErrorCode: 'heartbeat_unauthorized'
    })
    watcher.beat({
      lastHeartbeatAt: OK_HEALTH.lastHeartbeatAt,
      lastHeartbeatOk: false,
      lastHeartbeatHttpStatus: 401,
      lastErrorCode: 'heartbeat_unauthorized'
    })

    expect(watcher.onTerminal).toHaveBeenCalledExactlyOnceWith(78)
    expect(readState(statePath)).toMatchObject({
      status: 'error',
      phase: 'heartbeat',
      hostId: 'host_123',
      lastHeartbeatOk: false,
      lastHeartbeatHttpStatus: 401,
      lastErrorCode: 'heartbeat_unauthorized',
      retryable: false
    })
  })

  it('keeps a retryable heartbeat failure degraded and running', () => {
    const watcher = watch(OK_HEALTH)

    watcher.beat({
      lastHeartbeatAt: OK_HEALTH.lastHeartbeatAt,
      lastHeartbeatOk: false,
      lastHeartbeatHttpStatus: 503,
      lastErrorCode: 'heartbeat_failed'
    })

    expect(watcher.onTerminal).not.toHaveBeenCalled()
    expect(readState(statePath)).toMatchObject({
      status: 'degraded',
      phase: 'heartbeat',
      lastErrorCode: 'heartbeat_failed',
      retryable: true
    })
  })

  it('leaves the online verdict untouched when a beat succeeds', () => {
    const watcher = watch(OK_HEALTH)
    const context = beginHostModeState({ userDataPath: dir, pid: 9, startedAt: 10 })
    writeHostModeOnlineState(context, { hostId: 'host_123', health: OK_HEALTH })

    watcher.beat(OK_HEALTH)

    expect(watcher.onTerminal).not.toHaveBeenCalled()
    expect(readState(statePath).status).toBe('online')
  })

  it('stops observing after unsubscribe', () => {
    const watcher = watch(OK_HEALTH)
    watcher.unwatch()

    expect(watcher.listeners()).toBe(0)
  })
})
