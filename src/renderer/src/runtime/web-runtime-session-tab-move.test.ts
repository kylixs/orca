import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { moveWebRuntimeSessionTab } from './web-runtime-session'
import { resetWebSessionFocusIntentForTests } from './web-session-focus-intent'
import { resetWebSessionCloseIntentForTests } from './web-session-close-intent'
import { ENVIRONMENT_ID, WORKTREE_ID } from './web-runtime-session-test-harness'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  setState: vi.fn(),
  subscribe: vi.fn(),
  setActiveWorktree: vi.fn(),
  createBrowserTab: vi.fn(),
  closeEmptyGroup: vi.fn(),
  moveUnifiedTabToGroup: vi.fn(),
  setRemoteBrowserPageHandle: vi.fn(),
  focusBrowserTabInWorktree: vi.fn(),
  applyWebSessionTabsSnapshot: vi.fn(),
  decideWebSessionTabsSnapshot: vi.fn(() => ({ apply: true, settlesHostMirror: true })),
  getWebSessionTabsTrackingGeneration: vi.fn(() => 0),
  acceptReplayedWebSessionTabsSnapshot: vi.fn(),
  resolveHostSessionTabIdForWebSessionTab: vi.fn(),
  resolveHostSessionGroupIdForWebSessionGroup: vi.fn(),
  isKnownHostSessionGroupId: vi.fn(),
  hasKnownHostSessionGroups: vi.fn(),
  trackTerminalPaneSplit: vi.fn(),
  deliverLaunchPromptToAgentTab: vi.fn(),
  seedNativeChatLaunchDraftForAgentTab: vi.fn(),
  getRuntimeEnvironmentIdForWorktree: vi.fn(),
  hasMaterializedWebRuntimeBrowserPage: vi.fn()
}))

vi.mock('../store', () => ({
  useAppStore: {
    getState: mocks.getState,
    setState: mocks.setState,
    subscribe: mocks.subscribe
  }
}))

vi.mock('./web-session-tabs-sync', () => ({
  acceptReplayedWebSessionTabsSnapshot: mocks.acceptReplayedWebSessionTabsSnapshot,
  applyWebSessionTabsSnapshot: mocks.applyWebSessionTabsSnapshot,
  decideWebSessionTabsSnapshot: mocks.decideWebSessionTabsSnapshot,
  getWebSessionTabsTrackingGeneration: mocks.getWebSessionTabsTrackingGeneration,
  applyWebSessionTabsStorePatch: (buildPatch: (state: unknown) => unknown) => {
    mocks.setState(buildPatch)
    // The production caller invokes the returned settle receipt.
    return () => {}
  },
  resolveHostSessionTabIdForWebSessionTab: mocks.resolveHostSessionTabIdForWebSessionTab,
  resolveHostSessionGroupIdForWebSessionGroup: mocks.resolveHostSessionGroupIdForWebSessionGroup,
  isKnownHostSessionGroupId: mocks.isKnownHostSessionGroupId,
  hasKnownHostSessionGroups: mocks.hasKnownHostSessionGroups
}))

vi.mock('@/lib/feature-education-telemetry', () => ({
  trackTerminalPaneSplit: mocks.trackTerminalPaneSplit
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: mocks.getRuntimeEnvironmentIdForWorktree
}))

vi.mock('@/lib/agent-launch-prompt-delivery', () => ({
  deliverLaunchPromptToAgentTab: mocks.deliverLaunchPromptToAgentTab,
  seedNativeChatLaunchDraftForAgentTab: mocks.seedNativeChatLaunchDraftForAgentTab
}))

vi.mock('./web-runtime-browser-materialization', () => ({
  hasMaterializedWebRuntimeBrowserPage: mocks.hasMaterializedWebRuntimeBrowserPage
}))

afterEach(() => resetWebSessionCloseIntentForTests())

