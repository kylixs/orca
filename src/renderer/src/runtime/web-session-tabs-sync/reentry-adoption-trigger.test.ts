// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLOUD_SESSION_TABS_RESTORE_CAPABILITY } from '../../../../shared/cloud-workspace-info'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { replaceRuntimeEnvironmentRevisions } from '../runtime-environment-revision'
import {
  recordWebCloudSessionCapabilities,
  resetWebCloudSessionCapabilities
} from '../../web/web-cloud-session-capabilities'
import { resetHostLayoutAdoptionForTests, requestHostLayoutAdoption } from './host-layout-adoption'

type MockState = {
  runtimeEnvironments: PublicKnownRuntimeEnvironment[]
  tabsByWorktree: Record<string, unknown>
  ptyIdsByTabId: Record<string, unknown>
}

const { applySpy } = vi.hoisted(() => ({ applySpy: vi.fn() }))
const { mockState } = vi.hoisted((): { mockState: MockState } => ({
  mockState: { runtimeEnvironments: [], tabsByWorktree: {}, ptyIdsByTabId: {} }
}))

vi.mock('../../store', () => ({ useAppStore: { getState: () => mockState } }))
vi.mock('../web-session-terminal-orphan-recovery', () => ({
  recoverWebSessionTerminalOrphansBeforeApply: vi.fn(
    async (_state: unknown, frame: RuntimeMobileSessionTabsResult) => frame
  )
}))
vi.mock('./tracking', () => ({
  recordReceivedWebSessionTabsSnapshot: vi.fn(() => 1),
  shouldApplyRecoveredWebSessionTabsSnapshot: vi.fn(() => true)
}))
vi.mock('./tracking-decisions', () => ({
  decideWebSessionTabsSnapshot: vi.fn(() => ({ apply: true })),
  shouldBootstrapInitialWebRuntimeTerminal: vi.fn(() => false),
  shouldRespawnWebRuntimeTerminalAfterWake: vi.fn(() => false),
  shouldSyncRuntimeSessionTabs: vi.fn(() => true)
}))
vi.mock('./tracking-lifecycle', () => ({
  acceptReplayedWebSessionTabsSnapshot: vi.fn(),
  getWebSessionTabsTrackingGeneration: vi.fn(() => 1)
}))
vi.mock('./publisher-identity-fences', () => ({
  acceptSessionTabsRuntimeId: vi.fn(() => true),
  getSessionTabsRuntimeIdFromResponse: vi.fn(() => undefined)
}))
vi.mock('./store-patch', () => ({
  applyWebSessionTabsStorePatch: vi.fn((build: (state: unknown) => unknown) => {
    build({})
    return null
  })
}))
vi.mock('./snapshot-api', () => ({
  applyWebSessionTabsSnapshot: vi.fn(
    (_state: unknown, _snapshot: unknown, _env: unknown, _now: unknown, options?: unknown) => {
      applySpy(options)
      return {}
    }
  )
}))

import { installActiveSessionTabsSubscription } from './active-session-subscription'

const ENV = 'cloud-u113'
const WT = 'repo::/checkout'

type StreamSnapshot = RuntimeMobileSessionTabsResult & { type: 'snapshot' }

type FrameCallbacks = {
  onResponse: (response: { ok: true; result: StreamSnapshot }) => void
}

function cloudEnvironment(): PublicKnownRuntimeEnvironment {
  return {
    id: ENV,
    name: 'payment-service (cloud session)',
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    cloudProject: {
      projectId: 'proj-u113',
      projectKey: 'proj-u113',
      hostId: 'host-u113',
      registeredAt: 1
    },
    preferredEndpointId: 'ws-1',
    endpoints: []
  }
}

function snapshot(groups: string[]): StreamSnapshot {
  return {
    type: 'snapshot',
    worktree: WT,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: groups[0] ?? null,
    activeTabId: null,
    activeTabType: 'terminal',
    tabGroups: groups.map((id) => ({ id, activeTabId: `${id}-tab`, tabOrder: [`${id}-tab`] })),
    tabGroupLayout: { type: 'leaf', groupId: groups[0] ?? 'group-left' },
    tabs: []
  }
}

let callbacks: FrameCallbacks
let subscribe: ReturnType<typeof vi.fn>

function cloudState(): void {
  mockState.runtimeEnvironments = [cloudEnvironment()]
  mockState.tabsByWorktree = { [WT]: [] }
  mockState.ptyIdsByTabId = {}
}

