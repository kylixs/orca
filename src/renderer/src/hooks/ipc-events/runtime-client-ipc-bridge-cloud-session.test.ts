import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/runtime-compatibility-test-fixture'
import { registerRuntimeClientIpcBridge } from './runtime-client-ipc-bridge'
import type * as RuntimeClientEventsSyncModule from '../runtime-client-events-sync'
import type * as SubscriptionSelectionModule from './runtime-environment-subscription-selection'

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

type StoreSyncDeps = {
  initialDesiredEnvironmentIds: string[]
  initialReachableEnvironmentIds: string[]
  getDesiredEnvironmentIds: (state: unknown) => string[]
  getReachableEnvironmentIds: (state: unknown) => string[]
}

const syncDeps = vi.hoisted((): { current: SyncDeps | null } => ({ current: null }))
vi.mock('../runtime-client-events-sync', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeClientEventsSyncModule>()
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

const storeSyncDeps = vi.hoisted((): { current: StoreSyncDeps | null } => ({ current: null }))
vi.mock('./runtime-environment-subscription-selection', async (importOriginal) => {
  const actual = await importOriginal<typeof SubscriptionSelectionModule>()
  return {
    ...actual,
    createRuntimeEnvironmentStoreSyncSubscriber: (deps: StoreSyncDeps) => {
      storeSyncDeps.current = deps
      return () => undefined
    }
  }
})

const initialState = useAppStore.getState()

function runtimeHostRow(
  id: string,
  extras: Partial<PublicKnownRuntimeEnvironment> = {}
): PublicKnownRuntimeEnvironment {
  return {
    id,
    name: id,
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    endpoints: [
      { id: `ws-${id}`, kind: 'websocket', label: 'WS', endpoint: 'ws://example.invalid' }
    ],
    preferredEndpointId: `ws-${id}`,
    ...extras
  }
}

function setStateForRuntimeHosts(rows: PublicKnownRuntimeEnvironment[]): void {
  const status = createCompatibleRuntimeStatusResponse()
  if (!status.ok) {
    throw new Error('expected valid runtime status fixture')
  }
  useAppStore.setState({
    settings: null,
    runtimeEnvironments: rows,
    runtimeStatusByEnvironmentId: new Map(
      rows.map((row) => [row.id, { status: status.result, checkedAt: 1 }])
    ),
    fetchRuntimeEnvironmentRepos: vi.fn(async () => [])
  })
}

function setStateForRuntimeHost(): void {
  setStateForRuntimeHosts([runtimeHostRow('host-a')])
}

/** The web row carries its ticket marker outside the shared row type (web-runtime-environment). */
function cloudTicketRow(
  row: PublicKnownRuntimeEnvironment
): PublicKnownRuntimeEnvironment & { cloudLoginRequired: true } {
  return { ...row, cloudLoginRequired: true }
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
    storeSyncDeps.current = null
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

  it('gates both reachable-id readers off in a cloud session', () => {
    cloudScope.active = true
    setStateForRuntimeHost()
    const stop = register()
    try {
      // The registration-time set (which seeds the project refresh scheduler)
      // and the store-sync dep must both answer empty.
      expect(storeSyncDeps.current!.initialReachableEnvironmentIds).toEqual([])
      expect(storeSyncDeps.current!.initialDesiredEnvironmentIds).toEqual([])
      expect(storeSyncDeps.current!.getReachableEnvironmentIds(useAppStore.getState())).toEqual([])
      expect(storeSyncDeps.current!.getDesiredEnvironmentIds(useAppStore.getState())).toEqual([])
    } finally {
      stop()
    }
  })

  it('keeps the mirror and both reachable-id readers on a paired (non-cloud) client', () => {
    cloudScope.active = false
    setStateForRuntimeHost()
    const stop = register()
    try {
      expect(syncDeps.current!.getDesiredEnvironmentIds()).toEqual(['host-a'])
      expect(storeSyncDeps.current!.initialReachableEnvironmentIds).toEqual(['host-a'])
      expect(storeSyncDeps.current!.getReachableEnvironmentIds(useAppStore.getState())).toEqual([
        'host-a'
      ])
      expect(storeSyncDeps.current!.getDesiredEnvironmentIds(useAppStore.getState())).toEqual([
        'host-a'
      ])
    } finally {
      stop()
    }
  })
})

const cloudProject = {
  projectId: 'proj_1',
  projectKey: 'payment',
  hostId: 'host_1',
  registeredAt: 1
}

describe('runtime client-event mirror on cloud-session environment rows', () => {
  afterEach(() => {
    useAppStore.setState(initialState, true)
    syncDeps.current = null
    storeSyncDeps.current = null
    subscribeRuntimeClientEvents.mockClear()
    cloudScope.active = false
  })

  it('subscribes nothing on a desktop client whose only host is a cloud project', () => {
    setStateForRuntimeHosts([runtimeHostRow('cloud-a', { cloudProject })])
    const stop = register()
    try {
      expect(syncDeps.current!.getDesiredEnvironmentIds()).toEqual([])
      expect(storeSyncDeps.current!.initialDesiredEnvironmentIds).toEqual([])
      expect(storeSyncDeps.current!.initialReachableEnvironmentIds).toEqual([])
      expect(storeSyncDeps.current!.getReachableEnvironmentIds(useAppStore.getState())).toEqual([])
      expect(storeSyncDeps.current!.getDesiredEnvironmentIds(useAppStore.getState())).toEqual([])
      expect(subscribeRuntimeClientEvents).not.toHaveBeenCalled()
    } finally {
      stop()
    }
  })

  it('drops only the cloud row when a native host is paired beside it', () => {
    setStateForRuntimeHosts([runtimeHostRow('cloud-a', { cloudProject }), runtimeHostRow('host-a')])
    const stop = register()
    try {
      expect(syncDeps.current!.getDesiredEnvironmentIds()).toEqual(['host-a'])
      expect(storeSyncDeps.current!.initialDesiredEnvironmentIds).toEqual(['host-a'])
      expect(storeSyncDeps.current!.initialReachableEnvironmentIds).toEqual(['host-a'])
      expect(storeSyncDeps.current!.getReachableEnvironmentIds(useAppStore.getState())).toEqual([
        'host-a'
      ])
    } finally {
      stop()
    }
  })

  it('also drops a web row whose pairing came from a spent cloud ticket', () => {
    setStateForRuntimeHosts([cloudTicketRow(runtimeHostRow('web-ticket'))])
    const stop = register()
    try {
      expect(syncDeps.current!.getDesiredEnvironmentIds()).toEqual([])
      expect(storeSyncDeps.current!.getReachableEnvironmentIds(useAppStore.getState())).toEqual([])
    } finally {
      stop()
    }
  })
})
