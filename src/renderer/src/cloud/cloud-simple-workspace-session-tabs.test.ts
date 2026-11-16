import { describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts'
import type {
  RuntimeMobileSessionClientTab,
  RuntimeMobileSessionTerminalTab
} from '../../../shared/runtime-mobile-session-tab-contracts'
import {
  hostTerminalTabsFromSnapshot,
  mergeHostTabsIntoState
} from './cloud-simple-workspace-session-tabs'
import {
  cloudSimpleWorkspaceFileTab,
  cloudSimpleWorkspaceTabsReducer,
  type CloudSimpleWorkspaceTab,
  type CloudSimpleWorkspaceTabsState
} from './cloud-simple-workspace-tabs'

type TerminalRowOverrides = Partial<
  Omit<RuntimeMobileSessionTerminalTab, 'type' | 'id' | 'parentTabId' | 'leafId'>
> & { activeLeafId?: string | null; pending?: boolean }

function terminalRow(
  parentTabId: string,
  leafId: string,
  overrides: TerminalRowOverrides = {}
): RuntimeMobileSessionClientTab {
  const {
    title = leafId,
    activeLeafId = null,
    pending = false,
    isActive = false,
    ...rest
  } = overrides
  const base = {
    type: 'terminal' as const,
    id: `row-${parentTabId}-${leafId}`,
    title,
    parentTabId,
    leafId,
    ptyId: `pty-${leafId}`,
    isActive,
    parentLayout: {
      root: null,
      activeLeafId,
      expandedLeafId: null
    },
    ...rest
  }
  return pending
    ? { ...base, status: 'pending-handle', terminal: null }
    : { ...base, status: 'ready', terminal: `handle-${leafId}` }
}

function snapshot(
  tabs: RuntimeMobileSessionClientTab[],
  overrides: Partial<RuntimeMobileSessionTabsResult> = {}
): RuntimeMobileSessionTabsResult {
  return {
    worktree: '/repo',
    publicationEpoch: 'epoch',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs,
    ...overrides
  }
}

const state = (
  tabs: CloudSimpleWorkspaceTab[],
  activeId: string | null = tabs[0]?.id ?? null
): CloudSimpleWorkspaceTabsState => ({ tabs, activeId, dirty: {} })

const hostTab = (tabId: string, order: number) => ({
  tabId,
  leafId: `${tabId}-leaf`,
  terminal: `handle-${tabId}`,
  ptyId: `pty-${tabId}`,
  title: tabId,
  leafCount: 1,
  order
})

const hostedTerminal = (tabId: string): Extract<CloudSimpleWorkspaceTab, { kind: 'terminal' }> => ({
  id: tabId,
  kind: 'terminal',
  title: tabId,
  host: { leafId: `${tabId}-leaf`, terminal: null, ptyId: null, leafCount: 1 }
})

describe('宿主清单 → 简易工作区终端标签投影', () => {
  it('同一 parentTabId 的多 leaf 合成一枚标签，取活动 leaf 的 handle', () => {
    const projected = hostTerminalTabsFromSnapshot(
      snapshot([
        terminalRow('tab-a', 'leaf-1', { activeLeafId: 'leaf-2' }),
        terminalRow('tab-a', 'leaf-2', { title: 'server', isActive: true })
      ])
    )
    expect(projected).toEqual([
      {
        tabId: 'tab-a',
        leafId: 'leaf-2',
        terminal: 'handle-leaf-2',
        ptyId: 'pty-leaf-2',
        title: 'server',
        leafCount: 2,
        order: 0
      }
    ])
  })

  it('无 activeLeafId 时取 isActive 行，再缺省取第一行；pending-handle 投影为 null', () => {
    const withoutLayout = hostTerminalTabsFromSnapshot(
      snapshot([
        terminalRow('tab-a', 'leaf-1'),
        terminalRow('tab-a', 'leaf-2', { isActive: true, pending: true })
      ])
    )
    expect(withoutLayout[0]).toMatchObject({ leafId: 'leaf-2', terminal: null })

    const firstRow = hostTerminalTabsFromSnapshot(snapshot([terminalRow('tab-b', 'leaf-1')]))
    expect(firstRow[0]).toMatchObject({ tabId: 'tab-b', leafId: 'leaf-1', leafCount: 1 })
  })

  it('按 tabGroups 的组顺序与 tabOrder 排列，未列出的行按 snapshot 顺序追加', () => {
    const projected = hostTerminalTabsFromSnapshot(
      snapshot(
        [terminalRow('tab-z', 'z1'), terminalRow('tab-b', 'b1'), terminalRow('tab-a', 'a1')],
        {
          tabGroups: [
            { id: 'g1', activeTabId: 'tab-b', tabOrder: ['tab-b'] },
            { id: 'g2', activeTabId: 'tab-a', tabOrder: ['tab-a'] }
          ]
        }
      )
    )
    expect(projected.map((tab) => tab.tabId)).toEqual(['tab-b', 'tab-a', 'tab-z'])
    expect(projected.map((tab) => tab.order)).toEqual([0, 1, 2])
  })

  it('只取展示字段，宿主 agent/主题等私有状态不进入模型', () => {
    const [projected] = hostTerminalTabsFromSnapshot(
      snapshot([
        terminalRow('tab-a', 'leaf-1', {
          color: '#ff0000',
          launchDraft: 'secret',
          viewMode: 'chat'
        })
      ])
    )
    expect(Object.keys(projected).toSorted()).toEqual([
      'leafCount',
      'leafId',
      'order',
      'ptyId',
      'tabId',
      'terminal',
      'title'
    ])
  })

  it('忽略 file/browser/agent 等非终端行，空清单投影为空', () => {
    expect(
      hostTerminalTabsFromSnapshot(
        snapshot([
          {
            type: 'file',
            id: 'file-1',
            title: 'a.ts',
            filePath: '/repo/a.ts',
            relativePath: 'a.ts',
            language: 'typescript',
            isDirty: false,
            isActive: true
          }
        ])
      )
    ).toEqual([])
    expect(hostTerminalTabsFromSnapshot(snapshot([]))).toEqual([])
  })
})

describe('宿主快照合并进简易工作区 reducer', () => {
  it('整组替换宿主终端标签，保留本地文件标签并排在宿主标签之后', () => {
    const initial = state([cloudSimpleWorkspaceFileTab('README.md')], 'file:README.md')
    const next = cloudSimpleWorkspaceTabsReducer(initial, {
      type: 'host-snapshot',
      tabs: [hostTab('tab-a', 0), hostTab('tab-b', 1)],
      activeId: 'tab-b'
    })
    expect(next.tabs.map((tab) => tab.id)).toEqual(['tab-a', 'tab-b', 'file:README.md'])
    expect(next.tabs[0]).toMatchObject({
      kind: 'terminal',
      host: { leafId: 'tab-a-leaf', terminal: 'handle-tab-a', ptyId: 'pty-tab-a', leafCount: 1 }
    })
    expect(next.activeId).toBe('tab-b')
  })

  it('再次应用同一快照是幂等的（返回同一状态对象）', () => {
    const first = mergeHostTabsIntoState(state([]), [hostTab('tab-a', 0)], 'tab-a')
    const second = mergeHostTabsIntoState(first, [hostTab('tab-a', 0)], 'tab-a')
    expect(second).toBe(first)
  })

  it('宿主行退役时移除对应标签并清除其 dirty，本地未确认终端保留', () => {
    const localTerminal: CloudSimpleWorkspaceTab = {
      id: 'terminal:local',
      kind: 'terminal',
      title: 'Terminal 9'
    }
    const initial: CloudSimpleWorkspaceTabsState = {
      tabs: [localTerminal, hostedTerminal('tab-a')],
      activeId: 'tab-a',
      dirty: { 'tab-a': true, 'terminal:local': true },
      hostSynced: true
    }
    const next = mergeHostTabsIntoState(initial, [], null)
    expect(next.tabs.map((tab) => tab.id)).toEqual(['terminal:local'])
    expect(next.dirty).toEqual({ 'terminal:local': true })
  })

  it('宿主行沿用客户端请求的 id，只确认本地终端而不产生第二份（U107）', () => {
    const tabId = 'terminal-11111111-1111-4111-8111-111111111111'
    const initial: CloudSimpleWorkspaceTabsState = {
      tabs: [{ id: tabId, kind: 'terminal', title: 'Terminal 1' }],
      activeId: tabId,
      dirty: {},
      hostSynced: true
    }
    const next = mergeHostTabsIntoState(initial, [hostTab(tabId, 0)], tabId)
    expect(next.tabs).toHaveLength(1)
    expect(next.tabs[0]).toMatchObject({
      id: tabId,
      kind: 'terminal',
      host: { terminal: `handle-${tabId}` }
    })
  })

  it('活动标签消失时优先右邻，再左邻，最后回退宿主活动标签', () => {
    const initial = mergeHostTabsIntoState(
      state([]),
      [hostTab('tab-a', 0), hostTab('tab-b', 1), hostTab('tab-c', 2)],
      'tab-b'
    )
    const rightNeighbor = mergeHostTabsIntoState(initial, [hostTab('tab-c', 0)], 'tab-c')
    expect(rightNeighbor.activeId).toBe('tab-c')

    const leftNeighbor = mergeHostTabsIntoState(
      mergeHostTabsIntoState(state([]), [hostTab('tab-a', 0), hostTab('tab-b', 1)], 'tab-b'),
      [hostTab('tab-a', 0)],
      null
    )
    expect(leftNeighbor.activeId).toBe('tab-a')

    const hostFallback = mergeHostTabsIntoState(
      { tabs: [hostedTerminal('ghost')], activeId: 'ghost', dirty: {}, hostSynced: true },
      [hostTab('tab-a', 0), hostTab('tab-b', 1)],
      'tab-b'
    )
    expect(hostFallback.activeId).toBe('tab-b')
  })

  it('首个空快照不采纳宿主活动 id，空清单保持空且可继续本地打开', () => {
    const empty = cloudSimpleWorkspaceTabsReducer(state([]), {
      type: 'host-snapshot',
      tabs: [],
      activeId: 'tab-a'
    })
    expect(empty).toMatchObject({ tabs: [], activeId: null, hostSynced: true })

    const opened = cloudSimpleWorkspaceTabsReducer(empty, {
      type: 'open',
      tab: cloudSimpleWorkspaceFileTab('src/a.ts')
    })
    expect(opened.activeId).toBe('file:src/a.ts')
  })

  it('本地打开的终端标签（未带 host 元数据）在快照中保留，关闭与激活仍可用', () => {
    const opened = cloudSimpleWorkspaceTabsReducer(state([]), {
      type: 'open',
      tab: { id: 'terminal:local', kind: 'terminal', title: 'Terminal 1' }
    })
    const merged = cloudSimpleWorkspaceTabsReducer(opened, {
      type: 'host-snapshot',
      tabs: [hostTab('tab-a', 0)],
      activeId: 'terminal:local'
    })
    expect(merged.tabs.map((tab) => tab.id)).toEqual(['tab-a', 'terminal:local'])
    expect(merged.activeId).toBe('terminal:local')

    const closed = cloudSimpleWorkspaceTabsReducer(merged, { type: 'close', id: 'tab-a' })
    expect(closed.tabs.map((tab) => tab.id)).toEqual(['terminal:local'])
    expect(closed.activeId).toBe('terminal:local')
  })
})
