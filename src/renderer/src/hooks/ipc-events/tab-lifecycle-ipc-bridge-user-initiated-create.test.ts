// @vitest-environment happy-dom
/**
 * U161: Cmd/Ctrl+T inside a cloud guest creates a client-owned tab, so its gesture must be scoped
 * to the worktree the shortcut acted on — otherwise a pre-create host frame can steal the tab.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const WORKTREE_ID = 'repo-1::/worktrees/main'

let storeState = {}

const mocks = vi.hoisted(() => ({
  createTab: vi.fn(() => ({ id: 'ctrl-t-tab' })),
  setActiveTabType: vi.fn(),
  setTabBarOrder: vi.fn(),
  focusTerminalTabSurface: vi.fn(),
  isFloatingWorkspacePanelFocused: vi.fn(() => false)
}))

vi.mock('../../store', () => ({ useAppStore: { getState: () => storeState } }))
vi.mock('@/lib/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: mocks.focusTerminalTabSurface
}))
vi.mock('@/lib/floating-workspace-terminal-actions', () => ({
  isFloatingWorkspacePanelFocused: mocks.isFloatingWorkspacePanelFocused,
  createFloatingWorkspaceTerminalTab: vi.fn(),
  resolveFloatingWorkspaceBrowserWorkspaceId: vi.fn()
}))
vi.mock('@/lib/floating-workspace-guest-bridge', () => ({
  dispatchFloatingWorkspaceGuestClose: vi.fn(),
  dispatchFloatingWorkspaceGuestSelectIndex: vi.fn()
}))
vi.mock('@/lib/workspace-tab-commands', () => ({ dispatchWorkspaceTabCommand: vi.fn() }))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: () => null
}))
vi.mock('@/runtime/web-runtime-session', () => ({
  isWebRuntimeSessionActive: () => false,
  createWebRuntimeSessionTerminal: vi.fn()
}))

describe('U161: Cmd/Ctrl+T marks the gesture in the active worktree', () => {
  let newTerminalHandler: (() => void) | undefined

  beforeEach(async () => {
    vi.clearAllMocks()
    mocks.isFloatingWorkspacePanelFocused.mockReturnValue(false)
    storeState = {
      activeWorktreeId: WORKTREE_ID,
      runtimeEnvironments: [],
      tabsByWorktree: {},
      openFiles: [],
      browserTabsByWorktree: {},
      tabBarOrderByWorktree: {},
      createTab: mocks.createTab,
      setActiveTabType: mocks.setActiveTabType,
      setTabBarOrder: mocks.setTabBarOrder
    }
    const noop = () => () => {}
    Object.assign(window, {
      api: {
        ui: {
          onNewTerminalTab: (handler: () => void) => {
            newTerminalHandler = handler
            return () => {}
          },
          onCloseActiveTab: noop,
          onCloseFloatingItem: noop,
          onSelectFloatingIndex: noop,
          onSwitchTab: noop,
          onSwitchTabAcrossAllTypes: noop,
          onSwitchRecentTab: noop,
          onSwitchTerminalTab: noop
        }
      }
    })
    const { clearUserInitiatedTerminalCreateForTests } =
      await import('@/runtime/web-session-user-initiated-create')
    clearUserInitiatedTerminalCreateForTests()
  })

  it('marks the tab for the active worktree', async () => {
    const { registerTabLifecycleIpcBridge } = await import('./tab-lifecycle-ipc-bridge')
    const {
      peekUserInitiatedTerminalCreate,
      peekUserInitiatedTerminalCreateForWorktree
    } = await import('@/runtime/web-session-user-initiated-create')
    registerTabLifecycleIpcBridge([])

    newTerminalHandler?.()
    await vi.waitFor(() => expect(mocks.setActiveTabType).toHaveBeenCalled())

    expect(peekUserInitiatedTerminalCreate('ctrl-t-tab')).toBe(true)
    expect(peekUserInitiatedTerminalCreateForWorktree(WORKTREE_ID)).toBe(true)
    expect(peekUserInitiatedTerminalCreateForWorktree('other-worktree')).toBe(false)
  })
})
