// @vitest-environment happy-dom
import * as React from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CloudRpc } from '../../../shared/cloud-file-browser'
import type { CloudRpcOutcome } from '../../../shared/cloud-platform-ipc'
import { CLOUD_SESSION_TABS_RESTORE_CAPABILITY } from '../../../shared/cloud-workspace-info'
import type { RuntimeMobileSessionTerminalClientTab } from '../../../shared/runtime-mobile-session-tab-contracts'
import type { CloudTerminalSubscribe } from './cloud-terminal-panel'
import type { CloudSubscriptionCallbacks } from './use-cloud-session'
import { useCloudSimpleWorkspaceSessionTabs } from './use-cloud-simple-workspace-session-tabs'
import {
  cloudSimpleWorkspaceTabsInitialState,
  cloudSimpleWorkspaceTabsReducer
} from './cloud-simple-workspace-tabs'

/** U96 B-令2: capability gate, list bootstrap, stream merge, one-shot degrade. */

const WORKSPACE = '/srv/checkout'
const WORKTREE = `path:${WORKSPACE}`
const CAPABILITY = [CLOUD_SESSION_TABS_RESTORE_CAPABILITY]

afterEach(cleanup)

function terminalRow(
  parentTabId: string,
  leafId: string,
  title = 'zsh'
): RuntimeMobileSessionTerminalClientTab {
  return {
    type: 'terminal',
    id: `${parentTabId}::${leafId}`,
    title,
    parentTabId,
    leafId,
    ptyId: `pty-${leafId}`,
    isActive: false,
    parentLayout: { root: null, activeLeafId: leafId, expandedLeafId: null },
    status: 'ready',
    terminal: `handle-${leafId}`
  }
}

function pendingRow(parentTabId: string, leafId: string): RuntimeMobileSessionTerminalClientTab {
  return {
    ...terminalRow(parentTabId, leafId),
    status: 'pending-handle',
    terminal: null
  }
}

function frame(
  type: 'snapshot' | 'updated',
  tabs: RuntimeMobileSessionTerminalClientTab[],
  activeTabId = 'tab-a'
): Record<string, unknown> {
  return {
    type,
    worktree: WORKTREE,
    publicationEpoch: 'epoch',
    snapshotVersion: 1,
    activeGroupId: 'group',
    activeTabId,
    activeTabType: 'terminal',
    tabGroups: [{ id: 'group', activeTabId, tabOrder: tabs.map((tab) => tab.parentTabId) }],
    tabs
  }
}

/** The shell's reducer seam, so the hook's projection is asserted end to end. */
function useHarness(args: Parameters<typeof useCloudSimpleWorkspaceSessionTabs>[0]) {
  const sessionTabs = useCloudSimpleWorkspaceSessionTabs(args)
  const [state, dispatch] = React.useReducer(cloudSimpleWorkspaceTabsReducer, undefined, () =>
    cloudSimpleWorkspaceTabsInitialState()
  )
  const snapshot = sessionTabs.hostSnapshot
  React.useEffect(() => {
    if (snapshot) {
      dispatch({ type: 'host-snapshot', tabs: snapshot.tabs, activeId: snapshot.activeTabId })
    }
  }, [snapshot])
  return { ...sessionTabs, state }
}

type RpcCall = { method: string; params?: Record<string, unknown> }
type SubscribeCall = { method: string; params?: Record<string, unknown> }

function scriptedRpc(list: CloudRpcOutcome): { rpc: CloudRpc; calls: RpcCall[] } {
  const calls: RpcCall[] = []
  const rpc: CloudRpc = async (method, params) => {
    calls.push({ method, params })
    return list
  }
  return { rpc, calls }
}

/** Per-method replies; unlisted methods answer `ok` with an empty result. */
function methodRpc(outcomes: Record<string, CloudRpcOutcome>): {
  rpc: CloudRpc
  calls: RpcCall[]
} {
  const calls: RpcCall[] = []
  const rpc: CloudRpc = async (method, params) => {
    calls.push({ method, params })
    return outcomes[method] ?? { ok: true, result: {} }
  }
  return { rpc, calls }
}

function scriptedSubscribe(outcome?: CloudRpcOutcome): {
  subscribe: CloudTerminalSubscribe
  calls: SubscribeCall[]
  callbacks: () => CloudSubscriptionCallbacks | null
  unsubscribe: ReturnType<typeof vi.fn>
} {
  const calls: SubscribeCall[] = []
  const unsubscribe = vi.fn()
  let callbacks: CloudSubscriptionCallbacks | null = null
  const subscribe: CloudTerminalSubscribe = async (method, params, next) => {
    calls.push({ method, params })
    callbacks = next
    return outcome && !outcome.ok
      ? { ok: false, code: outcome.code }
      : { ok: true, subscription: { unsubscribe } }
  }
  return { subscribe, calls, callbacks: () => callbacks, unsubscribe }
}

