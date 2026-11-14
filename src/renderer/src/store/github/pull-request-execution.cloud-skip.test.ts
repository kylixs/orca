import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import type { RuntimeEnvironmentCallRequest } from '../../runtime/runtime-compatibility-test-fixture'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  runtimeEnvironmentCall
} from '../slices/github-slice-test-harness'

const cloudEnvironment: PublicKnownRuntimeEnvironment = {
  id: 'env-cloud',
  name: 'Payment',
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: null,
  runtimeId: null,
  preferredEndpointId: 'endpoint-1',
  endpoints: [
    {
      id: 'endpoint-1',
      kind: 'websocket',
      label: 'Cloud',
      endpoint: 'wss://cloud.example'
    }
  ],
  cloudProject: {
    projectId: 'proj_1',
    projectKey: 'payment',
    hostId: 'host_1',
    registeredAt: 1
  }
}

const nativeEnvironment: PublicKnownRuntimeEnvironment = {
  id: 'env-native',
  name: 'Native',
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: null,
  runtimeId: null,
  preferredEndpointId: 'endpoint-1',
  endpoints: [
    {
      id: 'endpoint-1',
      kind: 'websocket',
      label: 'Native',
      endpoint: 'wss://native.example'
    }
  ]
}

function methodCalls(method: string): RuntimeEnvironmentCallRequest[] {
  return runtimeEnvironmentCall.mock.calls
    .map((args) => args[0])
    .filter(
      (args): args is RuntimeEnvironmentCallRequest =>
        typeof args === 'object' && args !== null && 'method' in args && args.method === method
    )
}

beforeEach(() => {
  vi.clearAllMocks()
  resetRemoteRuntimeMocks()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => vi.restoreAllMocks())

describe('pull request lookups on a cloud session environment', () => {
  it('skips the refused github.prForBranch call instead of reading as "no PR"', async () => {
    const store = createTestStore()
    store.setState({
      repos: [
        {
          id: 'repo-1',
          path: '/repo',
          kind: 'git',
          displayName: 'Payment',
          badgeColor: '#000',
          addedAt: 1,
          executionHostId: 'runtime:env-cloud'
        }
      ],
      settings: createGlobalSettingsFixture({
        activeRuntimeEnvironmentId: 'env-cloud'
      }),
      runtimeEnvironments: [cloudEnvironment]
    })

    await expect(store.getState().fetchPRForBranch('/repo', 'feature/cloud')).resolves.toBeNull()

    expect(methodCalls('github.prForBranch')).toHaveLength(0)
    expect(mockApi.gh.prForBranch).not.toHaveBeenCalled()
    expect(mockApi.gh.refreshPRNow).not.toHaveBeenCalled()
  })

  it('still asks a native runtime host for the branch PR', async () => {
    const store = createTestStore()
    store.setState({
      repos: [
        {
          id: 'repo-1',
          path: '/repo',
          kind: 'git',
          displayName: 'Payment',
          badgeColor: '#000',
          addedAt: 1,
          executionHostId: 'runtime:env-native'
        }
      ],
      settings: createGlobalSettingsFixture({
        activeRuntimeEnvironmentId: 'env-native'
      }),
      runtimeEnvironments: [cloudEnvironment, nativeEnvironment]
    })
    runtimeEnvironmentCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
      if (args.method === 'github.prForBranch') {
        return {
          id: 'rpc-pr',
          ok: true as const,
          result: null,
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

    await expect(store.getState().fetchPRForBranch('/repo', 'feature/native')).resolves.toBeNull()

    expect(methodCalls('github.prForBranch')).toHaveLength(1)
  })

  it('keeps local (non-runtime) lookups on the desktop coordinator', async () => {
    const store = createTestStore()
    store.setState({
      repos: [
        {
          id: 'repo-1',
          path: '/repo',
          kind: 'git',
          displayName: 'Payment',
          badgeColor: '#000',
          addedAt: 1
        }
      ],
      settings: createGlobalSettingsFixture({
        activeRuntimeEnvironmentId: null
      }),
      runtimeEnvironments: [cloudEnvironment]
    })
    mockApi.gh.refreshPRNow.mockResolvedValueOnce(null)

    await expect(store.getState().fetchPRForBranch('/repo', 'feature/local')).resolves.toBeNull()

    expect(mockApi.gh.refreshPRNow).toHaveBeenCalledOnce()
    expect(methodCalls('github.prForBranch')).toHaveLength(0)
  })
})
