// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { toWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'
import type { WebSessionTabsSyncState } from './state'

const storeHarness = vi.hoisted(() => {
  let state: WebSessionTabsSyncState | undefined
  const requireState = (): WebSessionTabsSyncState => {
    if (!state) {
      throw new Error('store state was not initialized')
    }
    return state
  }
  return {
    useAppStore: {
      getState: () => requireState(),
      setState: (update: unknown) => {
        const current = requireState()
        const patch =
          typeof update === 'function' ? Reflect.apply(update, undefined, [current]) : update
        if (patch !== current && typeof patch === 'object' && patch !== null) {
          state = { ...current, ...patch }
        }
      }
    },
    replaceState: (next: WebSessionTabsSyncState) => {
      state = next
    },
    currentState: () => requireState()
  }
})

vi.mock('../../store', () => ({ useAppStore: storeHarness.useAppStore }))

// The entry listAll apply is gated behind orphan recovery; holding it lets a host publish land first.
// One recovery runs per snapshot, so every pending call must be released.
type RecoveryGate = { releases: (() => void)[] }

const recoveryGate = vi.hoisted((): RecoveryGate => ({ releases: [] }))

vi.mock('../web-session-terminal-orphan-recovery', () => ({
  recoverWebSessionTerminalOrphansBeforeApply: vi.fn(
    async (_state: unknown, snapshot: RuntimeMobileSessionTabsResult) => {
      await new Promise<void>((resolve) => {
        recoveryGate.releases.push(resolve)
      })
      return snapshot
    }
  )
}))

function releaseRecovery(): void {
  const releases = recoveryGate.releases.splice(0)
  releases.forEach((release) => release())
}

