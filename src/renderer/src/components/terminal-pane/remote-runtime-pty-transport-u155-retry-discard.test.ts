/**
 * U155 retry/discard pins.
 *  - A recoverable first `terminal.create` failure must drop the gesture; the transport's own
 *    automatic retry re-enters connect() but must never replay a tap-semantics activate.
 *  - `!hostTabId`, `isReattach`, and non-cloud answers cannot select a host tab, so they must
 *    discard the mark instead of leaving it to expire.
 */
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import { TERMINAL_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
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

const ENV = 'cloud-u155'
const WORKTREE = 'repo-1::/worktrees/main'
const LOCAL_TAB_ID = '7c27ddf0-5e0a-4769-8cc5-ac4eefa8eed8'
const LOCAL_LEAF_ID = '3c224bda-5e6f-4f57-bce8-fd5872a80bbc'
const CREATED_HOST_TAB_ID = 'u155-host-tab'
const CREATED_HOST_LEAF_ID = 'u155-host-leaf'

function cloudEnvironment(): PublicKnownRuntimeEnvironment {
  return {
    id: ENV,
    name: 'u155 demo (cloud session)',
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    endpoints: [{ id: 'ws-1', kind: 'websocket', label: 'WebSocket', endpoint: 'ws://host' }],
    preferredEndpointId: 'ws-1',
    cloudProject: {
      projectId: 'proj-u155',
      projectKey: 'u155-demo',
      hostId: 'host-u155',
      registeredAt: 1
    }
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

async function markAndCreateTransport() {
  const { markUserInitiatedTerminalCreate } =
    await import('@/runtime/web-session-user-initiated-create')
  markUserInitiatedTerminalCreate(LOCAL_TAB_ID, undefined, ENV)
  const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
  const transport = createRemoteRuntimePtyTransport(ENV, {
    worktreeId: WORKTREE,
    tabId: LOCAL_TAB_ID,
    leafId: LOCAL_LEAF_ID,
    activate: true,
    userInitiated: true
  })
  return transport
}

describe('U155: retry and unusable create answers discard the gesture', () => {
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

  it('auto-retries passively after a failed create and leaves no mark behind', async () => {
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
        if (createAttempts === 1) {
          throw new Error('remote orca runtime is not connected')
        }
        return createResult({
          handle: 'remote-pty-u155',
          tabId: CREATED_HOST_TAB_ID,
          leafId: CREATED_HOST_LEAF_ID
        })
      }
      return { ok: true, result: {} }
    })

    const transport = await markAndCreateTransport()
    const connect = transport.connect({ url: '', callbacks: {} })
    await vi.advanceTimersByTimeAsync(2_000)
    await connect
    await vi.waitFor(() => expect(createAttempts).toBe(2))

    for (const params of activationParams()) {
      expect(
        params.materializeOnly,
        'a retried create is a mount, never a durable tap selection'
      ).toBe(true)
    }
    const { peekUserInitiatedTerminalCreate } =
      await import('@/runtime/web-session-user-initiated-create')
    expect(peekUserInitiatedTerminalCreate(LOCAL_TAB_ID)).toBe(false)
  })

  it.each([
    {
      name: 'create returns no host tab id',
      env: true,
      terminal: { handle: 'remote-pty-u155', leafId: CREATED_HOST_LEAF_ID }
    },
    {
      name: 'create answers a reattach',
      env: true,
      terminal: {
        handle: 'remote-pty-u155',
        tabId: CREATED_HOST_TAB_ID,
        leafId: CREATED_HOST_LEAF_ID,
        isReattach: true
      }
    },
    {
      name: 'the environment is not a cloud session',
      env: false,
      terminal: {
        handle: 'remote-pty-u155',
        tabId: CREATED_HOST_TAB_ID,
        leafId: CREATED_HOST_LEAF_ID
      }
    }
  ])('discards the mark when $name', async ({ env, terminal }) => {
    const { useAppStore } = await import('@/store')
    useAppStore.setState({ runtimeEnvironments: env ? [cloudEnvironment()] : [] })
    runtimeCall.mockImplementation(async (request: { method: string }) => {
      if (request.method === 'terminal.create') {
        return createResult(terminal)
      }
      return { ok: true, result: {} }
    })

    const transport = await markAndCreateTransport()
    await transport.connect({ url: '', callbacks: {} })

    const { peekUserInitiatedTerminalCreate } =
      await import('@/runtime/web-session-user-initiated-create')
    expect(peekUserInitiatedTerminalCreate(LOCAL_TAB_ID)).toBe(false)
    // Why: a discarded gesture must not leak a durable tap through any other activation (U157 P3-C).
    expect(activationParams()).toHaveLength(0)
  })
})