describe('moveWebRuntimeSessionTab', () => {
  beforeEach(() => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    mocks.getState.mockReturnValue({
      settings: {
        activeRuntimeEnvironmentId: ENVIRONMENT_ID
      },
      setActiveWorktree: mocks.setActiveWorktree
    })
    mocks.applyWebSessionTabsSnapshot.mockReturnValue({ state: 'after' })
    mocks.resolveHostSessionGroupIdForWebSessionGroup.mockReturnValue(null)
    mocks.isKnownHostSessionGroupId.mockReturnValue(false)
    // Why: web sessions always apply host layout frames, so the known-group set exists.
    mocks.hasKnownHostSessionGroups.mockReturnValue(true)
  })

  afterEach(() => {
    resetWebSessionFocusIntentForTests()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('moves paired web tabs through the host session API without an eager stale refresh', async () => {
    // Why: the target is a host group id from the last frame, so no mapping is needed.
    mocks.isKnownHostSessionGroupId.mockReturnValue(true)
    const runtimeCall = vi.fn().mockResolvedValueOnce({
      id: 'move',
      ok: true,
      result: { moved: true }
    })

    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    await expect(
      moveWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: 'web-terminal-host-tab-1%3A%3Aleaf-1',
        targetGroupId: 'group-right',
        kind: 'split',
        splitDirection: 'right'
      })
    ).resolves.toBe(true)

    expect(runtimeCall).toHaveBeenNthCalledWith(1, {
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.move',
      params: {
        worktree: `id:${WORKTREE_ID}`,
        tabId: 'host-tab-1::leaf-1',
        targetGroupId: 'group-right',
        kind: 'split',
        splitDirection: 'right'
      },
      timeoutMs: 15_000
    })
    expect(runtimeCall).toHaveBeenCalledTimes(1)
    expect(mocks.applyWebSessionTabsSnapshot).not.toHaveBeenCalled()
  })

  it('maps mirrored local browser unified ids back to host session tab ids', async () => {
    // Why: a host group id needs no local mapping to be a valid reorder target.
    mocks.isKnownHostSessionGroupId.mockReturnValue(true)
    mocks.resolveHostSessionTabIdForWebSessionTab.mockImplementation(
      (_state, args: { tabId: string }) =>
        args.tabId === 'local-browser-unified'
          ? 'host-browser-unified'
          : args.tabId === 'local-terminal-unified'
            ? 'host-terminal'
            : null
    )
    const runtimeCall = vi.fn().mockResolvedValueOnce({
      id: 'move',
      ok: true,
      result: { moved: true }
    })

    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    await expect(
      moveWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: 'local-browser-unified',
        targetGroupId: 'group-right',
        kind: 'reorder',
        tabOrder: ['local-terminal-unified', 'local-only-unified', 'local-browser-unified']
      })
    ).resolves.toBe(true)

    expect(runtimeCall).toHaveBeenCalledWith({
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.move',
      params: {
        worktree: `id:${WORKTREE_ID}`,
        tabId: 'host-browser-unified',
        targetGroupId: 'group-right',
        kind: 'reorder',
        tabOrder: ['host-terminal', 'host-browser-unified']
      },
      timeoutMs: 15_000
    })
  })

  it('counts only host-backed tabs for mirrored move-to-group indexes', async () => {
    mocks.getState.mockReturnValue({
      settings: {
        activeRuntimeEnvironmentId: ENVIRONMENT_ID
      },
      setActiveWorktree: mocks.setActiveWorktree,
      groupsByWorktree: {
        [WORKTREE_ID]: [
          {
            id: 'local-group-right',
            activeTabId: 'local-only-unified',
            tabOrder: ['local-only-unified', 'local-terminal-unified']
          }
        ]
      }
    })
    mocks.resolveHostSessionTabIdForWebSessionTab.mockImplementation(
      (_state, args: { tabId: string }) =>
        args.tabId === 'local-browser-unified'
          ? 'host-browser-unified'
          : args.tabId === 'local-terminal-unified'
            ? 'host-terminal'
            : null
    )
    mocks.resolveHostSessionGroupIdForWebSessionGroup.mockImplementation(
      (args: { groupId: string }) =>
        args.groupId === 'local-group-right' ? 'host-group-right' : null
    )
    const runtimeCall = vi.fn().mockResolvedValueOnce({
      id: 'move',
      ok: true,
      result: { moved: true }
    })

    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    await expect(
      moveWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: 'local-browser-unified',
        targetGroupId: 'local-group-right',
        kind: 'move-to-group',
        index: 1
      })
    ).resolves.toBe(true)

    expect(runtimeCall).toHaveBeenCalledWith({
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.move',
      params: {
        worktree: `id:${WORKTREE_ID}`,
        tabId: 'host-browser-unified',
        // Why: the host only knows the group id its own split minted, never the client's local UUID.
        targetGroupId: 'host-group-right',
        kind: 'move-to-group',
        index: 0
      },
      timeoutMs: 15_000
    })
  })

  it('refuses a move-to-group whose local target group has no host counterpart', async () => {
    mocks.getState.mockReturnValue({
      settings: {
        activeRuntimeEnvironmentId: ENVIRONMENT_ID
      },
      setActiveWorktree: mocks.setActiveWorktree,
      groupsByWorktree: {
        [WORKTREE_ID]: [
          { id: 'local-group-right', activeTabId: null, tabOrder: ['local-only-unified'] }
        ]
      }
    })
    mocks.resolveHostSessionGroupIdForWebSessionGroup.mockReturnValue(null)
    const runtimeCall = vi.fn()

    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    await expect(
      moveWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: 'local-browser-unified',
        targetGroupId: 'local-group-right',
        kind: 'move-to-group',
        index: 0
      })
    ).resolves.toBe(false)

    // Why: guessing the local UUID would only earn a host refusal after a round-trip.
    expect(runtimeCall).not.toHaveBeenCalled()
  })

  it('returns the host moved:false instead of masking it as success', async () => {
    mocks.resolveHostSessionGroupIdForWebSessionGroup.mockReturnValue('host-group-gone')
    const runtimeCall = vi.fn().mockResolvedValueOnce({
      id: 'move',
      ok: true,
      result: { moved: false }
    })

    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    await expect(
      moveWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: 'web-terminal-host-tab-1%3A%3Aleaf-1',
        targetGroupId: 'group-gone',
        kind: 'move-to-group',
        index: 0
      })
    ).resolves.toBe(false)

    expect(runtimeCall).toHaveBeenCalledTimes(1)
  })

  it('does not mirror a reorder when the dragged tab is local-only', async () => {
    mocks.resolveHostSessionTabIdForWebSessionTab.mockImplementation(
      (_state, args: { tabId: string }) =>
        args.tabId === 'local-terminal-unified' ? 'host-terminal' : null
    )
    const runtimeCall = vi.fn().mockResolvedValueOnce({
      id: 'move',
      ok: true,
      result: { moved: true }
    })

    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    await expect(
      moveWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: 'local-only-unified',
        targetGroupId: 'group-right',
        kind: 'reorder',
        tabOrder: ['local-only-unified', 'local-terminal-unified']
      })
    ).resolves.toBe(false)

    expect(runtimeCall).not.toHaveBeenCalled()
  })

  it('resolves a client-owned split group id for a reorder instead of shipping the local UUID', async () => {
    mocks.resolveHostSessionTabIdForWebSessionTab.mockImplementation(
      (_state, args: { tabId: string }) =>
        args.tabId === 'local-terminal-unified' ? 'host-terminal' : null
    )
    mocks.resolveHostSessionGroupIdForWebSessionGroup.mockImplementation(
      (args: { groupId: string }) =>
        args.groupId === 'local-split-group' ? 'host-split-group' : null
    )
    const runtimeCall = vi.fn().mockResolvedValueOnce({
      id: 'move',
      ok: true,
      result: { moved: true }
    })

    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    await expect(
      moveWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: 'local-terminal-unified',
        targetGroupId: 'local-split-group',
        kind: 'reorder',
        tabOrder: ['local-terminal-unified']
      })
    ).resolves.toBe(true)

    expect(runtimeCall).toHaveBeenCalledWith({
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.move',
      params: {
        worktree: `id:${WORKTREE_ID}`,
        tabId: 'host-terminal',
        targetGroupId: 'host-split-group',
        kind: 'reorder',
        tabOrder: ['host-terminal']
      },
      timeoutMs: 15_000
    })
  })

  it('refuses a reorder whose target group is neither mapped nor a known host group', async () => {
    mocks.resolveHostSessionTabIdForWebSessionTab.mockReturnValue('host-terminal')
    mocks.resolveHostSessionGroupIdForWebSessionGroup.mockReturnValue(null)
    mocks.isKnownHostSessionGroupId.mockReturnValue(false)
    const runtimeCall = vi.fn()

    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    await expect(
      moveWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: 'local-terminal-unified',
        targetGroupId: 'local-split-group',
        kind: 'reorder',
        tabOrder: ['local-terminal-unified']
      })
    ).resolves.toBe(false)

    // Why: the local UUID cannot match any host group, so the round-trip is guaranteed to fail.
    expect(runtimeCall).not.toHaveBeenCalled()
  })

  it('refuses a split whose local target group has no host counterpart', async () => {
    mocks.resolveHostSessionGroupIdForWebSessionGroup.mockReturnValue(null)
    mocks.isKnownHostSessionGroupId.mockReturnValue(false)
    const runtimeCall = vi.fn()

    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    await expect(
      moveWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: 'web-terminal-host-tab-1%3A%3Aleaf-1',
        targetGroupId: 'local-split-group',
        kind: 'split',
        splitDirection: 'right'
      })
    ).resolves.toBe(false)

    expect(runtimeCall).not.toHaveBeenCalled()
  })

  it('resolves a paired desktop split target from the host inventory', async () => {
    // Why: a desktop paired window never applies web-session layout frames, so its
    // group ids are client-minted and only membership in the host inventory identifies
    // the group the host must split.
    mocks.hasKnownHostSessionGroups.mockReturnValue(false)
    mocks.resolveHostSessionTabIdForWebSessionTab.mockReturnValue(null)
    mocks.resolveHostSessionGroupIdForWebSessionGroup.mockReturnValue(null)
    mocks.isKnownHostSessionGroupId.mockReturnValue(false)
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'list',
        ok: true,
        result: {
          tabGroups: [{ id: 'host-group-left', tabOrder: ['host-tab-1', 'host-tab-9'] }]
        }
      })
      .mockResolvedValueOnce({
        id: 'move',
        ok: true,
        result: { moved: true }
      })

    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    await expect(
      moveWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: 'host-tab-1',
        targetGroupId: 'client-group-left',
        kind: 'split',
        splitDirection: 'right'
      })
    ).resolves.toBe(true)

    expect(runtimeCall).toHaveBeenNthCalledWith(1, {
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.list',
      params: { worktree: `id:${WORKTREE_ID}` },
      timeoutMs: 15_000
    })
    expect(runtimeCall).toHaveBeenNthCalledWith(2, {
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.move',
      params: {
        worktree: `id:${WORKTREE_ID}`,
        tabId: 'host-tab-1',
        targetGroupId: 'host-group-left',
        kind: 'split',
        splitDirection: 'right'
      },
      timeoutMs: 15_000
    })
  })

  it('mirrors a paired desktop reorder through the host group that owns the tab', async () => {
    mocks.hasKnownHostSessionGroups.mockReturnValue(false)
    mocks.resolveHostSessionTabIdForWebSessionTab.mockReturnValue(null)
    mocks.resolveHostSessionGroupIdForWebSessionGroup.mockReturnValue(null)
    mocks.isKnownHostSessionGroupId.mockReturnValue(false)
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'list',
        ok: true,
        result: {
          tabGroups: [{ id: 'host-group-right', tabOrder: ['host-tab-1', 'host-tab-2'] }]
        }
      })
      .mockResolvedValueOnce({
        id: 'move',
        ok: true,
        result: { moved: true }
      })

    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    await expect(
      moveWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: 'host-tab-2',
        targetGroupId: 'client-group-right',
        kind: 'reorder',
        tabOrder: ['host-tab-2', 'host-tab-1']
      })
    ).resolves.toBe(true)

    expect(runtimeCall).toHaveBeenNthCalledWith(2, {
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.move',
      params: {
        worktree: `id:${WORKTREE_ID}`,
        tabId: 'host-tab-2',
        targetGroupId: 'host-group-right',
        kind: 'reorder',
        tabOrder: ['host-tab-2', 'host-tab-1']
      },
      timeoutMs: 15_000
    })
  })

  it('refuses a paired desktop split the host inventory cannot attribute', async () => {
    mocks.hasKnownHostSessionGroups.mockReturnValue(false)
    mocks.resolveHostSessionTabIdForWebSessionTab.mockReturnValue(null)
    mocks.resolveHostSessionGroupIdForWebSessionGroup.mockReturnValue(null)
    mocks.isKnownHostSessionGroupId.mockReturnValue(false)
    const runtimeCall = vi.fn().mockResolvedValueOnce({
      id: 'list',
      ok: true,
      result: { tabGroups: [{ id: 'host-group-left', tabOrder: ['host-tab-9'] }] }
    })

    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    await expect(
      moveWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: 'host-tab-1',
        targetGroupId: 'client-group-left',
        kind: 'split',
        splitDirection: 'right'
      })
    ).resolves.toBe(false)

    expect(runtimeCall).toHaveBeenCalledTimes(1)
    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'session.tabs.list' })
    )
  })

  it('resolves a paired desktop move-to-group target from the local peers', async () => {
    mocks.hasKnownHostSessionGroups.mockReturnValue(false)
    mocks.resolveHostSessionTabIdForWebSessionTab.mockReturnValue(null)
    mocks.resolveHostSessionGroupIdForWebSessionGroup.mockReturnValue(null)
    mocks.isKnownHostSessionGroupId.mockReturnValue(false)
    mocks.getState.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: ENVIRONMENT_ID },
      setActiveWorktree: mocks.setActiveWorktree,
      groupsByWorktree: {
        [WORKTREE_ID]: [
          {
            id: 'client-group-right',
            activeTabId: 'host-peer',
            tabOrder: ['host-peer', 'host-tab-2']
          }
        ]
      }
    })
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'list',
        ok: true,
        result: {
          tabGroups: [
            { id: 'host-group-source', tabOrder: ['host-tab-2'] },
            { id: 'host-group-right', tabOrder: ['host-peer'] }
          ]
        }
      })
      .mockResolvedValueOnce({ id: 'move', ok: true, result: { moved: true } })

    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    await expect(
      moveWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: 'host-tab-2',
        targetGroupId: 'client-group-right',
        kind: 'move-to-group',
        index: 1
      })
    ).resolves.toBe(true)

    expect(runtimeCall).toHaveBeenNthCalledWith(2, {
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.move',
      params: {
        worktree: `id:${WORKTREE_ID}`,
        tabId: 'host-tab-2',
        targetGroupId: 'host-group-right',
        kind: 'move-to-group',
        index: 1
      },
      timeoutMs: 15_000
    })
  })
})
