import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { cloudHostStatePath } from '../startup/cloud-host-state'
import type { CloudHeartbeatHealth } from '../cloud-platform/cloud-heartbeat-health'
import {
  beginHostModeState,
  publishHostModeInitialStateWhenReady,
  watchHostModeHeartbeat,
  type HostModeAdmission
} from './orcad-host-mode-state'
import { createHostModeFatalRelay } from './orcad-host-mode-startup'

const STARTED_AT = 1_700_000_000_000
const OK: CloudHeartbeatHealth = {
  lastHeartbeatAt: STARTED_AT + 1_000,
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

function onlineEvents(spy: MockInstance): Record<string, unknown>[] {
  return spy.mock.calls
    .map((call) => {
      try {
        const parsed: unknown = JSON.parse(String(call[0]))
        return isRecord(parsed) && parsed.event === 'orca_host_online' ? parsed : null
      } catch {
        return null
      }
    })
    .filter((event): event is Record<string, unknown> => event !== null)
}

function createHarness(
  initial: CloudHeartbeatHealth = {
    lastHeartbeatAt: null,
    lastHeartbeatOk: null,
    lastHeartbeatHttpStatus: null,
    lastErrorCode: null
  }
) {
  let health = initial
  let resolveReady: () => void = () => {}
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })
  const listeners = new Set<() => void>()
  const admission: HostModeAdmission = {
    ready,
    client: {
      snapshot: () => health,
      onRefresh: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    },
    host: () => ({ hostId: 'host_123' })
  }
  return {
    admission,
    readyNow: () => resolveReady(),
    /** The first beat happens before `ready` resolves; later beats notify listeners. */
    beat(next: CloudHeartbeatHealth) {
      health = next
      for (const listener of listeners) {
        listener()
      }
    }
  }
}

