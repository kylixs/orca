import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeEnvironmentCallRequest } from '../../runtime/runtime-compatibility-test-fixture'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { AppState } from '../types'
import { makeDetectedResult } from './worktrees-detected-listing-fixtures'
import { makeLineage, makeWorktree } from './worktrees-slice-test-fixtures'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory,
  runtimeEnvironmentCall
} from './worktrees-slice-test-harness'

const environmentBase = {
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: null,
  runtimeId: null,
  preferredEndpointId: 'ep-1',
  endpoints: [{ id: 'ep-1', kind: 'websocket', label: 'Primary', endpoint: 'wss://host' } as const]
}

const cloudEnvironment: PublicKnownRuntimeEnvironment = {
  id: 'env-cloud',
  name: 'Payment',
  ...environmentBase,
  cloudProject: { projectId: 'proj_1', projectKey: 'payment', hostId: 'host_1', registeredAt: 1 }
}

const nativeEnvironment: PublicKnownRuntimeEnvironment = {
  id: 'env-native',
  name: 'Native',
  ...environmentBase
}

const focusedSettings = (environmentId: string | null): AppState['settings'] => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the worktree-slice fixture store reads only `activeRuntimeEnvironmentId` from settings.
  return { activeRuntimeEnvironmentId: environmentId } as AppState['settings']
}

function methodCalls(method: string): RuntimeEnvironmentCallRequest[] {
  return runtimeEnvironmentCall.mock.calls
    .map((args) => args[0])
    .filter(
      (args): args is RuntimeEnvironmentCallRequest =>
        typeof args === 'object' && args !== null && 'method' in args && args.method === method
    )
}

beforeEach(resetWorktreeSliceModuleMemory)

describe('worktree lineage refresh on a cloud session environment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  it('answers the focused fetchWorktreeLineage with the empty graph and no refused call', async () => {
    const store = createTestStore()
    store.setState({
      settings: focusedSettings('env-cloud'),
      runtimeEnvironments: [cloudEnvironment]
    })

    await store.getState().fetchWorktreeLineage()

    expect(methodCalls('worktree.lineageList')).toHaveLength(0)
    expect(mockApi.worktrees.listLineage).not.toHaveBeenCalled()
    expect(store.getState().worktreeLineageById).toEqual({})
    expect(store.getState().workspaceLineageByChildKey).toEqual({})
  })

  it('still lists lineage from a paired native runtime host', async () => {
    const store = createTestStore()
    const lineage = makeLineage({ worktreeId: 'repo1::/remote/wt1' })
    store.setState({
      settings: focusedSettings('env-native'),
      runtimeEnvironments: [cloudEnvironment, nativeEnvironment]
    })
    runtimeEnvironmentCall.mockImplementation(({ method }: RuntimeEnvironmentCallRequest) =>
      Promise.resolve({
        id: 'rpc-lineage',
        ok: true as const,
        result:
          method === 'worktree.lineageList' ? { lineage: { [lineage.worktreeId]: lineage } } : {},
        _meta: { runtimeId: 'runtime-native' }
      })
    )

    await store.getState().fetchWorktreeLineage()

    expect(methodCalls('worktree.lineageList')).toHaveLength(1)
    expect(store.getState().worktreeLineageById).toEqual({ [lineage.worktreeId]: lineage })
  })

  it('keeps the local coordinator for a local focus even when cloud rows exist', async () => {
    const store = createTestStore()
    const lineage = makeLineage()
    store.setState({
      settings: focusedSettings(null),
      runtimeEnvironments: [cloudEnvironment]
    })
    mockApi.worktrees.listLineage.mockResolvedValue({ [lineage.worktreeId]: lineage })

    await store.getState().fetchWorktreeLineage()

    expect(mockApi.worktrees.listLineage).toHaveBeenCalledOnce()
    expect(methodCalls('worktree.lineageList')).toHaveLength(0)
    expect(store.getState().worktreeLineageById).toEqual({ [lineage.worktreeId]: lineage })
  })

  it('skips the deferred bulk lineage refresh for a cloud focused host', async () => {
    const store = createTestStore()
    const worktree = makeWorktree({
      id: 'repo1::/remote/wt1',
      repoId: 'repo1',
      hostId: 'runtime:env-cloud',
      runtimeOwnerEnvironmentId: 'env-cloud'
    })
    store.setState({
      settings: focusedSettings('env-cloud'),
      runtimeEnvironments: [cloudEnvironment],
      worktreesByRepo: { repo1: [worktree] }
    })
    runtimeEnvironmentCall.mockImplementation(({ method }: RuntimeEnvironmentCallRequest) =>
      Promise.resolve({
        id: 'rpc-catalog',
        ok: true as const,
        result: method === 'worktree.lineageList' ? {} : makeDetectedResult('repo1', [worktree]),
        _meta: { runtimeId: 'runtime-cloud' }
      })
    )

    await store.getState().fetchWorktrees('repo1')

    expect(methodCalls('worktree.lineageList')).toHaveLength(0)
  })

  it('keeps the deferred bulk lineage refresh on a native focused host', async () => {
    const store = createTestStore()
    const lineage = makeLineage({ worktreeId: 'repo1::/remote/wt1' })
    const worktree = makeWorktree({
      id: 'repo1::/remote/wt1',
      repoId: 'repo1',
      hostId: 'runtime:env-native',
      runtimeOwnerEnvironmentId: 'env-native'
    })
    store.setState({
      settings: focusedSettings('env-native'),
      runtimeEnvironments: [cloudEnvironment, nativeEnvironment],
      worktreesByRepo: { repo1: [worktree] }
    })
    runtimeEnvironmentCall.mockImplementation(({ method }: RuntimeEnvironmentCallRequest) =>
      Promise.resolve({
        id: 'rpc-catalog',
        ok: true as const,
        result:
          method === 'worktree.lineageList'
            ? { lineage: { [lineage.worktreeId]: lineage } }
            : makeDetectedResult('repo1', [worktree]),
        _meta: { runtimeId: 'runtime-native' }
      })
    )

    await store.getState().fetchWorktrees('repo1')

    expect(methodCalls('worktree.lineageList')).toHaveLength(1)
    expect(store.getState().worktreeLineageById).toEqual({ [lineage.worktreeId]: lineage })
  })
})
