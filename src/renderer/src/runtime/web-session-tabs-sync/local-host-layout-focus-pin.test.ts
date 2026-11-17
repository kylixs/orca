import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTerminalClientTab
} from '../../../../shared/runtime-types'
import { toWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'
import { applyWebSessionTabsSnapshot } from './snapshot-api'
import type { WebSessionTabsSyncState } from './state'
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

vi.mock('../../store', () => ({
  useAppStore: {
    setState: vi.fn()
  }
}))

const HOST_LEFT = 'host-left'
const HOST_THIRD = 'host-third'
const HOST_RIGHT = 'host-right'
const HOST_EDITOR = 'host-editor'
const LEFT_TAB = toWebTerminalSurfaceTabId(HOST_LEFT)
const THIRD_TAB = toWebTerminalSurfaceTabId(HOST_THIRD)
const RIGHT_TAB = toWebTerminalSurfaceTabId(HOST_RIGHT)

function terminal(
  hostTabId: string,
  leafId: string,
  active: boolean
): RuntimeMobileSessionTerminalClientTab {
  return {
    type: 'terminal',
    id: `${hostTabId}::${leafId}`,
    title: hostTabId,
    parentTabId: hostTabId,
    leafId,
    isActive: active,
    status: 'ready',
    terminal: `terminal-${hostTabId}`
  }
}

function editor(active: boolean): RuntimeMobileSessionTabsResult['tabs'][number] {
  return {
    type: 'file',
    id: HOST_EDITOR,
    title: 'editor.ts',
    filePath: '/worktree/editor.ts',
    relativePath: 'editor.ts',
    language: 'typescript',
    isDirty: false,
    isActive: active
  }
}

/** Host layout: left group holds the given tabs; right group is a separate pane. */
function layoutSnapshot(
  leftHostTabIds: readonly string[],
  activeHostTabId: string,
  withEditor = false
): RuntimeMobileSessionTabsResult {
  const leftTerminals: RuntimeMobileSessionTerminalClientTab[] = [
    terminal(HOST_LEFT, LEAF_ID, activeHostTabId === HOST_LEFT),
    terminal(HOST_THIRD, THIRD_LEAF_ID, activeHostTabId === HOST_THIRD)
  ].filter((tab) => leftHostTabIds.includes(tab.parentTabId))
  const leftTabs: RuntimeMobileSessionTabsResult['tabs'] = [...leftTerminals]
  if (withEditor) {
    leftTabs.push(editor(activeHostTabId === HOST_EDITOR))
  }
  const leftOrder = [...leftHostTabIds]
  if (withEditor) {
    leftOrder.push(HOST_EDITOR)
  }
  return makeSnapshot(
    [...leftTabs, terminal(HOST_RIGHT, SECOND_LEAF_ID, activeHostTabId === HOST_RIGHT)],
    {
      activeGroupId: activeHostTabId === HOST_RIGHT ? 'group-right' : 'group-left',
      activeTabId: !withEditor || activeHostTabId !== HOST_EDITOR ? HOST_RIGHT : HOST_EDITOR,
      tabGroups: [
        {
          id: 'group-left',
          activeTabId: activeHostTabId === HOST_RIGHT ? HOST_THIRD : activeHostTabId,
          tabOrder: leftOrder
        },
        { id: 'group-right', activeTabId: HOST_RIGHT, tabOrder: [HOST_RIGHT] }
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
  options?: Parameters<typeof applyWebSessionTabsSnapshot>[4]
): WebSessionTabsSyncState {
  const patch = applyWebSessionTabsSnapshot(state, frame, ENV, NOW, options)
  return { ...state, ...patch }
}

function adopted(leftHostTabIds: readonly string[], withEditor = false): WebSessionTabsSyncState {
  return apply(makeState(), layoutSnapshot(leftHostTabIds, HOST_LEFT, withEditor), {
    adoptHostLayout: true
  })
}

/** Renderer that already mirrored the host layout, then locally moved focus to the left tab. */
function localFocusOn(leftHostTabIds: readonly string[]): WebSessionTabsSyncState {
  const state = adopted(leftHostTabIds, true)
  const editorTab = state.unifiedTabsByWorktree[WT]?.find((tab) => tab.contentType === 'editor')
  expect(editorTab).toBeDefined()
  const groups = (state.groupsByWorktree[WT] ?? []).map((group) =>
    group.id === 'group-left'
      ? {
          ...group,
          tabOrder: [editorTab!.id, ...group.tabOrder],
          activeTabId: editorTab!.id,
          recentTabIds: [THIRD_TAB, LEFT_TAB, editorTab!.id]
        }
      : group
  )
  return {
    ...state,
    groupsByWorktree: { [WT]: groups },
    activeTabIdByWorktree: { [WT]: editorTab!.id },
    activeGroupIdByWorktree: { [WT]: 'group-left' },
    activeTabTypeByWorktree: { [WT]: 'editor' },
    activeFileIdByWorktree: { [WT]: editorTab!.entityId },
    activeTabType: 'editor'
  }
}

describe('local host layout catch-up keeps local focus (U163 V3)', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  it('keeps the local active tab/group when the host reports another active', () => {
    const before = localFocusOn([HOST_LEFT, HOST_THIRD])
    const localActiveTabId = before.activeTabIdByWorktree[WT]
    const after = apply(before, layoutSnapshot([HOST_LEFT, HOST_THIRD], HOST_RIGHT, true), {
      adoptHostLayout: true,
      preserveLocalFocus: true
    })

    expect(after.activeTabIdByWorktree[WT]).toBe(localActiveTabId)
    expect(after.activeGroupIdByWorktree[WT]).toBe('group-left')
    expect(after.activeTabTypeByWorktree[WT]).toBe('editor')
  })

  it('falls back to local in-group MRU when the host layout dropped the local current tab', () => {
    const before = localFocusOn([HOST_LEFT, HOST_THIRD])
    // Host closed the local current tab (host-left); the right pane is the host's active tab.
    const after = apply(before, layoutSnapshot([HOST_THIRD], HOST_RIGHT), {
      adoptHostLayout: true,
      preserveLocalFocus: true
    })

    expect(after.activeTabIdByWorktree[WT]).toBe(THIRD_TAB)
    expect(after.activeGroupIdByWorktree[WT]).toBe('group-left')
    expect(after.activeTabIdByWorktree[WT]).not.toBe(RIGHT_TAB)
  })

  it('default options still adopt the host active tab (regression)', () => {
    const before = localFocusOn([HOST_LEFT, HOST_THIRD])
    const after = apply(before, layoutSnapshot([HOST_LEFT, HOST_THIRD], HOST_RIGHT, true), {
      adoptHostLayout: true
    })

    expect(after.activeTabIdByWorktree[WT]).toBe(RIGHT_TAB)
    expect(after.activeGroupIdByWorktree[WT]).toBe('group-right')
  })
})
