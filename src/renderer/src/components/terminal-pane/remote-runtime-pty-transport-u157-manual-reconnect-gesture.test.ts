/**
 * U157 pins.
 *  - P2-A: a transport-level connect() replay after a failed create stays passive (no tap).
 *  - P2-B: every failure/abort discard site drops the gesture (lost outcome, aborted reply, throw).
 *  - P3-C: a discarded gesture never yields a non-materialize `session.tabs.activate`.
 *  - P3-D: an explicit Reconnect re-arms the gesture once and its reconciled create taps.
 */
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import { TERMINAL_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'
import { REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS } from './remote-runtime-pty-recovery-state'

let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null
let resolvedPaneHandle = 'terminal-1'

const { runtimeCall, resetRemoteRuntimeTransport } = createRemoteRuntimeTransportMocks({
  getCallbacks: () => subscriptionCallbacks,
  setCallbacks: (callbacks) => {
    subscriptionCallbacks = callbacks
  },
  getResolvedPaneHandle: () => resolvedPaneHandle,
  setResolvedPaneHandle: (handle) => {
    resolvedPaneHandle = handle
  }
})

const ENV = 'cloud-u157'
const WORKTREE = 'repo-1::/worktrees/main'
const LOCAL_TAB_ID = '7c27ddf0-5e0a-4769-8cc5-ac4eefa8eed8'
const LOCAL_LEAF_ID = '3c224bda-5e6f-4f57-bce8-fd5872a80bbc'
const CREATED_HOST_TAB_ID = 'u157-host-tab'
const CREATED_HOST_LEAF_ID = 'u157-host-leaf'

function cloudEnvironment(): PublicKnownRuntimeEnvironment {
  return {
    id: ENV,
    name: 'u157 demo (cloud session)',
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    endpoints: [{ id: 'ws-1', kind: 'websocket', label: 'WebSocket', endpoint: 'ws://host' }],
    preferredEndpointId: 'ws-1',
    cloudProject: {
      projectId: 'proj-u157',
      projectKey: 'u157-demo',
      hostId: 'host-u157',
      registeredAt: 1
    }
  }
}

function createdTerminal(): Record<string, unknown> {
  return {
    handle: 'remote-pty-u157',
    tabId: CREATED_HOST_TAB_ID,
    leafId: CREATED_HOST_LEAF_ID
  }
}

function createResult(terminal: Record<string, unknown>): unknown {
  return { ok: true, result: { terminal } }
}

function activationParams(): Record<string, unknown>[] {
  return runtimeCall.mock.calls
    .filter((call) => call[0]?.method === 'session.tabs.activate')
    .map((call) => call[0]?.params ?? {})
}

function tapActivations(): Record<string, unknown>[] {
  return activationParams().filter((params) => params.materializeOnly !== true)
}

async function peekMark(): Promise<boolean> {
  const { peekUserInitiatedTerminalCreate } =
    await import('@/runtime/web-session-user-initiated-create')
  return peekUserInitiatedTerminalCreate(LOCAL_TAB_ID)
}

async function createUserInitiatedTransport() {
  const { markUserInitiatedTerminalCreate } =
    await import('@/runtime/web-session-user-initiated-create')
  markUserInitiatedTerminalCreate(LOCAL_TAB_ID)
  const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
  return createRemoteRuntimePtyTransport(ENV, {
    worktreeId: WORKTREE,
    tabId: LOCAL_TAB_ID,
    leafId: LOCAL_LEAF_ID,
    activate: true,
    userInitiated: true
  })
}

describe('U157: manual reconnect re-arms the gesture; automatic replays stay passive', () => {
  beforeEach(async () => {
    resetRemoteRuntimeTransport()
    const { useAppStore } = await import('@/store')
    useAppStore.setState({ runtimeEnvironments: [cloudEnvironment()] })
  })

  afterEach(async () => {
    vi.useRealTimers()
    const { clearUserInitiatedTerminalCreateForTests } =
      await import('@/runtime/web-session-user-initiated-create')
    clearUserInitiatedTerminalCreateForTests()
  })

  it('P2-A: a connect() replay after a failed create never taps', async () => {
    let createAttempts = 0
    runtimeCall.mockImplementation(async (request: { method: string }) => {
      if (request.method === 'terminal.create') {
        createAttempts += 1
        if (createAttempts === 1) {
          throw new Error('u157 create failed')
        }
        return createResult(createdTerminal())
      }
      return { ok: true, result: {} }
    })

    const transport = await createUserInitiatedTransport()
    await expect(transport.connect({ url: '', callbacks: {} })).resolves.toBeUndefined()
    expect(await peekMark(), 'the failed create must not leave the gesture behind').toBe(false)

    const replay = await transport.connect({ url: '', callbacks: {} })
    expect(replay).toBeDefined()
    expect(transport.getPtyId()).toBe('remote:cloud-u157@@remote-pty-u157')
    expect(tapActivations(), 'a transport-level replay is a mount, never a tap').toHaveLength(0)
    expect(activationParams().every((params) => params.materializeOnly === true)).toBe(true)
    transport.destroy?.()
  })

  it('P2-B: discards the gesture when the create outcome is lost', async () => {
    let createIssued = false
    let rejectCreate: ((error: unknown) => void) | undefined
    runtimeCall.mockImplementation((request: { method: string }) => {
      if (request.method === 'terminal.create') {
        createIssued = true
        return new Promise((_resolve, reject) => {
          rejectCreate = reject
        })
      }
      return Promise.resolve({ ok: true, result: {} })
    })

    const transport = await createUserInitiatedTransport()
    const connect = transport.connect({ url: '', callbacks: {} })
    await vi.waitFor(() => expect(createIssued).toBe(true))
    transport.destroy?.()
    rejectCreate?.(
      Object.assign(new Error('remote orca runtime is not connected'), {
        code: 'remote_runtime_unavailable'
      })
    )
    await connect

    expect(await peekMark()).toBe(false)
    expect(tapActivations()).toHaveLength(0)
  })

  it('P2-B: discards the gesture when an aborted create answers a reattach', async () => {
    let resolveCreate: (() => void) | undefined
    runtimeCall.mockImplementation((request: { method: string }) => {
      if (request.method === 'terminal.create') {
        return new Promise((resolve) => {
          resolveCreate = () => resolve(createResult({ ...createdTerminal(), isReattach: true }))
        })
      }
      return Promise.resolve({ ok: true, result: {} })
    })

    const transport = await createUserInitiatedTransport()
    const connect = transport.connect({ url: '', callbacks: {} })
    await vi.waitFor(() => expect(resolveCreate).toBeDefined())
    transport.destroy?.()
    resolveCreate?.()
    await connect

    expect(await peekMark()).toBe(false)
    expect(tapActivations()).toHaveLength(0)
  })

  it('P2-B: discards the gesture when the create throws', async () => {
    runtimeCall.mockImplementation(async (request: { method: string }) => {
      if (request.method === 'terminal.create') {
        throw new Error('u157 unrecoverable create failure')
      }
      return { ok: true, result: {} }
    })

    const transport = await createUserInitiatedTransport()
    await expect(transport.connect({ url: '', callbacks: {} })).resolves.toBeUndefined()

    expect(await peekMark()).toBe(false)
    expect(tapActivations()).toHaveLength(0)
  })

  it('U156 P2-1: a reconciled reply that lands after teardown never taps', async () => {
    vi.useFakeTimers()
    let createAttempts = 0
    let resolveReconciled: (() => void) | undefined
    runtimeCall.mockImplementation((request: { method: string }) => {
      if (request.method === 'status.get') {
        return Promise.resolve({
          ok: true,
          result: { capabilities: [TERMINAL_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY] }
        })
      }
      if (request.method === 'terminal.create') {
        createAttempts += 1
        if (createAttempts === 1) {
          return Promise.reject(new Error('remote orca runtime is not connected'))
        }
        return new Promise((resolve) => {
          resolveReconciled = () => resolve(createResult(createdTerminal()))
        })
      }
      return Promise.resolve({ ok: true, result: {} })
    })

    const transport = await createUserInitiatedTransport()
    const connect = transport.connect({ url: '', callbacks: {} })
    await vi.advanceTimersByTimeAsync(250)
    expect(createAttempts, 'the anonymous retry must issue the reconciled create').toBe(2)

    transport.destroy?.()
    resolveReconciled?.()
    await connect

    expect(await peekMark()).toBe(false)
    expect(
      tapActivations(),
      'a reconciled reply is a passive replay, not the original click'
    ).toHaveLength(0)
  })

  it('P3-D: an explicit Reconnect after the first create never landed taps once', async () => {
    vi.useFakeTimers()
    let createAttempts = 0
    runtimeCall.mockImplementation(async (request: { method: string }) => {
      if (request.method === 'status.get') {
        return {
          ok: true,
          result: { capabilities: [TERMINAL_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY] }
        }
      }
      if (request.method === 'terminal.create') {
        createAttempts += 1
        throw new Error('remote orca runtime is not connected')
      }
      return { ok: true, result: {} }
    })

    const transport = await createUserInitiatedTransport()
    const connect = transport.connect({ url: '', callbacks: {} })
    await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS + 60_000)
    await connect

    expect(createAttempts).toBeGreaterThan(1)
    expect(transport.getRecoveryState?.().phase).toBe('disconnected')
    expect(await peekMark()).toBe(false)
    expect(tapActivations()).toHaveLength(0)

    vi.useRealTimers()
    runtimeCall.mockImplementation(async (request: { method: string }) => {
      if (request.method === 'status.get') {
        return {
          ok: true,
          result: { capabilities: [TERMINAL_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY] }
        }
      }
      if (request.method === 'terminal.create') {
        return createResult(createdTerminal())
      }
      return { ok: true, result: {} }
    })

    expect(transport.retryRecovery?.(), 'the Reconnect button must start a replay').toBe(true)
    await vi.waitFor(() => expect(tapActivations()).toHaveLength(1), { timeout: 1_000 })
    expect(tapActivations()[0]).toMatchObject({
      tabId: CREATED_HOST_TAB_ID,
      leafId: CREATED_HOST_LEAF_ID,
      intent: 'user',
      navigation: 'caller',
      notifyClients: false
    })
    expect(await peekMark()).toBe(false)
    transport.destroy?.()
  })
})
