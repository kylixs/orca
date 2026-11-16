// @vitest-environment happy-dom
import * as React from 'react'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudRpcOutcome } from '../../../shared/cloud-platform-ipc'
import type { CloudRpc } from '../../../shared/cloud-file-browser'
import { CloudSimpleWorkspace } from './cloud-simple-workspace'
import type { CloudSimpleWorkspaceTabsAction } from './cloud-simple-workspace-tabs'
import type { CloudTerminalSubscribe } from './cloud-terminal-panel'
import type { CloudSubscriptionCallbacks } from './use-cloud-session'
import {
  CloudWorkspaceTerminalTab,
  CloudWorkspaceTerminalTabProvider
} from './cloud-workspace-terminal-tab'
import { CloudSimpleWorkspaceLifecycleProvider } from './cloud-simple-workspace-lifecycle'

/**
 * U46-5b (design §4.5): each terminal tab is one CloudTerminalPanel on the
 * W5a/W5c pipeline — one PTY per tab, reducer-assigned title, hidden panes do
 * not fit, and closing the tab releases both the stream and the PTY.
 */

type HarnessTerminal = {
  cols: number
  rows: number
  write: ReturnType<typeof vi.fn>
  resize: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
}

const terminalHarness = vi.hoisted((): { instances: HarnessTerminal[] } => ({
  instances: []
}))

const fitHarness = vi.hoisted((): { instances: { fit: ReturnType<typeof vi.fn> }[] } => ({
  instances: []
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    write = vi.fn()
    resize = vi.fn()
    dispose = vi.fn()
    open = vi.fn()
    loadAddon = vi.fn()
    onData = vi.fn(() => ({ dispose: vi.fn() }))
    constructor() {
      terminalHarness.instances.push(this)
    }
  }
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn()
    constructor() {
      fitHarness.instances.push(this)
    }
  }
}))

type Call = { method: string; params?: Record<string, unknown> }

function scriptedHost(): { rpc: CloudRpc; calls: Call[] } {
  const calls: Call[] = []
  let nextHandle = 0
  const rpc: CloudRpc = async (method, params): Promise<CloudRpcOutcome> => {
    calls.push({ method, params })
    if (method === 'terminal.create') {
      nextHandle += 1
      return {
        ok: true,
        result: { terminal: { handle: `term_${nextHandle}` }, worktreeId: 'wt_1' }
      }
    }
    return { ok: true, result: {} }
  }
  return { rpc, calls }
}

function scriptedStream(): {
  subscribe: CloudTerminalSubscribe
  calls: Call[]
  unsubscribers: ReturnType<typeof vi.fn>[]
  callbacks: CloudSubscriptionCallbacks[]
} {
  const calls: Call[] = []
  const unsubscribers: ReturnType<typeof vi.fn>[] = []
  const callbacks: CloudSubscriptionCallbacks[] = []
  const subscribe: CloudTerminalSubscribe = async (method, params, next) => {
    calls.push({ method, params })
    callbacks.push(next)
    const unsubscribe = vi.fn()
    unsubscribers.push(unsubscribe)
    return { ok: true, subscription: { unsubscribe } }
  }
  return { subscribe, calls, unsubscribers, callbacks }
}

const dispatch: React.Dispatch<CloudSimpleWorkspaceTabsAction> = () => undefined

const terminalTab = { id: 'terminal-1', kind: 'terminal', title: 'Terminal 1' } as const

type LifecycleIntent = { current: 'active' | 'suspending' | 'ending' }

