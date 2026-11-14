import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeWorktree } from '../store/slices/worktrees-slice-test-fixtures'

const mocks = vi.hoisted(() => ({
  activateWebRuntimeSessionWorktree: vi.fn().mockResolvedValue(true),
  ensureWorktreeHasInitialTerminal: vi.fn().mockReturnValue(null),
  ensureWebRuntimeWorktreeTerminalAfterWake: vi.fn().mockReturnValue(undefined),
  resumeSleepingAgentSessionsForWorktree: vi.fn().mockReturnValue(0),
  gateAndReseedEmptyWorkspace: vi.fn().mockReturnValue(undefined),
  liftSidebarFiltersHidingWorktree: vi.fn().mockReturnValue(undefined),
  workspaceHasSleepingAgentSessions: vi.fn().mockReturnValue(false)
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => storeState
  }
}))

vi.mock('@/runtime/web-runtime-session', () => ({
  activateWebRuntimeSessionWorktree: mocks.activateWebRuntimeSessionWorktree,
  isWebRuntimeSessionActive: (environmentId: string | null | undefined) =>
    Boolean(environmentId?.trim())
}))

vi.mock('@/lib/worktree-initial-terminal-seeding', () => ({
  ensureWorktreeHasInitialTerminal: mocks.ensureWorktreeHasInitialTerminal
}))

vi.mock('@/lib/web-runtime-worktree-terminal-after-wake', () => ({
  ensureWebRuntimeWorktreeTerminalAfterWake: mocks.ensureWebRuntimeWorktreeTerminalAfterWake
}))

vi.mock('@/lib/resume-sleeping-agent-session', () => ({
  resumeSleepingAgentSessionsForWorktree: mocks.resumeSleepingAgentSessionsForWorktree
}))

vi.mock('@/lib/worktree-activation-gated-empty-reseed', () => ({
  gateAndReseedEmptyWorkspace: mocks.gateAndReseedEmptyWorkspace
}))

vi.mock('@/lib/worktree-activation-sidebar-filters', () => ({
  liftSidebarFiltersHidingWorktree: mocks.liftSidebarFiltersHidingWorktree
}))

vi.mock('@/lib/worktree-agent-activation-gate', () => ({
  workspaceHasSleepingAgentSessions: mocks.workspaceHasSleepingAgentSessions
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn(), info: vi.fn() } }))

import { activateAndRevealWorktree } from './worktree-activation'

const cloudEnvironment = {
  id: 'env-cloud',
  name: 'Payment',
  cloudProject: { projectId: 'proj_1', projectKey: 'payment', hostId: 'host_1', registeredAt: 1 }
}

const nativeEnvironment = { id: 'env-native', name: 'Native' }

function setState(overrides: Record<string, unknown>): void {
  Object.assign(storeState, {
    activeRepoId: null,
    activeWorktreeId: 'wt-other',
    activeWorkspaceExecutionHostId: null,
    activeView: 'terminal',
    isNavigatingHistory: false,
    repos: [],
    worktreesByRepo: {},
    settings: {},
    sleepingAgentSessionsByPaneKey: {},
    runtimeEnvironments: [],
    getKnownWorktreeById: vi.fn(() => storeState.worktreesByRepo.repo1?.[0] ?? null),
    setActiveRepo: vi.fn(),
    setActiveView: vi.fn(),
    setActiveWorktree: vi.fn(),
    markWorktreeVisited: vi.fn(),
    recordWorktreeVisit: vi.fn(),
    revealWorktreeInSidebar: vi.fn(),
    ...overrides
  })
}

// The activation helper reads the store imperatively; one mutable object stands in for it.
type FixtureStoreState = {
  worktreesByRepo: Record<string, { id: string }[]>
  [key: string]: unknown
}

let storeState: FixtureStoreState = { worktreesByRepo: {} }

beforeEach(() => {
  storeState = { worktreesByRepo: {} }
  vi.clearAllMocks()
  mocks.activateWebRuntimeSessionWorktree.mockResolvedValue(true)
  vi.stubGlobal('window', { api: {} })
})

describe('worktree activation host notify on a cloud session environment', () => {
  it('sends no worktree.activate for a cloud environment owner', () => {
    setState({
      runtimeEnvironments: [cloudEnvironment],
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: 'wt-cloud',
            repoId: 'repo1',
            hostId: 'runtime:env-cloud',
            runtimeOwnerEnvironmentId: 'env-cloud'
          })
        ]
      }
    })

    expect(activateAndRevealWorktree('wt-cloud')).not.toBe(false)

    expect(mocks.activateWebRuntimeSessionWorktree).not.toHaveBeenCalled()
  })

  it('still notifies a paired native runtime host', () => {
    setState({
      runtimeEnvironments: [cloudEnvironment, nativeEnvironment],
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: 'wt-native',
            repoId: 'repo1',
            hostId: 'runtime:env-native',
            runtimeOwnerEnvironmentId: 'env-native'
          })
        ]
      }
    })

    activateAndRevealWorktree('wt-native')

    expect(mocks.activateWebRuntimeSessionWorktree).toHaveBeenCalledOnce()
    expect(mocks.activateWebRuntimeSessionWorktree).toHaveBeenCalledWith({
      worktreeId: 'wt-native',
      environmentId: 'env-native'
    })
  })

  it('keeps skipping the notify for a local (non-runtime) worktree', () => {
    setState({
      worktreesByRepo: {
        repo1: [makeWorktree({ id: 'wt-local', repoId: 'repo1' })]
      }
    })

    activateAndRevealWorktree('wt-local')

    expect(mocks.activateWebRuntimeSessionWorktree).not.toHaveBeenCalled()
  })

  it('keeps the explicit notifyHostRuntime:false opt-out working on a native host', () => {
    setState({
      runtimeEnvironments: [nativeEnvironment],
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: 'wt-native',
            repoId: 'repo1',
            hostId: 'runtime:env-native',
            runtimeOwnerEnvironmentId: 'env-native'
          })
        ]
      }
    })

    activateAndRevealWorktree('wt-native', { notifyHostRuntime: false })

    expect(mocks.activateWebRuntimeSessionWorktree).not.toHaveBeenCalled()
  })
})