describe('简易工作区 session-tabs bootstrap（U96 B-令2）', () => {
  it('capability 含：list 一次并投影进 reducer，订阅同 worktree，卸载退订', async () => {
    const { rpc, calls } = scriptedRpc({
      ok: true,
      result: frame('snapshot', [terminalRow('tab-a', 'leaf-1')])
    })
    const stream = scriptedSubscribe()

    const { result, unmount } = renderHook(() =>
      useHarness({
        rpc,
        subscribe: stream.subscribe,
        workspacePath: WORKSPACE,
        capabilities: CAPABILITY
      })
    )

    await waitFor(() => expect(result.current.state.tabs).toHaveLength(1))
    expect(calls).toEqual([{ method: 'session.tabs.list', params: { worktree: WORKTREE } }])
    expect(result.current.state.tabs[0]).toMatchObject({
      id: 'tab-a',
      kind: 'terminal',
      title: 'zsh',
      host: { leafId: 'leaf-1', terminal: 'handle-leaf-1', ptyId: 'pty-leaf-1', leafCount: 1 }
    })
    expect(result.current.state.activeId).toBe('tab-a')

    await waitFor(() => expect(stream.calls).toHaveLength(1))
    expect(stream.calls[0]).toEqual({
      method: 'session.tabs.subscribe',
      params: { worktree: WORKTREE }
    })
    await waitFor(() => expect(result.current.syncing).toBe(false))

    unmount()
    expect(stream.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('capability 缺：零 session.tabs 调用，保持本地标签行为', async () => {
    const { rpc, calls } = scriptedRpc({ ok: true, result: {} })
    const stream = scriptedSubscribe()

    const { result } = renderHook(() =>
      useHarness({ rpc, subscribe: stream.subscribe, workspacePath: WORKSPACE, capabilities: [] })
    )

    await act(async () => undefined)
    expect(calls).toHaveLength(0)
    expect(stream.calls).toHaveLength(0)
    expect(result.current.hostSnapshot).toBeNull()
    expect(result.current.state.tabs).toHaveLength(0)
    expect(result.current.unsupported).toBe(true)
  })

  it('订阅增量帧复用投影合并：另一个端点新建的标签出现', async () => {
    const { rpc } = scriptedRpc({
      ok: true,
      result: frame('snapshot', [terminalRow('tab-a', 'leaf-1')])
    })
    const stream = scriptedSubscribe()

    const { result } = renderHook(() =>
      useHarness({
        rpc,
        subscribe: stream.subscribe,
        workspacePath: WORKSPACE,
        capabilities: CAPABILITY
      })
    )
    await waitFor(() => expect(result.current.state.tabs).toHaveLength(1))
    await waitFor(() => expect(stream.callbacks()).not.toBeNull())

    act(() => {
      stream
        .callbacks()
        ?.onEvent(
          frame('updated', [terminalRow('tab-a', 'leaf-1'), terminalRow('tab-b', 'leaf-2')])
        )
    })

    await waitFor(() => expect(result.current.state.tabs).toHaveLength(2))
    expect(result.current.state.tabs.map((tab) => tab.id)).toEqual(['tab-a', 'tab-b'])
  })

  it('list 失败：一次性降级，负缓存不重试（父组件重渲染也零新调用）', async () => {
    const { rpc, calls } = scriptedRpc({ ok: false, code: 'forbidden' })
    const stream = scriptedSubscribe()

    const { result, rerender } = renderHook(
      (props: { rpc: CloudRpc }) =>
        useHarness({
          rpc: props.rpc,
          subscribe: stream.subscribe,
          workspacePath: WORKSPACE,
          capabilities: CAPABILITY
        }),
      { initialProps: { rpc } }
    )

    await waitFor(() => expect(result.current.unsupported).toBe(true))
    expect(calls).toHaveLength(1)
    expect(stream.calls).toHaveLength(0)

    // Fresh rpc identity per parent render must not re-trigger the one attempt.
    const next = scriptedRpc({ ok: true, result: frame('snapshot', []) })
    rerender({ rpc: next.rpc })
    await act(async () => undefined)
    expect(calls).toHaveLength(1)
    expect(next.calls).toHaveLength(0)
    expect(stream.calls).toHaveLength(0)
  })

  it('subscribe 失败：同样一次性降级，不重复订阅', async () => {
    const { rpc } = scriptedRpc({
      ok: true,
      result: frame('snapshot', [terminalRow('tab-a', 'leaf-1')])
    })
    const stream = scriptedSubscribe({ ok: false, code: 'timeout' })

    const { result, rerender } = renderHook(
      (props: { rpc: CloudRpc }) =>
        useHarness({
          rpc: props.rpc,
          subscribe: stream.subscribe,
          workspacePath: WORKSPACE,
          capabilities: CAPABILITY
        }),
      { initialProps: { rpc } }
    )

    await waitFor(() => expect(result.current.state.tabs).toHaveLength(1))
    await waitFor(() => expect(result.current.unsupported).toBe(true))
    expect(stream.calls).toHaveLength(1)

    rerender({ rpc: scriptedRpc({ ok: true, result: frame('snapshot', []) }).rpc })
    await act(async () => undefined)
    expect(stream.calls).toHaveLength(1)
  })
})

describe('简易工作区 session-tabs 双向动作（U96 B-令4）', () => {
  async function booted(outcomes: Record<string, CloudRpcOutcome>) {
    const scripted = methodRpc({
      'session.tabs.list': {
        ok: true,
        result: frame('snapshot', [terminalRow('tab-a', 'leaf-1'), terminalRow('tab-b', 'leaf-2')])
      },
      ...outcomes
    })
    const stream = scriptedSubscribe()
    const rendered = renderHook(() =>
      useHarness({
        rpc: scripted.rpc,
        subscribe: stream.subscribe,
        workspacePath: WORKSPACE,
        capabilities: CAPABILITY
      })
    )
    await waitFor(() => expect(rendered.result.current.state.tabs).toHaveLength(2))
    await waitFor(() => expect(stream.callbacks()).not.toBeNull())
    return { ...scripted, stream, result: rendered.result }
  }

  it('activate：用户切换才发 RPC；同标签去重，宿主帧回来不回写', async () => {
    const { calls, stream, result } = await booted({})

    act(() => result.current.actions.activate('tab-b'))
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'session.tabs.activate',
        params: { worktree: WORKTREE, tabId: 'tab-b', notifyClients: true }
      })
    )
    const sent = calls.filter((call) => call.method === 'session.tabs.activate').length

    // Same tab again is already requested/confirmed: no second write.
    act(() => result.current.actions.activate('tab-b'))

    // A host frame carrying the new active tab must not echo an activate.
    act(() => {
      stream
        .callbacks()
        ?.onEvent(
          frame(
            'updated',
            [terminalRow('tab-a', 'leaf-1'), terminalRow('tab-b', 'leaf-2')],
            'tab-b'
          )
        )
    })
    await act(async () => undefined)
    expect(calls.filter((call) => call.method === 'session.tabs.activate')).toHaveLength(sent)
  })

  it('close：宿主确认退役 → closed；live-host-pty 拒绝 → refused + 提示保留', async () => {
    const closed = await booted({ 'session.tabs.close': { ok: true, result: { closed: true } } })
    await expect(closed.result.current.actions.close('tab-a')).resolves.toBe('closed')
    expect(closed.calls).toContainEqual({
      method: 'session.tabs.close',
      params: { worktree: WORKTREE, tabId: 'tab-a', reason: 'user' }
    })

    cleanup()
    const refused = await booted({
      'session.tabs.close': {
        ok: true,
        result: { closed: true, refused: true, refusalReason: 'live-host-pty' }
      }
    })
    await expect(refused.result.current.actions.close('tab-a')).resolves.toBe('refused')
    await waitFor(() => expect(refused.result.current.actions.notice).toContain('桌面端'))
  })

  it('close 失败：一次性降级，后续动作零新调用（退回本地标签）', async () => {
    const { calls, stream, result } = await booted({
      'session.tabs.close': { ok: false, code: 'forbidden' }
    })

    await expect(result.current.actions.close('tab-a')).resolves.toBe('local')
    await waitFor(() => expect(result.current.unsupported).toBe(true))
    expect(result.current.actions.notice).not.toBeNull()

    const before = calls.length
    await expect(result.current.actions.close('tab-b')).resolves.toBe('local')
    expect(calls).toHaveLength(before)
    expect(stream.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('create：带客户端 tabId/leafId，随后 activate', async () => {
    const { calls, result } = await booted({
      'terminal.create': { ok: true, result: { terminal: { handle: 'handle-new' } } }
    })

    await expect(
      result.current.actions.createTerminal('terminal:abc', 'leaf:abc', 'Terminal 3')
    ).resolves.toBe(true)
    expect(calls).toContainEqual({
      method: 'terminal.create',
      params: {
        worktree: WORKTREE,
        tabId: 'terminal:abc',
        leafId: 'leaf:abc',
        title: 'Terminal 3',
        clientMutationId: 'terminal:abc'
      }
    })
    expect(calls).toContainEqual({
      method: 'session.tabs.activate',
      params: { worktree: WORKTREE, tabId: 'terminal:abc', notifyClients: true }
    })
  })

  it('create 失败：降级并返回 false', async () => {
    const { result } = await booted({ 'terminal.create': { ok: false, code: 'timeout' } })

    await expect(
      result.current.actions.createTerminal('terminal:abc', 'leaf:abc', 'Terminal 3')
    ).resolves.toBe(false)
    await waitFor(() => expect(result.current.unsupported).toBe(true))
  })
})

describe('简易工作区孤儿兜底（U96 B-令7）', () => {
  const orphanListing = {
    ok: true as const,
    result: {
      terminals: [
        {
          handle: 'handle-orphan',
          ptyId: 'pty-leaf-1',
          incarnationId: 'inc-1',
          orphaned: true,
          worktreePath: WORKSPACE
        }
      ],
      topologyRevisions: { [WORKTREE]: 3 },
      totalCount: 1,
      truncated: false
    }
  }

  it('pending 行 + 存活孤儿：list → adoptOrphans，adopt 成果进投影', async () => {
    const { rpc, calls } = methodRpc({
      'session.tabs.list': { ok: true, result: frame('snapshot', [pendingRow('tab-a', 'leaf-1')]) },
      'terminal.list': orphanListing,
      'terminal.adoptOrphans': {
        ok: true,
        result: {
          adopted: true,
          topologyRevision: 4,
          snapshot: frame('snapshot', [terminalRow('tab-a', 'leaf-1')])
        }
      }
    })
    const stream = scriptedSubscribe()

    const { result } = renderHook(() =>
      useHarness({
        rpc,
        subscribe: stream.subscribe,
        workspacePath: WORKSPACE,
        capabilities: CAPABILITY
      })
    )

    await waitFor(() =>
      expect(result.current.state.tabs[0]).toMatchObject({
        id: 'tab-a',
        host: { leafId: 'leaf-1', terminal: 'handle-leaf-1' }
      })
    )
    const methods = calls.map((call) => call.method)
    expect(methods.indexOf('terminal.adoptOrphans')).toBeGreaterThan(methods.indexOf('terminal.list'))
    expect(methods.indexOf('terminal.list')).toBeGreaterThan(methods.indexOf('session.tabs.list'))
    expect(calls).toContainEqual({
      method: 'terminal.adoptOrphans',
      params: {
        worktree: WORKTREE,
        expectedTopologyRevision: 3,
        claims: [
          {
            terminal: 'handle-orphan',
            ptyId: 'pty-leaf-1',
            incarnationId: 'inc-1',
            tabId: 'tab-a',
            leafId: 'leaf-1'
          }
        ]
      }
    })
    await waitFor(() => expect(result.current.syncing).toBe(false))
  })

  it('adopt 失败：一次性降级，pending 行保留且不再重试', async () => {
    const { rpc, calls } = methodRpc({
      'session.tabs.list': { ok: true, result: frame('snapshot', [pendingRow('tab-a', 'leaf-1')]) },
      'terminal.list': orphanListing,
      'terminal.adoptOrphans': { ok: false, code: 'scope_mismatch' }
    })
    const stream = scriptedSubscribe()

    const { result, rerender } = renderHook(
      (props: { rpc: CloudRpc }) =>
        useHarness({
          rpc: props.rpc,
          subscribe: stream.subscribe,
          workspacePath: WORKSPACE,
          capabilities: CAPABILITY
        }),
      { initialProps: { rpc } }
    )

    await waitFor(() => expect(result.current.syncing).toBe(false))
    expect(result.current.state.tabs[0]).toMatchObject({ id: 'tab-a', host: { terminal: null } })
    expect(calls.filter((call) => call.method === 'terminal.adoptOrphans')).toHaveLength(1)

    rerender({ rpc: methodRpc({}).rpc })
    await act(async () => undefined)
    expect(calls.filter((call) => call.method === 'terminal.list')).toHaveLength(1)
  })
})


