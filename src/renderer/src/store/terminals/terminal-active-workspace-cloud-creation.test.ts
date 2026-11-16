import '@/store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { AppState } from '../types'
import { createTestStore, makeWorktree, seedStore, TEST_REPO } from '../slices/store-test-helpers'

const createWebRuntimeSessionTerminalMock = vi.hoisted(() => vi.fn())

vi.mock('@/runtime/web-runtime-session', () => ({
  createWebRuntimeSessionTerminal: createWebRuntimeSessionTerminalMock
}))

vi.mock('@/lib/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: vi.fn()
}))

vi.mock('@/lib/web-client-location', () => ({
  isWebClientLocation: () => true
}))

const ENV_ID = 'env-cloud'

vi.mock('@/lib/worktree-operation-route', () => ({
  resolveWorktreeOperationRouteResult: () => ({
    kind: 'resolved',
    route: { executionHostId: 'runtime:env-cloud', runtimeEnvironmentId: 'env-cloud' }
  })
}))

function environment(cloud: boolean): PublicKnownRuntimeEnvironment {
  return {
    id: ENV_ID,
    name: 'Demo',
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    endpoints: [{ id: 'ws-1', kind: 'websocket', label: 'WebSocket', endpoint: 'ws://host' }],
    preferredEndpointId: 'ws-1',
    ...(cloud
      ? { cloudProject: { projectId: 'proj', projectKey: 'demo', hostId: 'host', registeredAt: 1 } }
      : {})
  }
}

function seedCloudWorkspace(store: ReturnType<typeof createTestStore>, cloud: boolean): void {
  seedStore(store, {
    activeWorktreeId: 'wt-1',
    runtimeEnvironments: [environment(cloud)],
    worktreesByRepo: {
      [TEST_REPO.id]: [
        makeWorktree({
          id: 'wt-1',
          repoId: TEST_REPO.id,
          hostId: 'runtime:env-cloud',
          runtimeOwnerEnvironmentId: ENV_ID
        })
      ]
    },
    groupsByWorktree: {
      'wt-1': [{ id: 'group-1', worktreeId: 'wt-1', activeTabId: null, tabOrder: [] }]
    },
    activeGroupIdByWorktree: { 'wt-1': 'group-1' },
    tabsByWorktree: {},
    tabBarOrderByWorktree: {}
  } satisfies Partial<AppState>)
}

describe('openNewTerminalTabInActiveWorkspace on a web client', () => {
  beforeEach(() => {
    createWebRuntimeSessionTerminalMock.mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('creates a client-owned tab in a cloud session (U118)', async () => {
    const store = createTestStore()
    seedCloudWorkspace(store, true)

    await store.getState().openNewTerminalTabInActiveWorkspace('group-1')

    expect(store.getState().tabsByWorktree['wt-1']).toHaveLength(1)
    expect(createWebRuntimeSessionTerminalMock).not.toHaveBeenCalled()
  })

  it('still leaves creation to the host mirror on a paired (non-cloud) web client', async () => {
    const store = createTestStore()
    seedCloudWorkspace(store, false)

    await store.getState().openNewTerminalTabInActiveWorkspace('group-1')

    expect(store.getState().tabsByWorktree['wt-1']).toBeUndefined()
    expect(createWebRuntimeSessionTerminalMock).toHaveBeenCalledTimes(1)
  })
})
