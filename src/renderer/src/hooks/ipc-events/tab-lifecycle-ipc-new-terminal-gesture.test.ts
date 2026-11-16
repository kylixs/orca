/**
 * U155: Cmd/Ctrl+T inside a cloud guest reaches `ui:newTerminalTab`. The cloud branch stays
 * client-owned, so the local tab it creates must carry the user-gesture mark (unlike a passive
 * mount, the negative control pinned in the sibling entries spec).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createTab: vi.fn(),
  setActiveTabType: vi.fn(),
  setTabBarOrder: vi.fn(),
  focusTerminalTabSurface: vi.fn(),
  isWebRuntimeSessionActive: vi.fn(() => false),
  createWebRuntimeSessionTerminal: vi.fn(),
  getRuntimeEnvironmentIdForWorktree: vi.fn(() => null),
  isCloudSessionEnvironmentId: vi.fn(() => false),
  dispatchWorkspaceTabCommand: vi.fn(),
  isFloatingWorkspacePanelFocused: vi.fn(() => false),
  createFloatingWorkspaceTerminalTab: vi.fn(),
  resolveFloatingWorkspaceBrowserWorkspaceId: vi.fn(),
  dispatchFloatingWorkspaceGuestClose: vi.fn(),
  dispatchFloatingWorkspaceGuestSelectIndex: vi.fn()
}))

vi.mock('@/runtime/web-runtime-session', () => ({
  isWebRuntimeSessionActive: mocks.isWebRuntimeSessionActive,
  createWebRuntimeSessionTerminal: mocks.createWebRuntimeSessionTerminal
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: mocks.getRuntimeEnvironmentIdForWorktree
}))
vi.mock('@/lib/cloud-session-environment-membership', () => ({
  isCloudSessionEnvironmentId: mocks.isCloudSessionEnvironmentId
}))
vi.mock('@/lib/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: mocks.focusTerminalTabSurface
}))
vi.mock('@/lib/workspace-tab-commands', () => ({
  dispatchWorkspaceTabCommand: mocks.dispatchWorkspaceTabCommand
}))
vi.mock('@/lib/floating-workspace-terminal-actions', () => ({
  isFloatingWorkspacePanelFocused: mocks.isFloatingWorkspacePanelFocused,
  createFloatingWorkspaceTerminalTab: mocks.createFloatingWorkspaceTerminalTab,
  resolveFloatingWorkspaceBrowserWorkspaceId: mocks.resolveFloatingWorkspaceBrowserWorkspaceId
}))
vi.mock('@/lib/floating-workspace-guest-bridge', () => ({
  dispatchFloatingWorkspaceGuestClose: mocks.dispatchFloatingWorkspaceGuestClose,
  dispatchFloatingWorkspaceGuestSelectIndex: mocks.dispatchFloatingWorkspaceGuestSelectIndex
}))

const WORKTREE_ID = 'repo-1::/worktrees/main'
const NEW_TAB_ID = 'ipc-created-tab'

const storeState = {
  activeWorktreeId: WORKTREE_ID,
  runtimeEnvironments: [],
  tabsByWorktree: { [WORKTREE_ID]: [{ id: NEW_TAB_ID }] },
  openFiles: [],
  browserTabsByWorktree: {},
  tabBarOrderByWorktree: {},
  createTab: mocks.createTab,
  setActiveTabType: mocks.setActiveTabType,
  setTabBarOrder: mocks.setTabBarOrder
}

const useAppStore = Object.assign(
  (selector?: (state: typeof storeState) => unknown) =>
    selector ? selector(storeState) : storeState,
  { getState: () => storeState }
)
vi.mock('@/store', () => ({ useAppStore }))

let newTerminalTabHandler: (() => void) | undefined

function uiNoop(): () => void {
  return () => {}
}

describe('U155: ui:newTerminalTab marks the client-owned tab', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mocks.createTab.mockReturnValue({ id: NEW_TAB_ID })
    mocks.isWebRuntimeSessionActive.mockReturnValue(false)
    mocks.isCloudSessionEnvironmentId.mockReturnValue(false)
    newTerminalTabHandler = undefined
    const { clearUserInitiatedTerminalCreateForTests } =
      await import('@/runtime/web-session-user-initiated-create')
    clearUserInitiatedTerminalCreateForTests()

    vi.stubGlobal('window', {
      api: {
        ui: {
          onNewTerminalTab: (handler: () => void) => {
            newTerminalTabHandler = handler
            return uiNoop()
          },
          onCloseActiveTab: uiNoop,
          onCloseFloatingItem: uiNoop,
          onSelectFloatingIndex: uiNoop,
          onSwitchTab: uiNoop,
          onSwitchTabAcrossAllTypes: uiNoop,
          onSwitchRecentTab: uiNoop,
          onSwitchTerminalTab: uiNoop
        }
      }
    })
    const { registerTabLifecycleIpcBridge } = await import('./tab-lifecycle-ipc-bridge')
    registerTabLifecycleIpcBridge([])
  })

  it('marks the locally created tab so its cloud pane persists the selection', async () => {
    const { peekUserInitiatedTerminalCreate } =
      await import('@/runtime/web-session-user-initiated-create')

    newTerminalTabHandler?.()

    await vi.waitFor(() => expect(mocks.createTab).toHaveBeenCalledTimes(1))
    expect(peekUserInitiatedTerminalCreate(NEW_TAB_ID)).toBe(true)
  })
})
