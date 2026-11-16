/**
 * U138 phase 9: the pane transport's host-surface activation is a mount, not a tap. It still
 * carries user intent so a slept PTY can wake, but it must be marked materializeOnly so the
 * host never writes it back as the durable or per-device selection.
 */
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

const HOST_SURFACE_ATTACH_WINDOW_MS = 15_000

function pendingHostSessionSnapshot(): unknown {
  return {
    ok: true,
    result: {
      worktree: 'id:wt-1',
      publicationEpoch: 'epoch-1',
      snapshotVersion: 1,
      activeGroupId: null,
      activeTabId: 'host-tab-1::leaf-1',
      activeTabType: 'terminal',
      tabs: [
        {
          type: 'terminal',
          id: 'host-tab-1::leaf-1',
          parentTabId: 'host-tab-1',
          leafId: 'leaf-1',
          title: 'Terminal 1',
          isActive: true,
          status: 'pending-handle',
          terminal: null
        }
      ]
    }
  }
}

describe('host-surface activation is marked materializeOnly', () => {
  beforeEach(() => {
    resetRemoteRuntimeTransport()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends materializeOnly on every mirror-attach activation', async () => {
    runtimeCall.mockImplementation((request: { method: string }) =>
      Promise.resolve(
        request.method === 'session.tabs.activate' || request.method === 'session.tabs.list'
          ? pendingHostSessionSnapshot()
          : { ok: true, result: {} }
      )
    )
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: 'leaf-1'
    })

    const connect = transport.connect({ url: '', callbacks: {} })
    await vi.advanceTimersByTimeAsync(HOST_SURFACE_ATTACH_WINDOW_MS)
    await expect(connect).resolves.toBeUndefined()

    const activations = runtimeCall.mock.calls
      .filter((call) => call[0]?.method === 'session.tabs.activate')
      .map((call) => call[0]?.params)
    expect(activations.length).toBeGreaterThan(0)
    for (const params of activations) {
      expect(params.materializeOnly).toBe(true)
      expect(params.navigation).toBe('caller')
      expect(params.notifyClients).toBe(false)
    }
  })
})
