import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync/snapshot-api'
import type { WebSessionTabsSyncState } from './web-session-tabs-sync/state'
import {
  ENV,
  LEAF_ID,
  NOW,
  SECOND_LEAF_ID,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'

vi.mock('../store', () => ({
  useAppStore: {
    setState: vi.fn()
  }
}))

/**
 * U104: a cloud workspace is re-entered without a page reload, so the local group
 * records from the previous visit must not outvote the host's restored layout.
 */
const LEFT_HOST_TAB = 'host-left'
const RIGHT_HOST_TAB = 'host-right'
const LEFT_TAB_ID = `host-left::${LEAF_ID}`
const RIGHT_TAB_ID = `host-right::${SECOND_LEAF_ID}`

function terminal(
  hostTabId: string,
  surfaceId: string,
  title: string,
  isActive: boolean
): RuntimeMobileSessionTabsResult['tabs'][number] {
  return {
    type: 'terminal',
    id: surfaceId,
    title,
    parentTabId: hostTabId,
    leafId: surfaceId.slice(surfaceId.indexOf('::') + 2),
    isActive,
    status: 'ready',
    terminal: `terminal-${hostTabId}`
  }
}

/** First visit: the host has one group; its snapshot is adopted onto an empty client. */
function firstVisitSnapshot(): RuntimeMobileSessionTabsResult {
  return makeSnapshot([terminal(LEFT_HOST_TAB, LEFT_TAB_ID, 'left shell', true)], {
    activeGroupId: 'group-left',
    activeTabId: LEFT_TAB_ID,
    tabGroups: [{ id: 'group-left', activeTabId: LEFT_HOST_TAB, tabOrder: [LEFT_HOST_TAB] }],
    tabGroupLayout: { type: 'leaf', groupId: 'group-left' }
  })
}

/** Re-entry: the host still owns two split groups, the left one active. */
function reentrySnapshot(): RuntimeMobileSessionTabsResult {
  return makeSnapshot(
    [
      terminal(LEFT_HOST_TAB, LEFT_TAB_ID, 'left shell', false),
      terminal(RIGHT_HOST_TAB, RIGHT_TAB_ID, 'right shell', true)
    ],
    {
      activeGroupId: 'group-right',
      activeTabId: RIGHT_TAB_ID,
      tabGroups: [
        { id: 'group-left', activeTabId: LEFT_HOST_TAB, tabOrder: [LEFT_HOST_TAB] },
        { id: 'group-right', activeTabId: RIGHT_HOST_TAB, tabOrder: [RIGHT_HOST_TAB] }
      ],
      tabGroupLayout: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: 'group-left' },
        second: { type: 'leaf', groupId: 'group-right' }
      }
    }
  )
}

function apply(
  state: WebSessionTabsSyncState,
  snapshot: RuntimeMobileSessionTabsResult,
  options?: { adoptHostLayout?: boolean }
): WebSessionTabsSyncState {
  const patch = applyWebSessionTabsSnapshot(
    state,
    snapshot,
    ENV,
    NOW,
    options
  ) as Partial<WebSessionTabsSyncState>
  return { ...state, ...patch }
}

describe('cloud workspace re-entry host adoption (U104)', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  it('client-owned placement keeps ignoring host order/layout on a second applied snapshot', () => {
    const afterFirstVisit = apply(makeState(), firstVisitSnapshot())

    const afterReentry = apply(afterFirstVisit, reentrySnapshot())
    // The regression this fix targets: the replayed host layout never lands — the new
    // host tab joins the client's visible group and group-right is never materialized.
    expect(afterReentry.groupsByWorktree[WT]?.map((group) => group.id)).toEqual(['group-left'])
    expect(afterReentry.groupsByWorktree[WT]?.[0]?.tabOrder).toHaveLength(2)
    expect(afterReentry.activeGroupIdByWorktree[WT]).toBe('group-left')
    expect(afterReentry.layoutByWorktree[WT]).toEqual({
      type: 'leaf',
      groupId: 'group-left'
    })
  })

  it('adoptHostLayout restores host groups, active group, and split layout on re-entry', () => {
    const afterFirstVisit = apply(makeState(), firstVisitSnapshot())

    const afterReentry = apply(afterFirstVisit, reentrySnapshot(), { adoptHostLayout: true })

    expect(afterReentry.groupsByWorktree[WT]?.map((group) => group.id)).toEqual([
      'group-left',
      'group-right'
    ])
    const rightTabId = afterReentry.groupsByWorktree[WT]?.find(
      (group) => group.id === 'group-right'
    )?.tabOrder[0]
    expect(rightTabId).toBeTruthy()
    expect(afterReentry.layoutByWorktree[WT]).toEqual({
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: 'group-left' },
      second: { type: 'leaf', groupId: 'group-right' }
    })
  })

  it('restores the host active tab of the adopted layout, not the previous visit active group', () => {
    const afterFirstVisit = apply(makeState(), firstVisitSnapshot())
    const previousActiveGroup = afterFirstVisit.activeGroupIdByWorktree[WT]
    expect(previousActiveGroup).toBe('group-left')

    const afterReentry = apply(afterFirstVisit, reentrySnapshot(), { adoptHostLayout: true })

    const activeGroupId = afterReentry.activeGroupIdByWorktree[WT]
    const activeGroup = afterReentry.groupsByWorktree[WT]?.find(
      (group) => group.id === activeGroupId
    )
    const rightTabId = afterReentry.groupsByWorktree[WT]?.find(
      (group) => group.id === 'group-right'
    )?.tabOrder[0]
    expect(activeGroup?.id).toBe('group-right')
    expect(activeGroup?.activeTabId).toBe(rightTabId)
  })

  it('a fresh client (other device) already adopts the host layout without the option', () => {
    const freshDevice = apply(makeState(), reentrySnapshot())

    expect(freshDevice.groupsByWorktree[WT]?.map((group) => group.id)).toEqual([
      'group-left',
      'group-right'
    ])
    expect(freshDevice.layoutByWorktree[WT]).toEqual({
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: 'group-left' },
      second: { type: 'leaf', groupId: 'group-right' }
    })
  })

  it('keeps the local layout owned once the entry adoption has been consumed', () => {
    const afterFirstVisit = apply(makeState(), firstVisitSnapshot())
    const afterAdoption = apply(afterFirstVisit, reentrySnapshot(), { adoptHostLayout: true })

    // A later frame in the same visit is client-owned again; the host may not reset a local move.
    const afterLocalMove = apply(afterAdoption, reentrySnapshot())

    expect(afterLocalMove.groupsByWorktree[WT]?.map((group) => group.id)).toEqual([
      'group-left',
      'group-right'
    ])
  })
})
