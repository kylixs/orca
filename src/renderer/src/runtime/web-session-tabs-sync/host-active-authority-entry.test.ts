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
import { resetHostLayoutAdoptionForTests } from './host-layout-adoption'

type MockState = {
  runtimeEnvironments: PublicKnownRuntimeEnvironment[]
  tabGroupsByWorktree?: Record<string, unknown>
  tabsByWorktree: Record<string, unknown>
  unifiedTabsByWorktree: Record<string, { id: string }[]>
  activeTabIdByWorktree: Record<string, string | null>
  ptyIdsByTabId: Record<string, unknown>
  activateTab: ReturnType<typeof vi.fn>
  setActiveTab: ReturnType<typeof vi.fn>
}

const { applySpy, peekFocusSpy } = vi.hoisted(() => ({
  applySpy: vi.fn(),
  peekFocusSpy: vi.fn<() => { hostTabId: string } | null>(() => null)
}))
const { activateSpy } = vi.hoisted(() => ({ activateSpy: vi.fn(async () => true) }))
const { mockState } = vi.hoisted((): { mockState: MockState } => ({
  mockState: {
    runtimeEnvironments: [],
    tabsByWorktree: {},
    unifiedTabsByWorktree: {},
    activeTabIdByWorktree: {},
    ptyIdsByTabId: {},
    activateTab: vi.fn(),
    setActiveTab: vi.fn()
  }
}))

vi.mock('../../store', () => ({ useAppStore: { getState: () => mockState } }))
vi.mock('../web-runtime-session-environment', () => ({
  captureWebSessionIntentOwner: () => ({ environmentId: ENV })
}))
vi.mock('../web-session-focus-intent', () => ({ peekWebSessionFocusIntent: peekFocusSpy }))
vi.mock('../web-runtime-session', () => ({ activateWebRuntimeSessionTab: activateSpy }))
vi.mock('./tracking-mappings', () => ({
  resolveLocalTabIdForHostSessionTab: ({ hostTabId }: { hostTabId: string }) =>
    `web-terminal-${hostTabId}`
}))
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

const ENV = 'cloud-u138'
const WT = 'repo::/checkout'
const HOST_ACTIVE = 'web-terminal-026d'
const THIRD = 'web-terminal-9be1'

type StreamSnapshot = RuntimeMobileSessionTabsResult & { type: 'snapshot' }

type FrameCallbacks = {
  onResponse: (response: { ok: true; result: StreamSnapshot }) => void
}

function cloudEnvironment(): PublicKnownRuntimeEnvironment {
  return {
    id: ENV,
    name: 'zhangsan (cloud session)',
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    cloudProject: {
      projectId: 'proj-u138',
      projectKey: 'proj-u138',
      hostId: 'host-u138',
      registeredAt: 1
    },
    preferredEndpointId: 'ws-1',
    endpoints: []
  }
}

/** 3 tabs / 2 groups: the host active is never the last created tab. */
function snapshot(activeLocalTabId: string): StreamSnapshot {
  const parent = activeLocalTabId.replace('web-terminal-', '')
  return {
    type: 'snapshot',
    worktree: WT,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: 'group-right',
    activeTabId: `${parent}::leaf`,
    activeTabType: 'terminal',
    tabGroups: [
      { id: 'group-left', activeTabId: 'f5ff', tabOrder: ['f5ff', '9be1'] },
      { id: 'group-right', activeTabId: parent, tabOrder: [parent] }
    ],
    tabGroupLayout: {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: 'group-left' },
      second: { type: 'leaf', groupId: 'group-right' }
    },
    tabs: [terminalTab('f5ff', true), terminalTab('9be1', false), terminalTab(parent, false)]
  }
}

function terminalTab(parent: string, isActive: boolean) {
  return {
    id: `${parent}::leaf`,
    parentTabId: parent,
    type: 'terminal' as const,
    title: parent,
    leafId: `${parent}::leaf`,
    isActive,
    status: 'pending-handle' as const,
    terminal: null
  }
}

let callbacks: FrameCallbacks
let subscribe: ReturnType<typeof vi.fn>

function cloudState(restoredActive: string | null): void {
  mockState.runtimeEnvironments = [cloudEnvironment()]
  mockState.tabsByWorktree = { [WT]: [{ id: 'web-terminal-f5ff' }, { id: HOST_ACTIVE }] }
  mockState.unifiedTabsByWorktree = { [WT]: [{ id: 'web-terminal-f5ff' }, { id: HOST_ACTIVE }] }
  mockState.activeTabIdByWorktree = { [WT]: restoredActive }
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

async function feed(activeLocalTabId: string): Promise<void> {
  callbacks.onResponse({ ok: true, result: snapshot(activeLocalTabId) })
  await vi.waitFor(() => expect(applySpy).toHaveBeenCalled())
}

function lastOptions(): unknown {
  return applySpy.mock.calls.at(-1)?.[0]
}

beforeEach(async () => {
  applySpy.mockReset()
  activateSpy.mockReset()
  activateSpy.mockResolvedValue(true)
  peekFocusSpy.mockReset()
  peekFocusSpy.mockReturnValue(null)
  resetWebCloudSessionCapabilities()
  resetHostLayoutAdoptionForTests()
  replaceRuntimeEnvironmentRevisions([{ id: ENV, createdAt: 1, pairingRevision: 1 }])
  recordWebCloudSessionCapabilities(ENV, [CLOUD_SESSION_TABS_RESTORE_CAPABILITY])
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

describe('cloud session host-active authority (U138 phase 6)', () => {
  it('adopts the host active at entry and never writes one back', async () => {
    cloudState('web-terminal-f5ff')
    const dispose = install()
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalled())

    await feed(HOST_ACTIVE)

    expect(lastOptions()).toEqual({ adoptHostLayout: true, hostActiveAuthoritative: true })
    expect(activateSpy).not.toHaveBeenCalled()
    dispose()
  })

  it('keeps following host active broadcasts after the one-shot adoption is consumed', async () => {
    const dispose = install()
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalled())

    await feed(HOST_ACTIVE)
    applySpy.mockClear()
    await feed(THIRD)

    expect(lastOptions()).toEqual({ hostActiveAuthoritative: true })
    expect(activateSpy).not.toHaveBeenCalled()
    dispose()
  })

  it('stands down while a local gesture intent is pending', async () => {
    const dispose = install()
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalled())

    await feed(HOST_ACTIVE)
    applySpy.mockClear()
    peekFocusSpy.mockReturnValue({ hostTabId: '9be1' })
    await feed(THIRD)

    expect(lastOptions()).toBeUndefined()
    expect(activateSpy).not.toHaveBeenCalled()
    dispose()
  })

  it('follows the host echo of a gesture without sending a second activate', async () => {
    const dispose = install()
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalled())

    await feed(HOST_ACTIVE)
    // The gesture path itself (activateWebRuntimeSessionTab) sends the one activate; the
    // subscription's job is to follow the echoed host active afterwards.
    applySpy.mockClear()
    await feed(THIRD)

    expect(lastOptions()).toEqual({ hostActiveAuthoritative: true })
    expect(activateSpy).not.toHaveBeenCalled()
    dispose()
  })
})
