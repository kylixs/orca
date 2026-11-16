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
