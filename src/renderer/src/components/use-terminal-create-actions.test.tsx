// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientCreationActionAvailability } from '@/lib/client-creation-action-policy'
import { useTerminalCreateActions } from './use-terminal-create-actions'
import type { TerminalColdActivationController } from './terminal-cold-activation'

const mocks = vi.hoisted(() => ({
  browserAvailability: {
    state: 'enabled',
    provider: 'local-client'
  } as ClientCreationActionAvailability,
  simulatorAvailability: {
    state: 'enabled',
    provider: 'local-client'
  } as ClientCreationActionAvailability,
  state: {} as Record<string, unknown>,
  // Empty string = no runtime; each test swaps in a real id.
  runtimeEnvironmentId: '',
  toastError: vi.fn(),
  createBrowserTab: vi.fn(),
  createTab: vi.fn(() => ({ id: 'tab-1' })),
  createWebRuntimeSessionTerminal: vi.fn(),
  openNewBrowserTabInActiveWorkspace: vi.fn(),
  openMobileEmulatorTab: vi.fn()
}))

vi.mock('../store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('sonner', () => ({
  toast: { error: (...args: unknown[]) => mocks.toastError(...args), message: vi.fn() }
}))
vi.mock('@/lib/client-creation-action-policy', () => ({
  getClientCreationActionPolicy: () => ({
    'managed-browser': mocks.browserAvailability,
    'mobile-emulator': mocks.simulatorAvailability
  })
}))
vi.mock('@/lib/focus-terminal-tab-surface', () => ({ focusTerminalTabSurface: vi.fn() }))
vi.mock('@/runtime/web-runtime-session', () => ({
  createWebRuntimeSessionBrowserTab: vi.fn(),
  createWebRuntimeSessionTerminal: (...args: unknown[]) =>
    mocks.createWebRuntimeSessionTerminal(...args),
  isWebRuntimeSessionActive: () => Boolean(mocks.runtimeEnvironmentId)
}))
vi.mock('@/lib/open-mobile-emulator-tab', () => ({
  openMobileEmulatorTab: (...args: unknown[]) => mocks.openMobileEmulatorTab(...args)
}))
vi.mock('@/lib/launch-agent-in-new-tab', () => ({ launchAgentInNewTab: vi.fn() }))
vi.mock('@/lib/duplicate-browser-tab-options', () => ({
  buildDuplicatedBrowserTabOptions: () => ({})
}))
vi.mock('@/runtime/remote-browser-tab-ownership', () => ({
  browserWorkspaceHasRemoteOwner: () => false
}))
vi.mock('./tab-bar/tab-create-entry-action', () => ({ openTabBarEntry: vi.fn() }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('./terminal-workspace-model', () => ({
  getActiveWorktreeRuntimeEnvironmentId: () => mocks.runtimeEnvironmentId
}))

const WORKTREE_ID = 'repo-1::/repo/worktree'

function renderActions() {
  return renderHook(() =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads only the creation callbacks this adapter supplies.
    useTerminalCreateActions({
      activeWorktreeId: WORKTREE_ID,
      createBrowserTab: mocks.createBrowserTab,
      createTab: mocks.createTab,
      openNewBrowserTabInActiveWorkspace: mocks.openNewBrowserTabInActiveWorkspace,
      openNewMarkdownInActiveWorkspace: vi.fn(),
      openNewTerminalTabInActiveWorkspace: vi.fn(),
      setActiveTabType: vi.fn(),
      setTabBarOrder: vi.fn()
    } as unknown as TerminalColdActivationController)
  ).result.current
}

describe('useTerminalCreateActions creation gates', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mocks.runtimeEnvironmentId = ''
    const { clearUserInitiatedTerminalCreateForTests } =
      await import('@/runtime/web-session-user-initiated-create')
    clearUserInitiatedTerminalCreateForTests()
    mocks.browserAvailability = { state: 'enabled', provider: 'local-client' }
    mocks.simulatorAvailability = { state: 'enabled', provider: 'local-client' }
    mocks.state = {
      activeGroupIdByWorktree: {},
      groupsByWorktree: {},
      browserDefaultUrl: 'about:blank',
      browserTabsByWorktree: { [WORKTREE_ID]: [{ id: 'browser-1', url: 'https://example.com' }] },
      tabsByWorktree: { [WORKTREE_ID]: [{ id: 'tab-1' }] },
      tabBarOrderByWorktree: {},
      openFiles: []
    }
  })

  it('creates a client-owned terminal tab on a cloud-session environment', async () => {
    mocks.runtimeEnvironmentId = 'env-cloud'
    mocks.state.runtimeEnvironments = [
      {
        id: 'env-cloud',
        name: 'payment',
        cloudProject: {
          projectId: 'proj_1',
          projectKey: 'payment',
          hostId: 'host_1',
          registeredAt: 1
        }
      }
    ]

    renderActions().handleNewTab()

    // Why: the cloud host refuses session.tabs.*; the pane spawns this tab with terminal.create.
    expect(mocks.createWebRuntimeSessionTerminal).not.toHaveBeenCalled()
    expect(mocks.createTab).toHaveBeenCalledWith(WORKTREE_ID, undefined, undefined)
    const { peekUserInitiatedTerminalCreateForWorktree } =
      await import('@/runtime/web-session-user-initiated-create')
    expect(peekUserInitiatedTerminalCreateForWorktree(WORKTREE_ID)).toBe(true)
  })

  it('still delegates terminal creation to a paired native runtime host', () => {
    mocks.runtimeEnvironmentId = 'env-native'
    mocks.state.runtimeEnvironments = [{ id: 'env-native', name: 'Native' }]

    renderActions().handleNewTab()

    expect(mocks.createWebRuntimeSessionTerminal).toHaveBeenCalledWith({
      worktreeId: WORKTREE_ID,
      environmentId: 'env-native',
      targetGroupId: undefined,
      command: undefined,
      activate: true
    })
    expect(mocks.createTab).not.toHaveBeenCalled()
  })

  it('toasts instead of creating a browser tab when the provider forbids it', () => {
    mocks.browserAvailability = { state: 'hidden', reason: 'no browser here' }
    renderActions().handleNewBrowserTab()
    expect(mocks.toastError).toHaveBeenCalledWith('no browser here')
    expect(mocks.createBrowserTab).not.toHaveBeenCalled()
  })

  it('toasts instead of duplicating a browser tab when the provider forbids it', () => {
    mocks.browserAvailability = { state: 'hidden', reason: 'no browser here' }
    renderActions().handleDuplicateBrowserTab('browser-1', 'unified-browser-1')
    expect(mocks.toastError).toHaveBeenCalledWith('no browser here')
    expect(mocks.createBrowserTab).not.toHaveBeenCalled()
  })

  it('reports a rejected workspace browser open instead of leaving it unhandled', async () => {
    mocks.state.activeGroupIdByWorktree = { [WORKTREE_ID]: 'group-1' }
    mocks.openNewBrowserTabInActiveWorkspace.mockRejectedValue(new Error('runtime says no'))
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    renderActions().handleNewBrowserTab()
    await new Promise((resolve) => setTimeout(resolve, 0))
    process.off('unhandledRejection', unhandled)
    expect(mocks.toastError).toHaveBeenCalledWith('runtime says no')
    expect(unhandled).not.toHaveBeenCalled()
  })

  it('reports a rejected simulator open instead of leaving it unhandled', async () => {
    mocks.openMobileEmulatorTab.mockRejectedValue(new Error('emulator says no'))
    renderActions().handleNewSimulatorTab()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mocks.toastError).toHaveBeenCalledWith('emulator says no')
  })
})
