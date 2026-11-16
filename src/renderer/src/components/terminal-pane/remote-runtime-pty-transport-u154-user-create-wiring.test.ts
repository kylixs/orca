/**
 * U154 wiring pin: a user click must reach the PTY transport as `userInitiated` through the
 * ledger, not by the test injecting the flag. The pin runs the real store action that creates
 * the cloud tab, then the real pane-option builder, then the transport, and asserts:
 *   mark -> peek -> option -> tap-semantics activate -> consume.
 * A passive mount of an unmarked tab is the negative control in the sibling entries spec.
 */
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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

const ENV = 'cloud-u154'
const WORKTREE = 'repo-1::/worktrees/main'
const GROUP_ID = 'group-u154'
const CREATED_HOST_TAB_ID = 'u154-host-tab'
const CREATED_HOST_LEAF_ID = 'u154-host-leaf'

function cloudEnvironment(): PublicKnownRuntimeEnvironment {
  return {
    id: ENV,
    name: 'u154 demo (cloud session)',
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    endpoints: [
      {
        id: 'ws-1',
        kind: 'websocket',
        label: 'WebSocket',
        endpoint: 'ws://host'
      }
    ],
    preferredEndpointId: 'ws-1',
    cloudProject: {
      projectId: 'proj-u154',
      projectKey: 'u154-demo',
      hostId: 'host-u154',
      registeredAt: 1
    }
  }
}

function activationParams(): Record<string, unknown>[] {
  return runtimeCall.mock.calls
    .filter((call) => call[0]?.method === 'session.tabs.activate')
    .map((call) => call[0]?.params ?? {})
}

describe('U154: click -> ledger -> transport option -> host selection', () => {
  beforeEach(() => {
    resetRemoteRuntimeTransport()
    // Why: the store action schedules a DOM focus; this pin judges the wire, so park the frame.
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
  })

  it('carries the click marker through pane options and consumes it after selecting the host tab', async () => {
    const { useAppStore } = await import('@/store')
    useAppStore.setState({
      runtimeEnvironments: [cloudEnvironment()],
      repos: [
        {
          id: 'repo-1',
          path: '/worktrees/main',
          displayName: 'repo-1',
          badgeColor: '#000000',
          addedAt: 1,
          connectionId: null,
          executionHostId: 'runtime:cloud-u154'
        }
      ],
      activeWorktreeId: WORKTREE,
      activeWorkspaceExecutionHostId: null
    })
    runtimeCall.mockImplementation(async (request: { method: string }) => {
      if (request.method === 'terminal.create') {
        return {
          ok: true,
          result: {
            terminal: {
              handle: 'remote-pty-u154',
              tabId: CREATED_HOST_TAB_ID,
              leafId: CREATED_HOST_LEAF_ID
            }
          }
        }
      }
      return { ok: true, result: {} }
    })

    // The store action the "+" / shortcut path runs. Its cloud branch keeps the tab client-owned.
    const { createActiveWorkspaceTerminalActions } =
      await import('@/store/terminals/terminal-active-workspace-creation')
    const actions = createActiveWorkspaceTerminalActions(
      () => {},
      () => useAppStore.getState()
    )
    await actions.openNewTerminalTabInActiveWorkspace(GROUP_ID)

    const tabs = useAppStore.getState().tabsByWorktree[WORKTREE] ?? []
    const createdTab = tabs.at(-1)
    if (!createdTab) {
      throw new Error('the click must create a local tab')
    }

    const { peekUserInitiatedTerminalCreate } =
      await import('@/runtime/web-session-user-initiated-create')
    expect(
      peekUserInitiatedTerminalCreate(createdTab.id),
      'the UI action must mark the created tab'
    ).toBe(true)

    const { buildPaneTransportOptions } =
      await import('@/components/terminal-pane/pty-connection/pane-transport-options')
    const session = {
      pane: { terminal: { options: {} }, leafId: 'leaf-u154' },
      deps: {
        worktreeId: WORKTREE,
        tabId: createdTab.id,
        isActiveRef: { current: true },
        isVisibleRef: { current: true }
      },
      runtimeEnvironmentId: ENV
    } as unknown as Parameters<typeof buildPaneTransportOptions>[0]
    const options = buildPaneTransportOptions(session)
    expect(
      options.userInitiated,
      'the pane must read the gesture from the ledger, not from a hardcoded flag'
    ).toBe(true)

    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const { peekWebSessionFocusIntent } = await import('@/runtime/web-session-focus-intent')
    const transport = createRemoteRuntimePtyTransport(ENV, options)
    await transport.connect({ url: '', callbacks: {} })

    const tapActivation = activationParams().find((params) => params.materializeOnly !== true)
    expect(tapActivation, 'the finished create must replay a tap-semantics activate').toMatchObject(
      {
        tabId: CREATED_HOST_TAB_ID,
        leafId: CREATED_HOST_LEAF_ID,
        intent: 'user',
        navigation: 'caller',
        notifyClients: false
      }
    )

    const intent = peekWebSessionFocusIntent({ environmentId: ENV }, WORKTREE)
    expect(intent?.hostTabId).toBe(CREATED_HOST_TAB_ID)
    expect(
      intent?.expectedCurrentLocalTabId,
      'the focus guard must remember the local tab the click left visible'
    ).toBe(createdTab.id)

    expect(
      peekUserInitiatedTerminalCreate(createdTab.id),
      'the gesture mark must be consumed once the host selection is sent'
    ).toBe(false)
  })
})
