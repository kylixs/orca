import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { createTestStore } from './store-test-helpers'

const localRepo: Repo = {
  id: 'local-repo',
  path: '/local',
  displayName: 'Local',
  badgeColor: '#000',
  addedAt: 1
}

const nativeRepo: Repo = {
  id: 'native-runtime-repo',
  path: '/srv/native',
  displayName: 'Native runtime project',
  badgeColor: '#000',
  addedAt: 1
}

/** The row a cloud sign-in adds: the platform project list is its source, not the host's repo catalog. */
const cloudRepo: Repo = {
  id: 'cloud-repo',
  path: '/srv/payment',
  displayName: 'Payment',
  badgeColor: '#000',
  addedAt: 1,
  executionHostId: 'runtime:cloud-1'
}

const cloudEnvironment = {
  id: 'cloud-1',
  name: 'Payment',
  cloudProject: { projectId: 'proj_1', projectKey: 'payment', hostId: 'host_1', registeredAt: 1 }
}

const runtimeEnvironmentCall = vi.fn()
const reposList = vi.fn()
const skippedWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  runtimeEnvironmentCall.mockReset()
  reposList.mockReset()
  skippedWarn.mockClear()
  reposList.mockResolvedValue([localRepo])
  vi.stubGlobal('window', {
    api: {
      repos: { list: reposList },
      projects: {
        list: vi.fn().mockResolvedValue([]),
        listHostSetups: vi.fn().mockResolvedValue([])
      },
      projectGroups: { list: vi.fn().mockResolvedValue([]) },
      folderWorkspaces: { list: vi.fn().mockResolvedValue([]) },
      runtimeEnvironments: {
        list: vi.fn().mockResolvedValue([cloudEnvironment, { id: 'env-native', name: 'Native' }]),
        call: (args: RuntimeEnvironmentCallRequest) =>
          createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
      }
    },
    dispatchEvent: vi.fn()
  })
})

function mockNativeRuntimeCatalog(): void {
  runtimeEnvironmentCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    if (args.method === 'repo.list') {
      return {
        id: 'rpc-repo-list',
        ok: true as const,
        result: { repos: [nativeRepo] },
        _meta: { runtimeId: 'runtime-native' }
      }
    }
    if (args.method === 'projectGroup.list') {
      return {
        id: 'rpc-project-group-list',
        ok: true as const,
        result: { groups: [] },
        _meta: { runtimeId: 'runtime-native' }
      }
    }
    if (args.method === 'folderWorkspace.list') {
      return {
        id: 'rpc-folder-workspace-list',
        ok: true as const,
        result: { folderWorkspaces: [] },
        _meta: { runtimeId: 'runtime-native' }
      }
    }
    return {
      id: 'rpc-other',
      ok: true as const,
      result: {},
      _meta: { runtimeId: 'runtime-native' }
    }
  })
}

function methodCalls(method: string): RuntimeEnvironmentCallRequest[] {
  return runtimeEnvironmentCall.mock.calls
    .map((args) => args[0])
    .filter(
      (args): args is RuntimeEnvironmentCallRequest =>
        typeof args === 'object' && args !== null && 'method' in args && args.method === method
    )
}

describe('all-host catalog loads on a cloud runtime host', () => {
  it('keeps the cloud project row without asking the host for repo.list', async () => {
    mockNativeRuntimeCatalog()
    const store = createTestStore()
    store.setState({ repos: [cloudRepo] })

    await store.getState().fetchReposForAllHosts()

    expect(methodCalls('repo.list')).toHaveLength(1)
    expect(skippedWarn).not.toHaveBeenCalledWith(
      expect.stringContaining('Skipped repos for runtime environment cloud-1'),
      expect.anything()
    )
    expect(store.getState().repos.map((repo) => repo.id)).toEqual([
      'cloud-repo',
      'local-repo',
      'native-runtime-repo'
    ])
    expect(store.getState().repos.find((repo) => repo.id === 'cloud-repo')?.executionHostId).toBe(
      'runtime:cloud-1'
    )
  })

  it('keeps the native runtime host catalog merge beside the skipped cloud host', async () => {
    mockNativeRuntimeCatalog()
    const store = createTestStore()

    await store.getState().fetchReposForAllHosts()

    expect(store.getState().repos.map((repo) => repo.id)).toEqual([
      'local-repo',
      'native-runtime-repo'
    ])
  })

  it('skips the refused project-group and folder-workspace catalogs on the cloud host too', async () => {
    mockNativeRuntimeCatalog()
    const store = createTestStore()

    await store.getState().fetchProjectGroupsForAllHosts()
    await store.getState().fetchFolderWorkspacesForAllHosts()

    expect(methodCalls('projectGroup.list')).toHaveLength(1)
    expect(methodCalls('folderWorkspace.list')).toHaveLength(1)
    expect(skippedWarn).not.toHaveBeenCalled()
  })
})