function renderTab(
  host: ReturnType<typeof scriptedHost>,
  stream: ReturnType<typeof scriptedStream>,
  active: boolean,
  intent: LifecycleIntent = { current: 'active' }
) {
  const lifecycle = {
    intent: (): 'active' | 'suspending' | 'ending' => intent.current,
    registerEndCleanup: (): (() => void) => () => undefined,
    runEndCleanup: async (): Promise<void> => undefined
  }
  const element = (
    <CloudWorkspaceTerminalTabProvider
      rpc={host.rpc}
      subscribe={stream.subscribe}
      workspacePath="/srv/checkout"
    >
      <CloudSimpleWorkspaceLifecycleProvider lifecycle={lifecycle}>
        <CloudWorkspaceTerminalTab tab={terminalTab} active={active} dispatch={dispatch} />
      </CloudSimpleWorkspaceLifecycleProvider>
    </CloudWorkspaceTerminalTabProvider>
  )
  const view = render(element)
  const rerender = (nextActive: boolean): void => {
    view.rerender(
      <CloudWorkspaceTerminalTabProvider
        rpc={host.rpc}
        subscribe={stream.subscribe}
        workspacePath="/srv/checkout"
      >
        <CloudSimpleWorkspaceLifecycleProvider lifecycle={lifecycle}>
          <CloudWorkspaceTerminalTab tab={terminalTab} active={nextActive} dispatch={dispatch} />
        </CloudSimpleWorkspaceLifecycleProvider>
      </CloudWorkspaceTerminalTabProvider>
    )
  }
  return { ...view, rerender }
}

beforeEach(() => {
  terminalHarness.instances.length = 0
  fitHarness.instances.length = 0
})

afterEach(cleanup)

