import { beforeEach, describe, expect, it, vi } from 'vitest'

const { state, respondSessionTabMove } = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  respondSessionTabMove: vi.fn()
}))

vi.mock('../../store', () => ({ useAppStore: { getState: () => state } }))

import { registerSessionTabIpcBridge } from './session-tab-ipc-bridge'
import type { SessionTabMoveRequest } from '../../../../shared/session-tab-move'

type MoveListener = (move: SessionTabMoveRequest) => void

let moveListener: MoveListener | null = null

function installStore(overrides: Record<string, unknown>): void {
  for (const key of Object.keys(state)) {
    delete state[key]
  }
  Object.assign(state, {
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    reorderUnifiedTabs: vi.fn(),
    dropUnifiedTab: vi.fn(),
    ...overrides
  })
}

function fireMove(move: SessionTabMoveRequest): void {
  moveListener?.(move)
}

describe('session-tab-ipc-bridge move handling', () => {
  beforeEach(() => {
    moveListener = null
    respondSessionTabMove.mockClear()
    globalThis.window = {
      api: {
        ui: {
          onCloseSessionTab: () => () => {},
          onSessionTabCloseRequest: () => () => {},
          onMoveSessionTab: (callback: MoveListener) => {
            moveListener = callback
            return () => {}
          },
          respondSessionTabMove
        }
      }
    } as never
    registerSessionTabIpcBridge([])
  })

  it('applies a drop in the payload worktree and acknowledges it', () => {
    const dropUnifiedTab = vi.fn().mockReturnValue(true)
    installStore({
      unifiedTabsByWorktree: { 'wt-a': [{ id: 'tab-1', groupId: 'group-1' }] },
      groupsByWorktree: {
        'wt-a': [
          { id: 'group-1', tabOrder: ['tab-1'] },
          { id: 'group-2', tabOrder: [] }
        ]
      },
      dropUnifiedTab
    })

    fireMove({
      requestId: 'move-1',
      worktreeId: 'wt-a',
      kind: 'move-to-group',
      tabId: 'tab-1',
      targetGroupId: 'group-2'
    })

    expect(dropUnifiedTab).toHaveBeenCalledWith('tab-1', { groupId: 'group-2' })
    expect(respondSessionTabMove).toHaveBeenCalledWith({ requestId: 'move-1', applied: true })
  })

  it('does not drop in another worktree and reports not applied', () => {
    const dropUnifiedTab = vi.fn()
    installStore({
      unifiedTabsByWorktree: { 'wt-a': [{ id: 'tab-1', groupId: 'group-1' }] },
      groupsByWorktree: {
        'wt-a': [{ id: 'group-1', tabOrder: ['tab-1'] }],
        'wt-b': [{ id: 'group-b', tabOrder: [] }]
      },
      dropUnifiedTab
    })

    fireMove({
      requestId: 'move-2',
      worktreeId: 'wt-b',
      kind: 'move-to-group',
      tabId: 'tab-1',
      targetGroupId: 'group-b'
    })

    expect(dropUnifiedTab).not.toHaveBeenCalled()
    expect(respondSessionTabMove).toHaveBeenCalledWith({ requestId: 'move-2', applied: false })
  })

  it('treats a legitimate same-group no-op as applied', () => {
    const dropUnifiedTab = vi.fn().mockReturnValue(false)
    installStore({
      unifiedTabsByWorktree: { 'wt-a': [{ id: 'tab-1', groupId: 'group-1' }] },
      groupsByWorktree: { 'wt-a': [{ id: 'group-1', tabOrder: ['tab-1'] }] },
      dropUnifiedTab
    })

    fireMove({
      requestId: 'move-3',
      worktreeId: 'wt-a',
      kind: 'move-to-group',
      tabId: 'tab-1',
      targetGroupId: 'group-1'
    })

    expect(dropUnifiedTab).toHaveBeenCalled()
    expect(respondSessionTabMove).toHaveBeenCalledWith({ requestId: 'move-3', applied: true })
  })

  it('acknowledges a delivered reorder in the payload worktree', () => {
    const reorderUnifiedTabs = vi.fn()
    installStore({
      unifiedTabsByWorktree: { 'wt-a': [{ id: 'tab-1', groupId: 'group-1' }] },
      groupsByWorktree: { 'wt-a': [{ id: 'group-1', tabOrder: ['tab-1'] }] },
      reorderUnifiedTabs
    })

    fireMove({
      requestId: 'move-4',
      worktreeId: 'wt-a',
      kind: 'reorder',
      tabId: 'tab-1',
      targetGroupId: 'group-1',
      tabOrder: ['tab-1']
    })

    expect(reorderUnifiedTabs).toHaveBeenCalledWith('group-1', ['tab-1'])
    expect(respondSessionTabMove).toHaveBeenCalledWith({ requestId: 'move-4', applied: true })
  })
})
