/**
 * U154: the remaining user-gesture terminal create entries (file tree, split group, "+" shell)
 * must mark the new local tab exactly like the titlebar "+" does. A passive pane mount must not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stubHeadlessReact } from '../tab-bar/tab-bar-windows-shell-launch-render-stubs'

const mocks = vi.hoisted(() => ({
  createTab: vi.fn(),
  setActiveTab: vi.fn(),
  setActiveTabType: vi.fn(),
  setTabBarOrder: vi.fn(),
  focusGroup: vi.fn(),
  createBrowserTab: vi.fn(),
  createEmptySplitGroup: vi.fn(),
  openNewBrowserTabInActiveWorkspace: vi.fn(),
  openNewMarkdownInActiveWorkspace: vi.fn(),
  openNewTerminalTabInActiveWorkspace: vi.fn(),
  recordFeatureInteraction: vi.fn(),
  getRuntimeEnvironmentIdForWorktree: vi.fn(),
  focusTerminalTabSurface: vi.fn(),
  isWebRuntimeSessionActive: vi.fn(() => false),
  createWebRuntimeSessionTerminal: vi.fn(),
  createWebRuntimeSessionBrowserTab: vi.fn()
}))

vi.mock('react', async () => await stubHeadlessReact())

vi.mock('@/runtime/web-runtime-session', () => ({
  isWebRuntimeSessionActive: mocks.isWebRuntimeSessionActive,
  createWebRuntimeSessionTerminal: mocks.createWebRuntimeSessionTerminal,
  createWebRuntimeSessionBrowserTab: mocks.createWebRuntimeSessionBrowserTab
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: mocks.getRuntimeEnvironmentIdForWorktree,
  getRuntimeSessionMirrorEnvironmentIds: () => []
}))

vi.mock('@/lib/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: mocks.focusTerminalTabSurface
}))

const WORKTREE_ID = 'repo-1::/worktrees/main'
const GROUP_ID = 'group-1'

const storeState: Record<string, unknown> = {
  settings: { activeRuntimeEnvironmentId: null },
  runtimeEnvironments: [],
  activeWorktreeId: WORKTREE_ID,
  tabsByWorktree: {},
  openFiles: [],
  tabBarOrderByWorktree: {},
  createTab: mocks.createTab,
  setActiveTab: mocks.setActiveTab,
  setActiveTabType: mocks.setActiveTabType,
  setTabBarOrder: mocks.setTabBarOrder,
  focusGroup: mocks.focusGroup,
  createBrowserTab: mocks.createBrowserTab,
  createEmptySplitGroup: mocks.createEmptySplitGroup,
  openNewBrowserTabInActiveWorkspace: mocks.openNewBrowserTabInActiveWorkspace,
  openNewMarkdownInActiveWorkspace: mocks.openNewMarkdownInActiveWorkspace,
  openNewTerminalTabInActiveWorkspace: mocks.openNewTerminalTabInActiveWorkspace,
  recordFeatureInteraction: mocks.recordFeatureInteraction
}

const useAppStore = Object.assign(
  (selector?: (state: typeof storeState) => unknown) =>
    selector ? selector(storeState) : storeState,
  {
    getState: () => storeState,
    setState: vi.fn(),
    subscribe: vi.fn()
  }
)

vi.mock('@/store', () => ({ useAppStore }))

describe('U154: other user-gesture terminal creates mark the gesture', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mocks.isWebRuntimeSessionActive.mockReturnValue(false)
    mocks.getRuntimeEnvironmentIdForWorktree.mockReturnValue(null)
    storeState.tabsByWorktree = {}
    const { clearUserInitiatedTerminalCreateForTests } =
      await import('@/runtime/web-session-user-initiated-create')
    clearUserInitiatedTerminalCreateForTests()
  })

  afterEach(async () => {
    const { clearUserInitiatedTerminalCreateForTests } =
      await import('@/runtime/web-session-user-initiated-create')
    clearUserInitiatedTerminalCreateForTests()
  })

  it('marks a terminal created from the file tree', async () => {
    mocks.createTab.mockReturnValue({ id: 'file-tree-tab' })
    const { createNewTerminalTab } = await import('./terminal-tab-create')
    const { peekUserInitiatedTerminalCreate } =
      await import('@/runtime/web-session-user-initiated-create')

    createNewTerminalTab(WORKTREE_ID)

    expect(mocks.createTab).toHaveBeenCalledTimes(1)
    expect(peekUserInitiatedTerminalCreate('file-tree-tab')).toBe(true)
  })

  it('marks the terminal seeded by a split-group command', async () => {
    mocks.createEmptySplitGroup.mockReturnValue('group-new')
    mocks.createTab.mockReturnValue({ id: 'split-tab' })
    const { useTabGroupCreationCommands } = await import('../tab-group/useTabGroupCreationCommands')
    const { peekUserInitiatedTerminalCreate } =
      await import('@/runtime/web-session-user-initiated-create')

    const commands = useTabGroupCreationCommands({
      groupId: GROUP_ID,
      worktreeId: WORKTREE_ID,
      worktreeState: { mobileEmulatorEnabled: false } as never
    })
    commands.createSplitGroup('right')

    expect(peekUserInitiatedTerminalCreate('split-tab')).toBe(true)
  })

  it('marks a local-shell terminal from the "+" menu', async () => {
    mocks.createTab.mockReturnValue({ id: 'shell-tab' })
    const { useTabGroupCreationCommands } = await import('../tab-group/useTabGroupCreationCommands')
    const { peekUserInitiatedTerminalCreate } =
      await import('@/runtime/web-session-user-initiated-create')

    const commands = useTabGroupCreationCommands({
      groupId: GROUP_ID,
      worktreeId: WORKTREE_ID,
      worktreeState: { mobileEmulatorEnabled: false } as never
    })
    commands.newTerminalWithShell('zsh')
    await vi.waitFor(() => expect(mocks.createTab).toHaveBeenCalled())

    expect(peekUserInitiatedTerminalCreate('shell-tab')).toBe(true)
  })

  it('does not mark a passive pane mount', async () => {
    const { buildPaneTransportOptions } =
      await import('../terminal-pane/pty-connection/pane-transport-options')
    const session = {
      pane: { terminal: { options: {} }, leafId: 'leaf-1' },
      deps: {
        worktreeId: WORKTREE_ID,
        tabId: 'restored-tab',
        isActiveRef: { current: true },
        isVisibleRef: { current: true }
      },
      runtimeEnvironmentId: 'cloud-env'
    } as unknown as Parameters<typeof buildPaneTransportOptions>[0]

    const options = buildPaneTransportOptions(session)

    expect(options.userInitiated).toBeUndefined()
  })
})
