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

const { applySpy } = vi.hoisted(() => ({ applySpy: vi.fn() }))
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
vi.mock('../web-session-focus-intent', () => ({ peekWebSessionFocusIntent: () => null }))
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
import { resetRestoredActiveReassertForTests } from './restored-active-reassert'

const ENV = 'cloud-u138'
const WT = 'repo::/checkout'
const RESTORED = 'web-terminal-f5ff'
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

/** 3 tabs / 2 groups: the active tab is not the last created one. */
function snapshot(): StreamSnapshot {
  return {
    type: 'snapshot',
    worktree: WT,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: 'group-right',
    activeTabId: '026d::leaf',
    activeTabType: 'terminal',
    tabGroups: [
      { id: 'group-left', activeTabId: 'f5ff', tabOrder: ['f5ff', '9be1'] },
      { id: 'group-right', activeTabId: '026d', tabOrder: ['026d'] }
    ],
    tabGroupLayout: {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: 'group-left' },
      second: { type: 'leaf', groupId: 'group-right' }
    },
    tabs: [terminalTab('f5ff', true), terminalTab('9be1', false), terminalTab('026d', false)]
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
  mockState.tabsByWorktree = { [WT]: [{ id: RESTORED }, { id: HOST_ACTIVE }, { id: THIRD }] }
  mockState.unifiedTabsByWorktree = {
    [WT]: [{ id: RESTORED }, { id: HOST_ACTIVE }, { id: THIRD }]
  }
  mockState.activeTabIdByWorktree = { [WT]: restoredActive }
  mockState.ptyIdsByTabId = {}
  mockState.activateTab.mockImplementation((tabId: string) => {
    mockState.activeTabIdByWorktree[WT] = tabId
  })
  mockState.setActiveTab.mockImplementation((tabId: string) => {
    mockState.activeTabIdByWorktree[WT] = tabId
  })
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

beforeEach(async () => {
  applySpy.mockReset()
  activateSpy.mockReset()
  activateSpy.mockResolvedValue(true)
  mockState.activateTab.mockReset()
  mockState.setActiveTab.mockReset()
  resetWebCloudSessionCapabilities()
  resetHostLayoutAdoptionForTests()
  resetRestoredActiveReassertForTests()
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

describe('restored active capture point (U138 phase 5)', () => {
  it('writes back the active captured before any frame applied, once, even after frames moved it', async () => {
    cloudState(RESTORED)
    const dispose = install()
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalled())

    // An earlier frame already overwrote the restored active with the host's answer. Reading the
    // store at adoption time would compare it equal to the host and stay silent (the regression).
    mockState.activeTabIdByWorktree[WT] = HOST_ACTIVE

    callbacks.onResponse({ ok: true, result: snapshot() })
    await vi.waitFor(() => expect(activateSpy).toHaveBeenCalled())

    expect(activateSpy).toHaveBeenCalledTimes(1)
    expect(activateSpy).toHaveBeenCalledWith({
      worktreeId: WT,
      tabId: RESTORED,
      environmentId: ENV
    })
    // The local active is restored, not left on the host's 026d.
    expect(mockState.activeTabIdByWorktree[WT]).toBe(RESTORED)
    dispose()
  })

  it('writes nothing when the captured active already matches the host', async () => {
    cloudState(HOST_ACTIVE)
    const dispose = install()
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalled())

    callbacks.onResponse({ ok: true, result: snapshot() })
    await vi.waitFor(() => expect(applySpy).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(activateSpy).not.toHaveBeenCalled()
    expect(mockState.activeTabIdByWorktree[WT]).toBe(HOST_ACTIVE)
    dispose()
  })

  it('does not override local when the host refuses the re-assert, and never retries it', async () => {
    cloudState(RESTORED)
    activateSpy.mockResolvedValue(false)
    const dispose = install()
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalled())

    mockState.activeTabIdByWorktree[WT] = HOST_ACTIVE
    callbacks.onResponse({ ok: true, result: snapshot() })
    await vi.waitFor(() => expect(activateSpy).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 0))

    // Host is authoritative: a refused request must not be shown locally, and a later frame in
    // the same entry cannot repeat the write.
    expect(mockState.activeTabIdByWorktree[WT]).toBe(HOST_ACTIVE)
    callbacks.onResponse({ ok: true, result: snapshot() })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(activateSpy).toHaveBeenCalledTimes(1)
    dispose()
  })
})
