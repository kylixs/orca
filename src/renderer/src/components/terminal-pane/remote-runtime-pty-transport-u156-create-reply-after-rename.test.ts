/**
 * U156 race pin: a cloud-session "New tab" create can answer after the mirror sync renamed the
 * local tab (`web-terminal-<uuid>`), which unmounts/destroys the transport that owns the click.
 * The gesture must still be replayed as a tap-semantics `session.tabs.activate`, or the surviving
 * mirror pane only materializes and the host keeps the previous tab selected forever.
 */
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'

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

const ENV = 'cloud-u156'
const WORKTREE = 'repo-1::/worktrees/main'
const LOCAL_TAB_ID = '7c27ddf0-5e0a-4769-8cc5-ac4eefa8eed8'
const LOCAL_LEAF_ID = '3c224bda-5e6f-4f57-bce8-fd5872a80bbc'
const CREATED_HOST_TAB_ID = 'u156-host-tab'
const CREATED_HOST_LEAF_ID = 'u156-host-leaf'

function cloudEnvironment(): PublicKnownRuntimeEnvironment {
  return {
    id: ENV,
    name: 'u156 demo (cloud session)',
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    endpoints: [{ id: 'ws-1', kind: 'websocket', label: 'WebSocket', endpoint: 'ws://host' }],
    preferredEndpointId: 'ws-1',
    cloudProject: {
      projectId: 'proj-u156',
      projectKey: 'u156-demo',
      hostId: 'host-u156',
      registeredAt: 1
    }
  }
}

function activationParams(): Record<string, unknown>[] {
  return runtimeCall.mock.calls
    .filter((call) => call[0]?.method === 'session.tabs.activate')
    .map((call) => call[0]?.params ?? {})
}

function tapActivations(): Record<string, unknown>[] {
  return activationParams().filter((params) => params.materializeOnly !== true)
}

type DeferredCreate = {
  resolve: () => void
}

/** Holds `terminal.create` open so the test can rename/tear down the tab before it answers. */
function deferCreate(terminal: Record<string, unknown>): DeferredCreate {
  let resolve: ((value: unknown) => void) | undefined
  runtimeCall.mockImplementation((request: { method: string }) => {
    if (request.method === 'terminal.create') {
      return new Promise((settle) => {
        resolve = (value) => settle(value)
      })
    }
    return Promise.resolve({ ok: true, result: {} })
  })
  return {
    resolve: () => {
      if (!resolve) {
        throw new Error('terminal.create was never issued')
      }
      resolve({ ok: true, result: { terminal } })
    }
  }
}

async function startUserInitiatedConnect(options: { userInitiated?: boolean } = {}) {
  const { markUserInitiatedTerminalCreate } =
    await import('@/runtime/web-session-user-initiated-create')
  if (options.userInitiated !== false) {
    markUserInitiatedTerminalCreate(LOCAL_TAB_ID, undefined, ENV)
  }
  const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
  const transport = createRemoteRuntimePtyTransport(ENV, {
    worktreeId: WORKTREE,
    tabId: LOCAL_TAB_ID,
    leafId: LOCAL_LEAF_ID,
    activate: true,
    ...(options.userInitiated === false ? {} : { userInitiated: true })
  })
  const connect = transport.connect({ url: '', callbacks: {} })
  await vi.waitFor(() => expect(runtimeCall).toHaveBeenCalled())
  return { transport, connect }
}

describe('U156: a create answer that lands after the tab rename still taps the host', () => {
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

  it.each([
    { teardown: 'destroy', name: 'transport destroyed by the rename unmount' },
    { teardown: 'detach', name: 'transport detached by the rename handoff' }
  ])('pins U156: $name still sends the tap activate', async ({ teardown }) => {
    const create = deferCreate({
      handle: 'remote-pty-u156',
      tabId: CREATED_HOST_TAB_ID,
      leafId: CREATED_HOST_LEAF_ID
    })
    const { transport, connect } = await startUserInitiatedConnect()
    await vi.waitFor(() =>
      expect(runtimeCall.mock.calls.some((c) => c[0]?.method === 'terminal.create')).toBe(true)
    )

    if (teardown === 'destroy') {
      transport.destroy?.()
    } else {
      transport.detach?.()
    }
    create.resolve()

    await connect
    await vi.waitFor(() => expect(tapActivations().length).toBeGreaterThan(0), { timeout: 1_000 })

    expect(tapActivations()[0]).toMatchObject({
      tabId: CREATED_HOST_TAB_ID,
      leafId: CREATED_HOST_LEAF_ID,
      intent: 'user',
      navigation: 'caller',
      notifyClients: false
    })
    const { peekUserInitiatedTerminalCreate } =
      await import('@/runtime/web-session-user-initiated-create')
    expect(peekUserInitiatedTerminalCreate(LOCAL_TAB_ID)).toBe(false)
  })

  it('negative control: a passive mount that loses its transport never taps', async () => {
    const create = deferCreate({
      handle: 'remote-pty-u156-passive',
      tabId: CREATED_HOST_TAB_ID,
      leafId: CREATED_HOST_LEAF_ID
    })
    const { transport, connect } = await startUserInitiatedConnect({ userInitiated: false })
    await vi.waitFor(() =>
      expect(runtimeCall.mock.calls.some((c) => c[0]?.method === 'terminal.create')).toBe(true)
    )

    transport.destroy?.()
    create.resolve()
    await connect

    expect(tapActivations()).toHaveLength(0)
  })

  it('negative control: a reattach answer that loses its transport never taps and drops the mark', async () => {
    const create = deferCreate({
      handle: 'remote-pty-u156-reattach',
      tabId: CREATED_HOST_TAB_ID,
      leafId: CREATED_HOST_LEAF_ID,
      isReattach: true
    })
    const { transport, connect } = await startUserInitiatedConnect()
    await vi.waitFor(() =>
      expect(runtimeCall.mock.calls.some((c) => c[0]?.method === 'terminal.create')).toBe(true)
    )

    transport.destroy?.()
    create.resolve()
    await connect

    expect(tapActivations()).toHaveLength(0)
    const { peekUserInitiatedTerminalCreate } =
      await import('@/runtime/web-session-user-initiated-create')
    expect(peekUserInitiatedTerminalCreate(LOCAL_TAB_ID)).toBe(false)
  })
})
