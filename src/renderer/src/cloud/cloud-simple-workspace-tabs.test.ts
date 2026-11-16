import { describe, expect, it } from 'vitest'
import {
  CLOUD_SIMPLE_WORKSPACE_MAX_TERMINAL_TABS,
  cloudSimpleWorkspaceDiffTab,
  cloudSimpleWorkspaceDirtyCount,
  cloudSimpleWorkspaceFileTab,
  cloudSimpleWorkspaceTabsInitialState,
  cloudSimpleWorkspaceTabsReducer,
  nextTerminalTab,
  type CloudSimpleWorkspaceTabsState
} from './cloud-simple-workspace-tabs'

const terminal = (n: number) => ({
  id: `terminal-${n}`,
  kind: 'terminal' as const,
  title: `Terminal ${n}`
})

function state(tabs: CloudSimpleWorkspaceTabsState['tabs'], activeId = tabs[0]?.id ?? null) {
  return { tabs, activeId, dirty: {} }
}

describe('简易工作区标签 reducer', () => {
  it('打开文件新增并激活标签，同路径再开只激活', () => {
    let current = cloudSimpleWorkspaceTabsInitialState()
    current = cloudSimpleWorkspaceTabsReducer(current, {
      type: 'open',
      tab: cloudSimpleWorkspaceFileTab('src/a.ts')
    })
    expect(current.tabs.map((tab) => tab.title)).toEqual(['a.ts'])
    expect(current.activeId).toBe('file:src/a.ts')

    current = cloudSimpleWorkspaceTabsReducer(current, {
      type: 'open',
      tab: cloudSimpleWorkspaceFileTab('src/b.ts')
    })
    expect(current.tabs).toHaveLength(2)
    expect(current.activeId).toBe('file:src/b.ts')

    current = cloudSimpleWorkspaceTabsReducer(current, {
      type: 'open',
      tab: cloudSimpleWorkspaceFileTab('src/a.ts')
    })
    expect(current.tabs).toHaveLength(2)
    expect(current.activeId).toBe('file:src/a.ts')
  })

  it('编辑器与预览共用同一路径的标签槽', () => {
    const initial = state([cloudSimpleWorkspaceFileTab('logo.png')])
    const next = cloudSimpleWorkspaceTabsReducer(initial, {
      type: 'open',
      tab: cloudSimpleWorkspaceFileTab('logo.png', 'preview', 'image')
    })
    expect(next.tabs).toHaveLength(1)
    expect(next.tabs[0]?.kind).toBe('editor')
    expect(next.activeId).toBe('file:logo.png')
  })

  it('diff 标签与同路径编辑器并存，互不覆盖', () => {
    const initial = state([cloudSimpleWorkspaceFileTab('src/a.ts')])
    const next = cloudSimpleWorkspaceTabsReducer(initial, {
      type: 'open',
      tab: cloudSimpleWorkspaceDiffTab('src/a.ts')
    })
    expect(next.tabs.map((tab) => tab.kind)).toEqual(['editor', 'diff'])
    expect(next.activeId).toBe('diff:src/a.ts')

    const again = cloudSimpleWorkspaceTabsReducer(next, {
      type: 'open',
      tab: cloudSimpleWorkspaceDiffTab('src/a.ts')
    })
    expect(again.tabs).toHaveLength(2)
  })

  it('切换 active 标签，未知 id 不改变状态', () => {
    const initial = state([terminal(1), terminal(2)])
    const switched = cloudSimpleWorkspaceTabsReducer(initial, {
      type: 'activate',
      id: 'terminal-2'
    })
    expect(switched.activeId).toBe('terminal-2')
    expect(
      cloudSimpleWorkspaceTabsReducer(initial, {
        type: 'activate',
        id: 'nope'
      })
    ).toBe(initial)
  })

  it('关闭 active 标签优先激活右邻，无则左邻', () => {
    const initial = state([terminal(1), terminal(2), terminal(3)], 'terminal-2')
    const right = cloudSimpleWorkspaceTabsReducer(initial, {
      type: 'close',
      id: 'terminal-2'
    })
    expect(right.tabs.map((tab) => tab.id)).toEqual(['terminal-1', 'terminal-3'])
    expect(right.activeId).toBe('terminal-3')

    const left = cloudSimpleWorkspaceTabsReducer(right, {
      type: 'close',
      id: 'terminal-3'
    })
    expect(left.activeId).toBe('terminal-1')
  })

  it('关闭非 active 标签不改变 active；关闭最后一标签回空态', () => {
    const initial = state([terminal(1), terminal(2)], 'terminal-1')
    const closedInactive = cloudSimpleWorkspaceTabsReducer(initial, {
      type: 'close',
      id: 'terminal-2'
    })
    expect(closedInactive.activeId).toBe('terminal-1')

    const empty = cloudSimpleWorkspaceTabsReducer(closedInactive, {
      type: 'close',
      id: 'terminal-1'
    })
    expect(empty.tabs).toEqual([])
    expect(empty.activeId).toBeNull()
  })

  it('dirty 状态位按标签记录并在关闭时清除', () => {
    const initial = state([terminal(1)])
    const dirty = cloudSimpleWorkspaceTabsReducer(initial, {
      type: 'setDirty',
      id: 'terminal-1',
      dirty: true
    })
    expect(cloudSimpleWorkspaceDirtyCount(dirty)).toBe(1)

    const clean = cloudSimpleWorkspaceTabsReducer(dirty, {
      type: 'setDirty',
      id: 'terminal-1',
      dirty: false
    })
    expect(cloudSimpleWorkspaceDirtyCount(clean)).toBe(0)

    const reopenedDirty = cloudSimpleWorkspaceTabsReducer(dirty, {
      type: 'close',
      id: 'terminal-1'
    })
    expect(reopenedDirty.dirty).toEqual({})
  })

  it('新终端取未用最小序号，id 为客户端生成的稳定 uuid，达到上限返回 null', () => {
    expect(nextTerminalTab([], 'terminal:test-a')).toMatchObject({
      id: 'terminal:test-a',
      title: 'Terminal 1'
    })
    expect(nextTerminalTab([terminal(1), terminal(3)], 'terminal:test-b')).toMatchObject({
      id: 'terminal:test-b',
      title: 'Terminal 2'
    })
    expect(nextTerminalTab([])?.id).toMatch(/^terminal:[0-9a-f-]{36}$/)
    const full = Array.from({ length: CLOUD_SIMPLE_WORKSPACE_MAX_TERMINAL_TABS }, (_, index) =>
      terminal(index + 1)
    )
    expect(nextTerminalTab(full)).toBeNull()
  })

  it('恢复初始状态清空标签与 dirty', () => {
    const initial = state([terminal(1)])
    const dirty = cloudSimpleWorkspaceTabsReducer(initial, {
      type: 'setDirty',
      id: 'terminal-1',
      dirty: true
    })
    expect(cloudSimpleWorkspaceTabsReducer(dirty, { type: 'reset' })).toEqual(
      cloudSimpleWorkspaceTabsInitialState()
    )
  })
})
