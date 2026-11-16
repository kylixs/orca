import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { toWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'
import { recordWebSessionFocusIntent } from '../web-session-focus-intent'
import { applyWebSessionTabsSnapshot } from './snapshot-api'
import type { WebSessionTabsSyncState } from './state'
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

vi.mock('../../store', () => ({
  useAppStore: {
    setState: vi.fn()
  }
}))

const LEFT_HOST = 'host-left'
const RIGHT_HOST = 'host-right'
const LEFT_TAB = toWebTerminalSurfaceTabId(LEFT_HOST)
const RIGHT_TAB = toWebTerminalSurfaceTabId(RIGHT_HOST)

function terminal(
  hostTabId: string,
  surfaceId: string,
  leafId: string
): RuntimeMobileSessionTabsResult['tabs'][number] {
  return {
    type: 'terminal',
    id: surfaceId,
    title: hostTabId,
    parentTabId: hostTabId,
    leafId,
    isActive: false,
    status: 'ready',
    terminal: `terminal-${hostTabId}`
  }
}

function snapshot(activeHostTabId: string): RuntimeMobileSessionTabsResult {
  const activeGroupId = activeHostTabId === RIGHT_HOST ? 'group-right' : 'group-left'
  return makeSnapshot(
    [
      terminal(LEFT_HOST, `${LEFT_HOST}::${LEAF_ID}`, LEAF_ID),
      terminal(RIGHT_HOST, `${RIGHT_HOST}::${SECOND_LEAF_ID}`, SECOND_LEAF_ID)
    ],
    {
      activeGroupId,
      activeTabId:
        activeHostTabId === RIGHT_HOST
          ? `${RIGHT_HOST}::${SECOND_LEAF_ID}`
          : `${LEFT_HOST}::${LEAF_ID}`,
      tabGroups: [
        { id: 'group-left', activeTabId: LEFT_HOST, tabOrder: [LEFT_HOST] },
        { id: 'group-right', activeTabId: RIGHT_HOST, tabOrder: [RIGHT_HOST] }
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
  frame: RuntimeMobileSessionTabsResult,
  options?: { adoptHostLayout?: boolean; hostActiveAuthoritative?: boolean }
): WebSessionTabsSyncState {
  const patch = applyWebSessionTabsSnapshot(
    state,
    frame,
    ENV,
    NOW,
    options
  ) as Partial<WebSessionTabsSyncState>
  return { ...state, ...patch }
}

/** First visit: host groups materialize; the client then owns placement for later frames. */
function adopted(): WebSessionTabsSyncState {
  return apply(makeState(), snapshot(RIGHT_HOST), { adoptHostLayout: true })
}

describe('host-active authority (U138 phase 6)', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  it('adopts the host snapshot active over a locally restored different active', () => {
    const restored = {
      ...adopted(),
      activeTabIdByWorktree: { [WT]: LEFT_TAB },
      activeGroupIdByWorktree: { [WT]: 'group-left' }
    }
    const after = apply(restored, snapshot(RIGHT_HOST), { hostActiveAuthoritative: true })

    expect(after.activeTabIdByWorktree[WT]).toBe(RIGHT_TAB)
    expect(after.activeGroupIdByWorktree[WT]).toBe('group-right')
    expect(after.groupsByWorktree[WT]?.find((group) => group.id === 'group-right')?.activeTabId).toBe(
      RIGHT_TAB
    )
  })

  it('follows a later host broadcast with no local gesture and no layout re-adoption', () => {
    const after = apply(adopted(), snapshot(LEFT_HOST), { hostActiveAuthoritative: true })

    expect(after.activeTabIdByWorktree[WT]).toBe(LEFT_TAB)
    expect(after.activeGroupIdByWorktree[WT]).toBe('group-left')
    // Group membership stays client-owned: only the active tab moves.
    expect(after.groupsByWorktree[WT]?.map((group) => group.id)).toEqual([
      'group-left',
      'group-right'
    ])
  })

  it('lets a pending local gesture outrank the host broadcast', () => {
    const before = adopted()
    recordWebSessionFocusIntent({ environmentId: ENV }, WT, RIGHT_HOST)
    const after = apply(before, snapshot(LEFT_HOST), { hostActiveAuthoritative: true })

    expect(after.activeTabIdByWorktree[WT]).toBe(RIGHT_TAB)
    expect(after.activeGroupIdByWorktree[WT]).toBe('group-right')
  })

  it('keeps the pre-U138 client-owned active when host authority is not requested', () => {
    const restored = {
      ...adopted(),
      activeTabIdByWorktree: { [WT]: LEFT_TAB },
      activeGroupIdByWorktree: { [WT]: 'group-left' }
    }
    const after = apply(restored, snapshot(RIGHT_HOST))

    expect(after.activeTabIdByWorktree[WT]).toBe(LEFT_TAB)
    expect(after.activeGroupIdByWorktree[WT]).toBe('group-left')
  })
})