describe('orcad host-mode heartbeat lifecycle', () => {
  let dir: string
  let statePath: string
  let logSpy: MockInstance

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-host-lifecycle-'))
    statePath = cloudHostStatePath(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
  })

  it('walks starting → online → degraded → online → error with exit 78', async () => {
    const context = beginHostModeState({
      userDataPath: dir,
      pid: 4321,
      startedAt: STARTED_AT,
      hostName: 'host-a',
      platformUrl: 'https://cloud.example.com'
    })
    const harness = createHarness(OK)
    const onTerminal = vi.fn()
    const statuses: unknown[] = []

    statuses.push(readState(statePath).status)

    harness.readyNow()
    await publishHostModeInitialStateWhenReady(context, harness.admission, onTerminal)
    statuses.push(readState(statePath).status)

    const unwatch = watchHostModeHeartbeat({
      context,
      admission: harness.admission,
      onTerminal
    })

    harness.beat({
      lastHeartbeatAt: OK.lastHeartbeatAt,
      lastHeartbeatOk: false,
      lastHeartbeatHttpStatus: 503,
      lastErrorCode: 'heartbeat_failed'
    })
    statuses.push(readState(statePath).status)
    expect(onTerminal).not.toHaveBeenCalled()

    const recovered = STARTED_AT + 11_000
    harness.beat({ ...OK, lastHeartbeatAt: recovered })
    statuses.push(readState(statePath).status)

    harness.beat({
      lastHeartbeatAt: recovered,
      lastHeartbeatOk: false,
      lastHeartbeatHttpStatus: 401,
      lastErrorCode: 'heartbeat_unauthorized'
    })
    statuses.push(readState(statePath).status)

    // A duplicate terminal beat must not stop the process twice.
    harness.beat({
      lastHeartbeatAt: recovered,
      lastHeartbeatOk: false,
      lastHeartbeatHttpStatus: 401,
      lastErrorCode: 'heartbeat_unauthorized'
    })

    expect(statuses).toEqual(['starting', 'online', 'degraded', 'online', 'error'])
    expect(onTerminal).toHaveBeenCalledExactlyOnceWith(78)
    expect(readState(statePath)).toMatchObject({
      status: 'error',
      phase: 'heartbeat',
      hostId: 'host_123',
      pid: 4321,
      startedAt: STARTED_AT,
      lastHeartbeatAt: recovered,
      lastHeartbeatOk: false,
      lastHeartbeatHttpStatus: 401,
      lastErrorCode: 'heartbeat_unauthorized',
      retryable: false
    })
    unwatch()
  })

  it('persists degraded when the first heartbeat fails retryably', async () => {
    const context = beginHostModeState({ userDataPath: dir, pid: 1, startedAt: 2 })
    const harness = createHarness({
      lastHeartbeatAt: null,
      lastHeartbeatOk: false,
      lastHeartbeatHttpStatus: 503,
      lastErrorCode: 'heartbeat_failed'
    })
    const onTerminal = vi.fn()

    harness.readyNow()
    const state = await publishHostModeInitialStateWhenReady(context, harness.admission, onTerminal)

    expect(state?.status).toBe('degraded')
    expect(onTerminal).not.toHaveBeenCalled()
    expect(readState(statePath)).toMatchObject({
      status: 'degraded',
      phase: 'heartbeat',
      lastHeartbeatOk: false,
      lastHeartbeatHttpStatus: 503,
      lastErrorCode: 'heartbeat_failed',
      retryable: true
    })
  })

  it('persists error and reports exit 78 when the first heartbeat is rejected', async () => {
    const context = beginHostModeState({ userDataPath: dir, pid: 1, startedAt: 2 })
    const harness = createHarness({
      lastHeartbeatAt: null,
      lastHeartbeatOk: false,
      lastHeartbeatHttpStatus: 409,
      lastErrorCode: 'host_revoked'
    })
    const onTerminal = vi.fn()

    harness.readyNow()
    await publishHostModeInitialStateWhenReady(context, harness.admission, onTerminal)

    expect(onTerminal).toHaveBeenCalledExactlyOnceWith(78)
    expect(readState(statePath)).toMatchObject({
      status: 'error',
      phase: 'heartbeat',
      hostId: 'host_123',
      lastHeartbeatHttpStatus: 409,
      lastErrorCode: 'host_revoked',
      retryable: false
    })
  })

  it('does not let a failed initial beat erase a later online verdict', async () => {
    const context = beginHostModeState({ userDataPath: dir, pid: 1, startedAt: 2 })
    const harness = createHarness({
      lastHeartbeatAt: null,
      lastHeartbeatOk: false,
      lastHeartbeatHttpStatus: 503,
      lastErrorCode: 'heartbeat_failed'
    })

    harness.readyNow()
    await publishHostModeInitialStateWhenReady(context, harness.admission)
    const unwatch = watchHostModeHeartbeat({
      context,
      admission: harness.admission,
      onTerminal: vi.fn()
    })
    harness.beat(OK)

    expect(readState(statePath)).toMatchObject({
      status: 'online',
      lastHeartbeatOk: true,
      lastErrorCode: null
    })
    unwatch()
  })

  it('logs orca_host_online once per transition into online, not once per successful beat', async () => {
    const context = beginHostModeState({
      userDataPath: dir,
      pid: 4321,
      startedAt: STARTED_AT,
      hostName: 'host-a',
      platformUrl: 'https://cloud.example.com'
    })
    const harness = createHarness(OK)
    harness.readyNow()
    await publishHostModeInitialStateWhenReady(context, harness.admission)
    const unwatch = watchHostModeHeartbeat({
      context,
      admission: harness.admission,
      onTerminal: vi.fn()
    })

    harness.beat({ ...OK, lastHeartbeatAt: STARTED_AT + 11_000 })
    harness.beat({ ...OK, lastHeartbeatAt: STARTED_AT + 21_000 })

    expect(onlineEvents(logSpy)).toEqual([
      {
        event: 'orca_host_online',
        hostId: 'host_123',
        platformUrl: 'https://cloud.example.com',
        lastHeartbeatAt: STARTED_AT + 1_000
      }
    ])
    unwatch()
  })

  it('logs again after a degraded host recovers to online', async () => {
    const context = beginHostModeState({
      userDataPath: dir,
      pid: 4321,
      startedAt: STARTED_AT,
      hostName: 'host-a',
      platformUrl: 'https://cloud.example.com'
    })
    const harness = createHarness(OK)
    harness.readyNow()
    await publishHostModeInitialStateWhenReady(context, harness.admission)
    const unwatch = watchHostModeHeartbeat({
      context,
      admission: harness.admission,
      onTerminal: vi.fn()
    })

    harness.beat({
      lastHeartbeatAt: OK.lastHeartbeatAt,
      lastHeartbeatOk: false,
      lastHeartbeatHttpStatus: 503,
      lastErrorCode: 'heartbeat_failed'
    })
    expect(onlineEvents(logSpy)).toHaveLength(1)

    const recovered = STARTED_AT + 31_000
    harness.beat({ ...OK, lastHeartbeatAt: recovered })

    const events = onlineEvents(logSpy)
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({
      event: 'orca_host_online',
      hostId: 'host_123',
      platformUrl: 'https://cloud.example.com',
      lastHeartbeatAt: recovered
    })
    unwatch()
  })
})

describe('host-mode fatal relay', () => {
  it('delivers a terminal verdict that arrives before the entry registers', () => {
    const relay = createHostModeFatalRelay()
    const listener = vi.fn()

    relay.notify(78)
    relay.register(listener)

    expect(listener).toHaveBeenCalledExactlyOnceWith(78)
  })

  it('delivers a later verdict once to the registered listener', () => {
    const relay = createHostModeFatalRelay()
    const listener = vi.fn()

    relay.register(listener)
    relay.notify(78)

    expect(listener).toHaveBeenCalledExactlyOnceWith(78)
  })
})
