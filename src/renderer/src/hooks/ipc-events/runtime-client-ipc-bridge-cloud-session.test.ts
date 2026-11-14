import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/runtime-compatibility-test-fixture'
import { registerRuntimeClientIpcBridge } from './runtime-client-ipc-bridge'

const cloudScope = vi.hoisted(() => ({ active: false }))
vi.mock('@/web/web-cloud-session-scope', () => ({
  isActiveWebClientCloudSession: () => cloudScope.active
}))

const subscribeRuntimeClientEvents = vi.hoisted(() =>
  vi.fn(async () => ({ unsubscribe: () => undefined }))
)
vi.mock('@/runtime/runtime-client-events', () => ({ subscribeRuntimeClientEvents }))

type SyncDeps = {
  getDesiredEnvironmentIds: () => string[]
  subscribe: unknown
  onEvent: unknown
}

const syncDeps: { current: SyncDeps | null } = vi.hoisted(() => ({ current: null }))
vi.mock('../runtime-client-events-sync', async (importOriginal) => {
  const actual = await importOriginal<object>()
  return {
    ...actual,
    createRuntimeClientEventsSync: (deps: SyncDeps) => {
      syncDeps.current = deps
      return {
        sync: () => undefined,
        stop: () => undefined
      }
    }
  }
})

const initialState = useAppStore.getState()

function setStateForRuntimeHost(): void {
  const status = createCompatibleRuntimeStatusResponse()
  if (!status.ok) {
    throw new Error('expected valid runtime status fixture')
  }
  useAppStore.setState({
    settings: null,
    runtimeEnvironments: [
      {
        id: 'host-a',
        name: 'Host A',
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: null,
        runtimeId: null,
        endpoints: [
          { id: 'ws-a', kind: 'websocket', label: 'WS', endpoint: 'ws://example.invalid' }
        ],
        preferredEndpointId: 'ws-a'
      }
    ],
    runtimeStatusByEnvironmentId: new Map([['host-a', { status: status.result, checkedAt: 1 }]]),
    fetchRuntimeEnvironmentRepos: vi.fn(async () => [])
  })
}

function register(): () => void {
  const unsubs: (() => void)[] = []
  const stop = registerRuntimeClientIpcBridge(unsubs, {
    worktreeChangeRefreshQueue: { enqueue: vi.fn(), dispose: vi.fn() },
    activateNotifiedWorktree: vi.fn(async () => {})
  })
  return () => {
    stop()
    unsubs.forEach((unsubscribe) => unsubscribe())
  }
}

describe('runtime client-event mirror under a cloud session', () => {
  afterEach(() => {
    useAppStore.setState(initialState, true)
    syncDeps.current = null
    subscribeRuntimeClientEvents.mockClear()
    cloudScope.active = false
  })

  it('desires no client-event subscription in a cloud session', () => {
    cloudScope.active = true
    setStateForRuntimeHost()
    const stop = register()
    try {
      expect(syncDeps.current).not.toBeNull()
      expect(syncDeps.current!.getDesiredEnvironmentIds()).toEqual([])
      expect(subscribeRuntimeClientEvents).not.toHaveBeenCalled()
    } finally {
      stop()
    }
  })

  it('keeps the mirror on a paired (non-cloud) client', () => {
    cloudScope.active = false
    setStateForRuntimeHost()
    const stop = register()
    try {
      expect(syncDeps.current!.getDesiredEnvironmentIds()).toEqual(['host-a'])
    } finally {
      stop()
    }
  })
})