import { loadInitialWebSessionTabs } from './load-initial'
import { recordReceivedWebSessionTabsSnapshot } from './tracking'
import { decideWebSessionTabsSnapshot } from './tracking-decisions'
import { applyWebSessionTabsSnapshot } from './snapshot-api'
import {
  ENV,
  LEAF_ID,
  NOW,
  SECOND_LEAF_ID,
  THIRD_LEAF_ID,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from '../web-session-tabs-sync-test-harness'

const WT2 = 'repo::/worktree-2'
const LATER_HOST = 'host-later'
const ENTRY_HOST = 'host-entry'
const INVENTORY_ONLY_HOST = 'host-inventory-only'
const LATER_TAB = toWebTerminalSurfaceTabId(LATER_HOST)
const ENTRY_TAB = toWebTerminalSurfaceTabId(ENTRY_HOST)
const INVENTORY_ONLY_TAB = toWebTerminalSurfaceTabId(INVENTORY_ONLY_HOST)

function terminal(
  hostTabId: string,
  leafId: string
): RuntimeMobileSessionTabsResult['tabs'][number] {
  return {
    type: 'terminal',
    id: `${hostTabId}::${leafId}`,
    title: hostTabId,
    parentTabId: hostTabId,
    leafId,
    isActive: false,
    status: 'ready',
    terminal: `terminal-${hostTabId}`
  }
}

function hostSnapshot(
  worktree: string,
  activeHostTabId: string,
  version: number,
  tabs: RuntimeMobileSessionTabsResult['tabs']
): RuntimeMobileSessionTabsResult {
  const groupId = `group-${activeHostTabId.replace(/^host-/, '')}`
  return makeSnapshot(tabs, {
    worktree,
    activeGroupId: groupId,
    activeTabId: tabs.find((tab) => tab.type === 'terminal')?.id ?? null,
    snapshotVersion: version,
    tabGroups: [{ id: groupId, activeTabId: activeHostTabId, tabOrder: [activeHostTabId] }],
    tabGroupLayout: { type: 'leaf', groupId }
  })
}

function applyHostPublish(frame: RuntimeMobileSessionTabsResult): void {
  recordReceivedWebSessionTabsSnapshot(ENV, frame, undefined, undefined)
  expect(decideWebSessionTabsSnapshot(frame, ENV).apply).toBe(true)
  const state = storeHarness.currentState()
  const patch = applyWebSessionTabsSnapshot(state, frame, ENV, NOW, {
    hostActiveAuthoritative: true
  })
  if (patch !== state) {
    storeHarness.useAppStore.setState(patch)
  }
}

// Production's subscribeAll subscription applies the same frame with no apply options, so the
// still-present visible tab stays sticky instead of following the host's active (audit P3-1).
function applyHostPublishViaSubscribeAll(frame: RuntimeMobileSessionTabsResult): void {
  recordReceivedWebSessionTabsSnapshot(ENV, frame, undefined, undefined)
  expect(decideWebSessionTabsSnapshot(frame, ENV).apply).toBe(true)
  const state = storeHarness.currentState()
  const patch = applyWebSessionTabsSnapshot(state, frame, ENV, NOW)
  if (patch !== state) {
    storeHarness.useAppStore.setState(patch)
  }
}

describe('late initial listAll apply ordering (U138 H-A)', () => {
  beforeEach(() => {
    resetWebSessionTabsSyncTestState()
    storeHarness.replaceState(makeState())
    recoveryGate.releases.length = 0
  })

  it('rejects only the raced worktree snapshot and still merges its unstained sibling', async () => {
    let resolveListAll: ((value: unknown) => void) | undefined
    const call = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveListAll = resolve
        })
    )
    Object.assign(window, { api: { runtimeEnvironments: { call } } })

    // The one-shot entry inventory reserves its receipt frame before the request leaves.
    loadInitialWebSessionTabs({
      environmentId: ENV,
      expectedEnvironmentConnectionGeneration: 1,
      expectedEnvironmentPairingRevision: undefined,
      expectedTrackingGeneration: 0,
      isCurrent: () => true
    })

    // Entry projections captured before the later publish: they neither know the LATER tab nor
    // its active. WT's projection races the publish; WT2's does not.
    const racedProjection = hostSnapshot(WT, ENTRY_HOST, 72, [terminal(ENTRY_HOST, SECOND_LEAF_ID)])
    const siblingProjection = hostSnapshot(WT2, INVENTORY_ONLY_HOST, 72, [
      terminal(INVENTORY_ONLY_HOST, THIRD_LEAF_ID)
    ])
    resolveListAll?.({
      ok: true,
      result: { snapshots: [racedProjection, siblingProjection], authoritative: true }
    })
    await vi.waitFor(() => expect(recoveryGate.releases).toHaveLength(2))

    // A host publish lands for WT only, applied with host-active authority before the listAll.
    applyHostPublish(hostSnapshot(WT, LATER_HOST, 71, [terminal(LATER_HOST, LEAF_ID)]))
    expect(storeHarness.currentState().activeTabIdByWorktree[WT]).toBe(LATER_TAB)

    // Seed non-terminal focus so a rollback of any focus map is visible.
    storeHarness.useAppStore.setState({
      activeBrowserTabIdByWorktree: { [WT]: 'browser-focus' },
      activeFileIdByWorktree: { [WT]: 'file-focus' },
      activeTabTypeByWorktree: { [WT]: 'browser' }
    })
    const beforeLateApply = storeHarness.currentState()

    // Now the delayed listAll applies.
    releaseRecovery()
    await new Promise((resolve) => setTimeout(resolve, 20))

    const state = storeHarness.currentState()
    const tabIds = state.tabsByWorktree[WT]?.map((tab) => tab.id) ?? []
    const unifiedIds = state.unifiedTabsByWorktree[WT]?.map((tab) => tab.id) ?? []

    // The raced worktree snapshot is rejected whole: no trimming back to its entry set.
    expect(tabIds).toContain(LATER_TAB)
    expect(tabIds).not.toContain(ENTRY_TAB)
    expect(unifiedIds).toContain(LATER_TAB)
    // Focus stays on the host-published tab in every carrier that drives the UI.
    expect(state.activeTabIdByWorktree[WT]).toBe(LATER_TAB)
    expect(state.activeGroupIdByWorktree[WT]).toBe('group-later')
    const laterGroup = state.groupsByWorktree[WT]?.find((group) => group.id === 'group-later')
    expect(laterGroup?.activeTabId).toBe(LATER_TAB)
    // No dangling active: the retained focus still names a live tab.
    expect(tabIds).toContain(state.activeTabIdByWorktree[WT])
    // Type/browser/file focus is untouched.
    expect(state.activeTabTypeByWorktree[WT]).toBe('browser')
    expect(state.activeBrowserTabIdByWorktree[WT]).toBe('browser-focus')
    expect(state.activeFileIdByWorktree[WT]).toBe('file-focus')
    expect(state.activeTabId).toBe(beforeLateApply.activeTabId)
    expect(state.activeTabType).toBe(beforeLateApply.activeTabType)

    // Rejection is worktree-scoped: WT2 saw no stream frame, so its inventory-only tab merges.
    expect(state.tabsByWorktree[WT2]?.map((tab) => tab.id) ?? []).toContain(INVENTORY_ONLY_TAB)
  })

  it('rejects the late listAll when the raced frame arrived via subscribeAll without authority', async () => {
    // A visible LATER tab already exists; the subscribeAll delivery of the race frame must keep it
    // sticky and still supersede the delayed listAll for the whole worktree.
    applyHostPublishViaSubscribeAll(
      hostSnapshot(WT, LATER_HOST, 70, [terminal(LATER_HOST, LEAF_ID)])
    )
    expect(storeHarness.currentState().activeTabIdByWorktree[WT]).toBe(LATER_TAB)

    let resolveListAll: ((value: unknown) => void) | undefined
    const call = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveListAll = resolve
        })
    )
    Object.assign(window, { api: { runtimeEnvironments: { call } } })

    loadInitialWebSessionTabs({
      environmentId: ENV,
      expectedEnvironmentConnectionGeneration: 1,
      expectedEnvironmentPairingRevision: undefined,
      expectedTrackingGeneration: 0,
      isCurrent: () => true
    })

    resolveListAll?.({
      ok: true,
      result: {
        snapshots: [
          hostSnapshot(WT, ENTRY_HOST, 72, [terminal(ENTRY_HOST, SECOND_LEAF_ID)]),
          hostSnapshot(WT2, INVENTORY_ONLY_HOST, 72, [terminal(INVENTORY_ONLY_HOST, THIRD_LEAF_ID)])
        ],
        authoritative: true
      }
    })
    await vi.waitFor(() => expect(recoveryGate.releases).toHaveLength(2))

    // Same racing frame as the first case, delivered through the other production path.
    applyHostPublishViaSubscribeAll(
      hostSnapshot(WT, LATER_HOST, 71, [terminal(LATER_HOST, LEAF_ID)])
    )
    const afterStream = storeHarness.currentState()
    expect(afterStream.activeTabIdByWorktree[WT]).toBe(LATER_TAB)
    expect(afterStream.activeGroupIdByWorktree[WT]).toBe('group-later')

    storeHarness.useAppStore.setState({
      activeBrowserTabIdByWorktree: { [WT]: 'browser-focus' },
      activeFileIdByWorktree: { [WT]: 'file-focus' },
      activeTabTypeByWorktree: { [WT]: 'browser' }
    })
    const beforeLateApply = storeHarness.currentState()

    releaseRecovery()
    await new Promise((resolve) => setTimeout(resolve, 20))

    const state = storeHarness.currentState()
    const tabIds = state.tabsByWorktree[WT]?.map((tab) => tab.id) ?? []
    const unifiedIds = state.unifiedTabsByWorktree[WT]?.map((tab) => tab.id) ?? []

    expect(tabIds).toContain(LATER_TAB)
    expect(tabIds).not.toContain(ENTRY_TAB)
    expect(unifiedIds).toContain(LATER_TAB)
    expect(state.activeTabIdByWorktree[WT]).toBe(LATER_TAB)
    expect(state.activeGroupIdByWorktree[WT]).toBe('group-later')
    const laterGroup = state.groupsByWorktree[WT]?.find((group) => group.id === 'group-later')
    expect(laterGroup?.activeTabId).toBe(LATER_TAB)
    expect(tabIds).toContain(state.activeTabIdByWorktree[WT])
    expect(state.activeTabTypeByWorktree[WT]).toBe('browser')
    expect(state.activeBrowserTabIdByWorktree[WT]).toBe('browser-focus')
    expect(state.activeFileIdByWorktree[WT]).toBe('file-focus')
    expect(state.activeTabId).toBe(beforeLateApply.activeTabId)
    expect(state.activeTabType).toBe(beforeLateApply.activeTabType)

    expect(state.tabsByWorktree[WT2]?.map((tab) => tab.id) ?? []).toContain(INVENTORY_ONLY_TAB)
  })

  it('adopts the listAll active when no stream frame lands during recovery', async () => {
    let resolveListAll: ((value: unknown) => void) | undefined
    const call = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveListAll = resolve
        })
    )
    Object.assign(window, { api: { runtimeEnvironments: { call } } })

    loadInitialWebSessionTabs({
      environmentId: ENV,
      expectedEnvironmentConnectionGeneration: 1,
      expectedEnvironmentPairingRevision: undefined,
      expectedTrackingGeneration: 0,
      isCurrent: () => true
    })

    resolveListAll?.({
      ok: true,
      result: {
        snapshots: [hostSnapshot(WT, ENTRY_HOST, 72, [terminal(ENTRY_HOST, SECOND_LEAF_ID)])],
        authoritative: true
      }
    })
    await vi.waitFor(() => expect(recoveryGate.releases).toHaveLength(1))

    // No publish arrives while recovery is awaited, so the entry inventory still owns focus.
    releaseRecovery()
    await new Promise((resolve) => setTimeout(resolve, 20))

    const state = storeHarness.currentState()
    expect(state.activeTabIdByWorktree[WT]).toBe(ENTRY_TAB)
    expect(state.activeGroupIdByWorktree[WT]).toBe('group-entry')
    expect(state.activeTabTypeByWorktree[WT]).toBe('terminal')
    expect(state.activeTabId).toBe(ENTRY_TAB)
  })
})
