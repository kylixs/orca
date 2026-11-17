import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { toWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'
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

// Desktop local host: the host publishes the renderer's own tab ids (F7), so a raw
// snapshot re-mirroring them would clone every local terminal.
const LOCAL_TAB_1 = 'local-tab-1'
const LOCAL_TAB_2 = 'local-tab-2'
const MIRRORED_1 = toWebTerminalSurfaceTabId(LOCAL_TAB_1)
const MIRRORED_2 = toWebTerminalSurfaceTabId(LOCAL_TAB_2)

function terminal(
  hostTabId: string,
  surfaceId: string,
  leafId: string,
  active: boolean
): RuntimeMobileSessionTabsResult['tabs'][number] {
  return {
    type: 'terminal',
    id: surfaceId,
    title: hostTabId,
    parentTabId: hostTabId,
    leafId,
    isActive: active,
    status: 'ready',
    terminal: `local-pty-${hostTabId}`
  }
}

function localTerminalState(): WebSessionTabsSyncState {
  return makeState({
    activeTabId: LOCAL_TAB_1,
    activeTabIdByWorktree: { [WT]: LOCAL_TAB_1 },
    activeTabType: 'terminal',
    activeTabTypeByWorktree: { [WT]: 'terminal' },
    tabsByWorktree: {
      [WT]: [LOCAL_TAB_1, LOCAL_TAB_2].map((id, index) => ({
        id,
        ptyId: `local-pty-${id}`,
        worktreeId: WT,
        title: id,
        customTitle: null,
        color: null,
        sortOrder: index,
        createdAt: NOW + index
      }))
    }
  })
}

/** Raw host snapshot: same ids, two terminals split over two groups. */
function rawHostSnapshot(activeHostTabId: string): RuntimeMobileSessionTabsResult {
  return makeSnapshot(
    [
      terminal(LOCAL_TAB_1, `${LOCAL_TAB_1}::${LEAF_ID}`, LEAF_ID, activeHostTabId === LOCAL_TAB_1),
      terminal(
        LOCAL_TAB_2,
        `${LOCAL_TAB_2}::${SECOND_LEAF_ID}`,
        SECOND_LEAF_ID,
        activeHostTabId === LOCAL_TAB_2
      )
    ],
    {
      activeGroupId: activeHostTabId === LOCAL_TAB_2 ? 'host-group-right' : 'host-group-left',
      activeTabId:
        activeHostTabId === LOCAL_TAB_2
          ? `${LOCAL_TAB_2}::${SECOND_LEAF_ID}`
          : `${LOCAL_TAB_1}::${LEAF_ID}`,
      tabGroups: [
        { id: 'host-group-left', activeTabId: LOCAL_TAB_1, tabOrder: [LOCAL_TAB_1] },
        { id: 'host-group-right', activeTabId: LOCAL_TAB_2, tabOrder: [LOCAL_TAB_2] }
      ],
      tabGroupLayout: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: 'host-group-left' },
        second: { type: 'leaf', groupId: 'host-group-right' }
      }
    }
  )
}

function apply(
  state: WebSessionTabsSyncState,
  frame: RuntimeMobileSessionTabsResult,
  options?: Parameters<typeof applyWebSessionTabsSnapshot>[4]
): WebSessionTabsSyncState {
  const patch = applyWebSessionTabsSnapshot(state, frame, ENV, NOW, options)
  return { ...state, ...patch }
}

describe('local host layout apply options (U163 V2a)', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  it('layoutOnly keeps local terminals as-is and mirrors no terminal duplicates', () => {
    const after = apply(localTerminalState(), rawHostSnapshot(LOCAL_TAB_1), {
      adoptHostLayout: true,
      layoutOnly: true,
      hostTabIdsAreLocalTabIds: true
    })

    const ids = (after.tabsByWorktree[WT] ?? []).map((tab) => tab.id)
    expect(ids).toEqual([LOCAL_TAB_1, LOCAL_TAB_2])
    expect(ids).not.toContain(MIRRORED_1)
    expect(ids).not.toContain(MIRRORED_2)
    expect(ids).toHaveLength(2)
  })

  it('preserveLocalFocus keeps the local active tab when the host reports another one', () => {
    const adopted = apply(makeState(), rawHostSnapshot(LOCAL_TAB_1), {
      adoptHostLayout: true
    })
    expect(adopted.activeTabIdByWorktree[WT]).toBe(MIRRORED_1)

    const restored = {
      ...adopted,
      activeTabIdByWorktree: { [WT]: MIRRORED_1 },
      activeGroupIdByWorktree: { [WT]: 'host-group-left' }
    }
    const after = apply(restored, rawHostSnapshot(LOCAL_TAB_2), {
      adoptHostLayout: true,
      preserveLocalFocus: true
    })

    expect(after.activeTabIdByWorktree[WT]).toBe(MIRRORED_1)
    expect(after.activeGroupIdByWorktree[WT]).toBe('host-group-left')
  })

  it('default options keep the existing web behavior (host active adopted, then client-owned)', () => {
    const adopted = apply(makeState(), rawHostSnapshot(LOCAL_TAB_2), {
      adoptHostLayout: true
    })
    expect(adopted.activeTabIdByWorktree[WT]).toBe(MIRRORED_2)

    const clientOwned = apply(adopted, rawHostSnapshot(LOCAL_TAB_1))
    expect(clientOwned.activeTabIdByWorktree[WT]).toBe(MIRRORED_2)
  })
})