function install(): () => void {
  return (
    installActiveSessionTabsSubscription({
      activeWorktreeId: WT,
      activeWorktreeRuntimeEnvironmentId: ENV,
      activeWorktreeRuntimeConnectionGeneration: 1,
      activeWorktreeRuntimePairingRevision: 1,
      workspaceSessionReady: true,
      visibilitySnapshotReceipt: { current: () => {} },
      visibilitySnapshotApply: { current: () => true },
      visibilitySnapshotAccepted: { current: () => {} }
    }) ?? (() => {})
  )
}

async function feed(groups: string[]): Promise<void> {
  callbacks.onResponse({ ok: true, result: snapshot(groups) })
  await vi.waitFor(() => expect(applySpy).toHaveBeenCalled())
}

function adoptCalls(): unknown[] {
  return applySpy.mock.calls.map(
    ([options]) => (options as { adoptHostLayout?: boolean } | undefined)?.adoptHostLayout
  )
}

beforeEach(async () => {
  applySpy.mockReset()
  resetWebCloudSessionCapabilities()
  resetHostLayoutAdoptionForTests()
  replaceRuntimeEnvironmentRevisions([{ id: ENV, createdAt: 1, pairingRevision: 1 }])
  recordWebCloudSessionCapabilities(ENV, [CLOUD_SESSION_TABS_RESTORE_CAPABILITY])
  cloudState()
  subscribe = vi.fn(async (_args: unknown, received: FrameCallbacks) => {
    callbacks = received
    return { unsubscribe: vi.fn() }
  })
  Object.assign(window, { api: { runtimeEnvironments: { subscribe, call: vi.fn() } } })
  await Promise.resolve()
})

afterEach(() => {
  resetWebCloudSessionCapabilities()
  resetHostLayoutAdoptionForTests()
  replaceRuntimeEnvironmentRevisions([])
  vi.restoreAllMocks()
})

describe('cloud workspace entry adoption trigger (U113 D2)', () => {
  it('re-adopts on a same-worktree re-entry even though the subscription never reinstalls', async () => {
    const dispose = install()
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalled())

    // First visit: the install-time fallback adopts the host layout once.
    await feed(['group-left'])
    expect(adoptCalls()).toEqual([true])

    // A later frame in the same visit stays client-owned.
    applySpy.mockClear()
    callbacks.onResponse({ ok: true, result: snapshot(['group-left', 'group-right']) })
    await vi.waitFor(() => expect(applySpy).toHaveBeenCalled())
    expect(adoptCalls()).toEqual([undefined])

    // Re-entry keeps activeWorktreeId, so no new install happens; the explicit entry action is
    // the only trigger. Without it this frame would stay client-owned (the D2 regression).
    applySpy.mockClear()
    requestHostLayoutAdoption(WT)
    callbacks.onResponse({ ok: true, result: snapshot(['group-left', 'group-right']) })
    await vi.waitFor(() => expect(applySpy).toHaveBeenCalled())
    expect(adoptCalls()).toEqual([true])

    // One entry, one adoption: the request is consumed by that frame.
    applySpy.mockClear()
    callbacks.onResponse({ ok: true, result: snapshot(['group-left', 'group-right']) })
    await vi.waitFor(() => expect(applySpy).toHaveBeenCalled())
    expect(adoptCalls()).toEqual([undefined])
    expect(subscribe).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('never adopts for a host that advertised no restore capability', async () => {
    resetWebCloudSessionCapabilities()
    recordWebCloudSessionCapabilities(ENV, [])
    const dispose = install()

    expect(subscribe).not.toHaveBeenCalled()
    expect(applySpy).not.toHaveBeenCalled()
    dispose()
  })

  it('waits for a frame that actually carries groups instead of consuming the entry', async () => {
    const dispose = install()
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalled())

    applySpy.mockClear()
    requestHostLayoutAdoption(WT)
    callbacks.onResponse({ ok: true, result: snapshot([]) })
    await vi.waitFor(() => expect(applySpy).toHaveBeenCalled())
    expect(adoptCalls()).toEqual([undefined])

    // The entry's adoption is still armed for the inventory frame that holds the groups.
    applySpy.mockClear()
    callbacks.onResponse({ ok: true, result: snapshot(['group-left', 'group-right']) })
    await vi.waitFor(() => expect(applySpy).toHaveBeenCalled())
    expect(adoptCalls()).toEqual([true])
    dispose()
  })
})
