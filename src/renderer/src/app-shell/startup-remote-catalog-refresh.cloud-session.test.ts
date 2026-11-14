import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getState: vi.fn<() => Record<string, unknown>>()
}))

vi.mock('../store', () => ({
  useAppStore: {
    getState: mocks.getState
  }
}))

import { startDeferredRemoteStartupRefresh } from './startup-remote-catalog-refresh'

const cloudEnvironment = {
  id: 'env-cloud',
  name: 'Payment',
  cloudProject: { projectId: 'proj_1', projectKey: 'payment', hostId: 'host_1', registeredAt: 1 }
}

const nativeEnvironment = { id: 'env-native', name: 'Native' }

function createActions() {
  return {
    awaitOwnerWorktreeVisibilityDefaultsHydration: vi.fn().mockResolvedValue(undefined),
    fetchReposForAllHosts: vi.fn().mockResolvedValue(undefined),
    fetchProjectGroupsForAllHosts: vi.fn().mockResolvedValue(undefined),
    fetchFolderWorkspacesForAllHosts: vi.fn().mockResolvedValue(undefined),
    fetchAllWorktrees: vi.fn().mockResolvedValue(undefined),
    pruneLastVisitedTimestamps: vi.fn().mockReturnValue(undefined),
    fetchWorktreeLineage: vi.fn().mockResolvedValue(undefined)
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('deferred startup refresh on a cloud session environment', () => {
  it('skips the focused lineage refresh for a cloud focused host', async () => {
    const actions = createActions()
    mocks.getState.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: 'env-cloud' },
      runtimeEnvironments: [cloudEnvironment]
    })
    const onSettled = vi.fn()

    startDeferredRemoteStartupRefresh({
      cloudRuntimeSession: false,
      isCancelled: () => false,
      actions,
      onSettled
    })
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledOnce())

    expect(actions.fetchWorktreeLineage).not.toHaveBeenCalled()
    // The catalog scans keep their own per-row cloud skips; this step is untouched.
    expect(actions.fetchAllWorktrees).toHaveBeenCalledOnce()
    expect(actions.pruneLastVisitedTimestamps).toHaveBeenCalledOnce()
  })

  it('keeps the lineage refresh for a native focused host', async () => {
    const actions = createActions()
    mocks.getState.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: 'env-native' },
      runtimeEnvironments: [cloudEnvironment, nativeEnvironment]
    })
    const onSettled = vi.fn()

    startDeferredRemoteStartupRefresh({
      cloudRuntimeSession: false,
      isCancelled: () => false,
      actions,
      onSettled
    })
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledOnce())

    expect(actions.fetchWorktreeLineage).toHaveBeenCalledOnce()
  })

  it('keeps the lineage refresh for a local focus', async () => {
    const actions = createActions()
    mocks.getState.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: null },
      runtimeEnvironments: [cloudEnvironment]
    })
    const onSettled = vi.fn()

    startDeferredRemoteStartupRefresh({
      cloudRuntimeSession: false,
      isCancelled: () => false,
      actions,
      onSettled
    })
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledOnce())

    expect(actions.fetchWorktreeLineage).toHaveBeenCalledOnce()
  })

  it('still skips the whole chain for a web cloud ticket session', async () => {
    const actions = createActions()
    mocks.getState.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: 'env-cloud' },
      runtimeEnvironments: [cloudEnvironment]
    })
    const onSettled = vi.fn()

    startDeferredRemoteStartupRefresh({
      cloudRuntimeSession: true,
      isCancelled: () => false,
      actions,
      onSettled
    })
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledOnce())

    expect(actions.fetchAllWorktrees).not.toHaveBeenCalled()
    expect(actions.fetchWorktreeLineage).not.toHaveBeenCalled()
  })
})
