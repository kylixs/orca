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
type RecoveryGate = { release: (() => void) | undefined }

const recoveryGate = vi.hoisted((): RecoveryGate => ({ release: undefined }))

vi.mock('../web-session-terminal-orphan-recovery', () => ({
  recoverWebSessionTerminalOrphansBeforeApply: vi.fn(
    async (_state: unknown, snapshot: RuntimeMobileSessionTabsResult) => {
      await new Promise<void>((resolve) => {
        recoveryGate.release = resolve
      })
      return snapshot
    }
  )
}))

import { loadInitialWebSessionTabs } from './load-initial'
import { recordReceivedWebSessionTabsSnapshot } from './tracking'
import { decideWebSessionTabsSnapshot } from './tracking-decisions'
import { applyWebSessionTabsSnapshot } from './snapshot-api'
import {
  ENV,
  LEAF_ID,
  NOW,
  SECOND_LEAF_ID,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from '../web-session-tabs-sync-test-harness'

const LATER_HOST = 'host-later'
const ENTRY_HOST = 'host-entry'
const INVENTORY_ONLY_HOST = 'host-inventory-only'
const LATER_TAB = toWebTerminalSurfaceTabId(LATER_HOST)
const ENTRY_TAB = toWebTerminalSurfaceTabId(ENTRY_HOST)
const INVENTORY_ONLY_TAB = toWebTerminalSurfaceTabId(INVENTORY_ONLY_HOST)
const THIRD_LEAF_ID = '33333333-3333-4333-8333-333333333333'

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

function snapshot(
  activeHostTabId: string,
  version: number,
  tabs: RuntimeMobileSessionTabsResult['tabs']
): RuntimeMobileSessionTabsResult {
  const activeGroupId = activeHostTabId === LATER_HOST ? 'group-later' : 'group-entry'
  return makeSnapshot(tabs, {
    activeGroupId,
    activeTabId:
      activeHostTabId === LATER_HOST
        ? `${LATER_HOST}::${LEAF_ID}`
        : `${ENTRY_HOST}::${SECOND_LEAF_ID}`,
    snapshotVersion: version,
    tabGroups:
      activeHostTabId === LATER_HOST
        ? [{ id: 'group-later', activeTabId: LATER_HOST, tabOrder: [LATER_HOST] }]
        : [{ id: 'group-entry', activeTabId: ENTRY_HOST, tabOrder: [ENTRY_HOST] }],
    tabGroupLayout: { type: 'leaf', groupId: activeGroupId }
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

describe('late initial listAll apply ordering (U138 H-A)', () => {
  beforeEach(() => {
    resetWebSessionTabsSyncTestState()
    storeHarness.replaceState(makeState())
    recoveryGate.release = undefined
  })

  it.fails(
    'keeps the host-published active when a delayed listAll applies afterwards',
    async () => {
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

      // Entry projection captured before the later publish: it neither knows that tab nor its
      // active. Applying it after the publish must merge its tabs without moving active back.
      const entryProjection = snapshot(ENTRY_HOST, 72, [
        terminal(ENTRY_HOST, SECOND_LEAF_ID),
        terminal(INVENTORY_ONLY_HOST, THIRD_LEAF_ID)
      ])
      resolveListAll?.({
        ok: true,
        result: { snapshots: [entryProjection], authoritative: true }
      })
      await vi.waitFor(() => expect(recoveryGate.release).toBeTypeOf('function'))

      // A host publish lands and is applied with host-active authority before the listAll.
      applyHostPublish(snapshot(LATER_HOST, 71, [terminal(LATER_HOST, LEAF_ID)]))
      expect(storeHarness.currentState().activeTabIdByWorktree[WT]).toBe(LATER_TAB)

      // Now the delayed listAll applies.
      recoveryGate.release?.()
      await new Promise((resolve) => setTimeout(resolve, 20))

      const state = storeHarness.currentState()
      const tabIds = state.tabsByWorktree[WT]?.map((tab) => tab.id) ?? []

      // The listAll still supplies tab content: a fix must not drop the whole apply.
      expect(tabIds).toContain(ENTRY_TAB)
      expect(tabIds).toContain(INVENTORY_ONLY_TAB)
      // The later host publish is the freshest evidence; the stale entry projection may merge
      // tabs but must not move active back.
      expect(state.activeTabIdByWorktree[WT]).toBe(LATER_TAB)
    }
  )
})