describe('简易工作区终端标签（U46-5b）', () => {
  it('每个标签独立创建 PTY，标题取 reducer 分配的 Terminal N', async () => {
    const user = userEvent.setup()
    const host = scriptedHost()
    const stream = scriptedStream()

    render(
      <CloudWorkspaceTerminalTabProvider
        rpc={host.rpc}
        subscribe={stream.subscribe}
        workspacePath="/srv/checkout"
      >
        <CloudSimpleWorkspace
          route="relay"
          workspacePath="/srv/checkout"
          permissions={['open', 'terminal']}
        />
      </CloudWorkspaceTerminalTabProvider>
    )

    await user.click(screen.getByTestId('cloud-simple-workspace-new-terminal'))
    await user.click(screen.getByTestId('cloud-simple-workspace-new-terminal'))

    for (const pane of await screen.findAllByTestId(/^cloud-simple-workspace-pane-terminal-/)) {
      await within(pane).findByTestId('cloud-terminal-panel')
    }
    expect(screen.getAllByTestId(/^cloud-simple-workspace-pane-terminal-/)).toHaveLength(2)
    await waitFor(() => expect(stream.unsubscribers).toHaveLength(2))

    const creates = host.calls.filter((call) => call.method === 'terminal.create')
    expect(creates).toHaveLength(2)
    expect(creates[0]?.params).toMatchObject({
      worktree: 'path:/srv/checkout',
      title: 'Terminal 1'
    })
    expect(creates[0]?.params?.tabId).toMatch(/^terminal-[0-9a-f-]{36}$/)
    expect(creates[0]?.params?.leafId).toBe(
      String(creates[0]?.params?.tabId).replace(/^terminal-/, '')
    )
    expect(creates[1]?.params).toMatchObject({
      worktree: 'path:/srv/checkout',
      title: 'Terminal 2'
    })
    expect(terminalHarness.instances).toHaveLength(2)
  })

  it('隐藏标签跳过 fit 与 viewport，激活时补一次 fit + viewport（§4.5）', async () => {
    const host = scriptedHost()
    const stream = scriptedStream()

    const view = renderTab(host, stream, false)
    await screen.findByTestId('cloud-terminal-panel')
    await waitFor(() => expect(stream.calls).toHaveLength(1))

    const fit = fitHarness.instances[0]
    expect(fitHarness.instances).toHaveLength(1)
    expect(fit?.fit).not.toHaveBeenCalled()
    expect(host.calls.some((call) => call.method === 'terminal.updateViewport')).toBe(false)

    act(() => {
      view.rerender(true)
    })

    expect(fit?.fit).toHaveBeenCalledTimes(1)
    const viewport = host.calls.find((call) => call.method === 'terminal.updateViewport')
    expect(viewport?.params).toMatchObject({
      terminal: 'term_1',
      client: { type: 'desktop' },
      viewport: { cols: 80, rows: 24 }
    })
  })

  it('关闭标签卸载面板：退订流并关闭该标签的 PTY，不碰其他标签', async () => {
    const user = userEvent.setup()
    const host = scriptedHost()
    const stream = scriptedStream()

    render(
      <CloudWorkspaceTerminalTabProvider
        rpc={host.rpc}
        subscribe={stream.subscribe}
        workspacePath="/srv/checkout"
      >
        <CloudSimpleWorkspace
          route="relay"
          workspacePath="/srv/checkout"
          permissions={['open', 'terminal']}
        />
      </CloudWorkspaceTerminalTabProvider>
    )

    await user.click(screen.getByTestId('cloud-simple-workspace-new-terminal'))
    await user.click(screen.getByTestId('cloud-simple-workspace-new-terminal'))
    await waitFor(() => expect(stream.unsubscribers).toHaveLength(2))

    const closeButtons = screen.getAllByTestId(/^cloud-simple-workspace-tab-close-terminal-/)
    const secondClose = closeButtons[1]
    if (!secondClose) {
      throw new Error('expected two terminal tabs')
    }
    const closingId = secondClose.dataset.testid?.replace('cloud-simple-workspace-tab-close-', '')
    await user.click(secondClose)

    await waitFor(() =>
      expect(host.calls.filter((call) => call.method === 'terminal.close')).toEqual([
        { method: 'terminal.close', params: { terminal: 'term_2' } }
      ])
    )
    expect(stream.unsubscribers[1]).toHaveBeenCalled()
    expect(stream.unsubscribers[0]).not.toHaveBeenCalled()
    expect(screen.queryByTestId(`cloud-simple-workspace-pane-${closingId}`)).toBeNull()
  })

  it('无 terminal 权限：组件层防御性占位，不建 PTY', async () => {
    const host = scriptedHost()
    const stream = scriptedStream()

    render(
      <CloudWorkspaceTerminalTabProvider
        rpc={host.rpc}
        subscribe={stream.subscribe}
        workspacePath="/srv/checkout"
        canUseTerminal={false}
      >
        <CloudWorkspaceTerminalTab tab={terminalTab} active dispatch={dispatch} />
      </CloudWorkspaceTerminalTabProvider>
    )

    expect(screen.getByTestId('cloud-workspace-terminal-denied').textContent).toContain(
      '未授予终端权限'
    )
    expect(host.calls).toEqual([])
    expect(stream.calls).toEqual([])
  })

  it('无流接缝或无工作区：占位而非空面板，不发 rpc', () => {
    const host = scriptedHost()
    const stream = scriptedStream()

    const missingStream = render(
      <CloudWorkspaceTerminalTabProvider
        rpc={host.rpc}
        subscribe={null}
        workspacePath="/srv/checkout"
      >
        <CloudWorkspaceTerminalTab tab={terminalTab} active dispatch={dispatch} />
      </CloudWorkspaceTerminalTabProvider>
    )
    expect(screen.getByTestId('cloud-workspace-terminal-unavailable')).toBeTruthy()
    missingStream.unmount()

    render(
      <CloudWorkspaceTerminalTabProvider
        rpc={host.rpc}
        subscribe={stream.subscribe}
        workspacePath={null}
      >
        <CloudWorkspaceTerminalTab tab={terminalTab} active dispatch={dispatch} />
      </CloudWorkspaceTerminalTabProvider>
    )
    expect(screen.getByTestId('cloud-workspace-terminal-no-workspace')).toBeTruthy()

    expect(host.calls).toEqual([])
    expect(stream.calls).toEqual([])
  })

  it('suspend 卸载：退订流但保留 PTY（不发 terminal.close）', async () => {
    const host = scriptedHost()
    const stream = scriptedStream()
    const intent: LifecycleIntent = { current: 'active' }
    const view = renderTab(host, stream, true, intent)
    await screen.findByTestId('cloud-terminal-panel')
    await waitFor(() =>
      expect(host.calls.some((call) => call.method === 'terminal.create')).toBe(true)
    )

    // The console flips the intent in the same commit that removes the workspace.
    intent.current = 'suspending'
    view.unmount()

    await waitFor(() => expect(stream.unsubscribers[0]).toHaveBeenCalled())
    expect(host.calls.filter((call) => call.method === 'terminal.close')).toEqual([])
  })

  it('end 卸载：退订流并关闭 PTY（显式结束才回收）', async () => {
    const host = scriptedHost()
    const stream = scriptedStream()
    const intent: LifecycleIntent = { current: 'active' }
    const view = renderTab(host, stream, true, intent)
    await screen.findByTestId('cloud-terminal-panel')
    await waitFor(() =>
      expect(host.calls.some((call) => call.method === 'terminal.create')).toBe(true)
    )

    intent.current = 'ending'
    view.unmount()

    await waitFor(() =>
      expect(host.calls.filter((call) => call.method === 'terminal.close')).toEqual([
        { method: 'terminal.close', params: { terminal: 'term_1' } }
      ])
    )
  })

  it('U96B3-1 宿主投影行已有 PTY：attach 既有 handle，不 create、卸载不 close', async () => {
    const host = scriptedHost()
    const stream = scriptedStream()
    const hostedTab = {
      id: 'host-tab-9',
      kind: 'terminal',
      title: 'Terminal 9',
      host: { leafId: 'leaf-9', terminal: 'term_9', ptyId: 'pty_9', leafCount: 1 }
    } as const

    const view = render(
      <CloudWorkspaceTerminalTabProvider
        rpc={host.rpc}
        subscribe={stream.subscribe}
        workspacePath="/srv/checkout"
      >
        <CloudWorkspaceTerminalTab tab={hostedTab} active dispatch={dispatch} />
      </CloudWorkspaceTerminalTabProvider>
    )

    await screen.findByTestId('cloud-terminal-panel')
    await waitFor(() => expect(stream.calls).toHaveLength(1))
    expect(stream.calls[0]?.params).toMatchObject({ terminal: 'term_9' })
    expect(host.calls.filter((call) => call.method === 'terminal.create')).toEqual([])

    view.unmount()
    expect(host.calls.filter((call) => call.method === 'terminal.close')).toEqual([])
  })

  it('U96B3-2 宿主承接 PTY 的新终端：pending 占位，不 create 竞争', async () => {
    const host = scriptedHost()
    const stream = scriptedStream()

    render(
      <CloudWorkspaceTerminalTabProvider
        rpc={host.rpc}
        subscribe={stream.subscribe}
        workspacePath="/srv/checkout"
        hostOwnsTerminalPty
      >
        <CloudWorkspaceTerminalTab tab={terminalTab} active dispatch={dispatch} />
      </CloudWorkspaceTerminalTabProvider>
    )

    await screen.findByTestId('cloud-terminal-panel')
    await screen.findByTestId('cloud-terminal-pending')
    expect(host.calls.filter((call) => call.method === 'terminal.create')).toEqual([])
    expect(stream.calls).toEqual([])
  })

  it('U96B7 回放边界：截断/无历史提示只由宿主标志驱动', async () => {
    const host = scriptedHost()
    const stream = scriptedStream()

    renderTab(host, stream, true)
    await screen.findByTestId('cloud-terminal-panel')
    await waitFor(() => expect(stream.callbacks).toHaveLength(1))

    // A clean replay paints history with no notice.
    act(() => {
      stream.callbacks[0]?.onEvent({ type: 'scrollback', serialized: 'ANSI' })
    })
    expect(screen.queryByTestId('cloud-terminal-replay-truncated')).toBeNull()
    expect(screen.queryByTestId('cloud-terminal-replay-unavailable')).toBeNull()

    act(() => {
      stream.callbacks[0]?.onEvent({
        type: 'scrollback',
        serialized: 'ANSI',
        truncatedByByteBudget: true
      })
    })
    expect(screen.getByTestId('cloud-terminal-replay-truncated').textContent).toContain(
      '回放已截断'
    )

    act(() => {
      stream.callbacks[0]?.onEvent({ type: 'scrollback', unavailable: 'serialize_failed' })
    })
    expect(screen.getByTestId('cloud-terminal-replay-unavailable').textContent).toContain(
      '未保留可回放的终端历史'
    )
  })
})
