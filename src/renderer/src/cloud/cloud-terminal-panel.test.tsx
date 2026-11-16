// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudRpcOutcome } from '../../../shared/cloud-platform-ipc'
import { RELEASE_SYNCHRONIZED_OUTPUT } from '../../../shared/terminal-mode-reset-profiles'
import { CloudTerminalPanel, type CloudTerminalSubscribe } from './cloud-terminal-panel'
import { PENDING_HANDLE_TIMEOUT_MS } from './use-cloud-terminal-stream-session'
import type { CloudSubscribeOutcome } from './use-cloud-session'

/**
 * What the admin session page's terminal pane does against a scripted host.
 * The same rpc method family runs against a real PTY in the M118 e2e (W5b).
 */

type HarnessTerminal = {
  cols: number
  rows: number
  write: ReturnType<typeof vi.fn>
  resize: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  onDataListener: ((data: string) => void) | null
  loaded: unknown[]
}

const terminalHarness = vi.hoisted((): { instances: HarnessTerminal[] } => ({
  instances: []
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    write = vi.fn()
    resize = vi.fn()
    dispose = vi.fn()
    onDataListener: ((data: string) => void) | null = null
    loaded: unknown[] = []
    open = vi.fn()
    loadAddon = vi.fn((addon: unknown) => {
      this.loaded.push(addon)
    })
    onData = vi.fn((listener: (data: string) => void) => {
      this.onDataListener = listener
      return { dispose: vi.fn() }
    })
    constructor() {
      terminalHarness.instances.push(this)
    }
  }
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn()
  }
}))

type Call = { method: string; params?: Record<string, unknown> }

function scriptedHost(
  replies: Record<string, (params?: Record<string, unknown>) => CloudRpcOutcome>
) {
  const calls: Call[] = []
  const rpc = async (
    method: string,
    params?: Record<string, unknown>
  ): Promise<CloudRpcOutcome> => {
    calls.push({ method, params })
    const reply = replies[method]
    return reply ? reply(params) : { ok: false, code: 'method_not_found' }
  }
  return { rpc, calls }
}

type StreamCallbacks = Parameters<CloudTerminalSubscribe>[2]

type StreamHandle = {
  calls: { method: string; params?: Record<string, unknown> }[]
  emit: (event: unknown) => void
  close: () => void
  fail: (error: { code: string; message: string }) => void
  subscribe: CloudTerminalSubscribe
  setOutcome: (next: CloudSubscribeOutcome | 'throw') => void
}

function scriptedStream(outcome: CloudSubscribeOutcome | 'throw'): StreamHandle {
  const calls: { method: string; params?: Record<string, unknown> }[] = []
  let listener: StreamCallbacks | null = null
  let current: CloudSubscribeOutcome | 'throw' = outcome
  const subscribe: CloudTerminalSubscribe = async (method, params, callbacks) => {
    calls.push({ method, params })
    if (current === 'throw') {
      throw new Error('socket gone')
    }
    if (!current.ok) {
      return current
    }
    listener = callbacks
    return current
  }
  return {
    subscribe,
    calls,
    emit: (event) => listener?.onEvent(event),
    close: () => listener?.onClose(),
    fail: (error) => listener?.onError?.(error),
    setOutcome: (next) => {
      current = next
    }
  }
}

const createdHandle = (): CloudRpcOutcome => ({
  ok: true,
  result: { terminal: { handle: 'term_1' }, worktreeId: 'wt_1' }
})

const subscribeOk = (): CloudSubscribeOutcome => ({
  ok: true,
  subscription: { unsubscribe: vi.fn() }
})

/** The boot chain is promise-based; fake timers leave microtasks to flush. */
const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

const panel = (host: ReturnType<typeof scriptedHost>, stream: StreamHandle) =>
  render(
    <CloudTerminalPanel rpc={host.rpc} subscribe={stream.subscribe} workspacePath="/srv/checkout" />
  )

beforeEach(() => {
  vi.useFakeTimers()
  terminalHarness.instances.length = 0
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

describe('云端终端面板（FR-3.9）', () => {
  it('M118-1 挂载即在用户工作区内创建 PTY 并订阅输出，回显写入终端', async () => {
    const host = scriptedHost({ 'terminal.create': () => createdHandle() })
    const stream = scriptedStream(subscribeOk())

    panel(host, stream)
    await flush()

    expect(host.calls[0]).toEqual({
      method: 'terminal.create',
      params: { worktree: 'path:/srv/checkout', title: 'cloud-admin' }
    })
    expect(stream.calls).toHaveLength(1)
    expect(stream.calls[0]).toMatchObject({
      method: 'terminal.subscribe',
      params: { terminal: 'term_1', client: { type: 'desktop' }, viewport: { cols: 80, rows: 24 } }
    })
    expect(screen.getByTestId('cloud-terminal-state').textContent).toBe('实时')

    const term = terminalHarness.instances.at(-1)
    act(() => {
      stream.emit({ type: 'data', chunk: 'hello\r\n' })
    })
    expect(term?.write).toHaveBeenCalledWith('hello\r\n')

    act(() => {
      stream.emit({
        type: 'scrollback',
        lines: ['~/payment-service $'],
        serialized: '\x1b[1m~/payment-service $\x1b[0m ',
        cols: 100,
        rows: 30
      })
    })
    // The frame is painted at the grid the host serialized it at.
    expect(term?.resize).toHaveBeenCalledWith(100, 30)
    expect(term?.write).toHaveBeenCalledWith('\x1b[1m~/payment-service $\x1b[0m ')

    // Keystrokes name the live handle.
    act(() => {
      term?.onDataListener?.('ls\r')
    })
    expect(host.calls.at(-1)).toEqual({
      method: 'terminal.send',
      params: { terminal: 'term_1', text: 'ls\r' }
    })
  })

  it('M118-2 主机拒绝创建时显示原因与重试，不假装在线', async () => {
    const host = scriptedHost({
      'terminal.create': () => ({ ok: false, code: 'missing_permission' })
    })
    const stream = scriptedStream(subscribeOk())

    panel(host, stream)
    await flush()

    expect(screen.getByTestId('cloud-terminal-retry')).toBeTruthy()
    expect(screen.getByTestId('cloud-terminal-state').textContent).toContain('missing_permission')
    expect(stream.calls).toEqual([])
  })

  it('M118-3 流断开后按退避重连同一 PTY：不重建终端、不新建 shell', async () => {
    const host = scriptedHost({ 'terminal.create': () => createdHandle() })
    const stream = scriptedStream(subscribeOk())

    panel(host, stream)
    await flush()
    expect(stream.calls).toHaveLength(1)
    const termBefore = terminalHarness.instances.at(-1)

    act(() => {
      stream.close()
    })
    expect(screen.getByTestId('cloud-terminal-state').textContent).toContain('正在重连')

    // Backoff: 500ms to the first retry, and the retry keeps the same handle.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(stream.calls).toHaveLength(2)
    expect(stream.calls[1]?.params).toMatchObject({ terminal: 'term_1' })
    expect(terminalHarness.instances).toHaveLength(1)
    expect(terminalHarness.instances.at(-1)).toBe(termBefore)
    expect(host.calls.filter((call) => call.method === 'terminal.create')).toHaveLength(1)

    // The kept buffer is repainted from the host snapshot, not appended to.
    const term = terminalHarness.instances.at(-1)
    act(() => {
      stream.emit({ type: 'scrollback', lines: [], serialized: '\x1b[2K$ ', cols: 80, rows: 24 })
    })
    // The release must precede the clear: \x1b[2J does not clear mode 2026, so a
    // pane latched by the dropped stream would never paint this snapshot at all.
    expect(term?.write).toHaveBeenCalledWith(`${RELEASE_SYNCHRONIZED_OUTPUT}\x1b[2J\x1b[3J\x1b[H`)
    expect(term?.write).toHaveBeenCalledWith('\x1b[2K$ ')

    // Another drop, now with the host refusing: four more backoff steps spend
    // the budget, then the pane gives up until the user retries.
    stream.setOutcome({ ok: false, code: 'NOT_CONNECTED' })
    act(() => {
      stream.close()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(stream.calls).toHaveLength(6)
    expect(screen.getByTestId('cloud-terminal-state').textContent).toContain('NOT_CONNECTED')
    expect(screen.getByTestId('cloud-terminal-retry')).toBeTruthy()
  })

  it('M118-4 重试按钮重新走一遍创建与订阅', async () => {
    let created = 0
    const host = scriptedHost({
      'terminal.create': () => {
        created += 1
        return created === 1 ? { ok: false, code: 'HOST_UNREACHABLE' } : createdHandle()
      }
    })
    const stream = scriptedStream(subscribeOk())

    panel(host, stream)
    await flush()
    expect(created).toBe(1)

    fireEvent.click(screen.getByTestId('cloud-terminal-retry'))
    await flush()

    expect(created).toBe(2)
    expect(stream.calls).toHaveLength(1)
    expect(screen.getByTestId('cloud-terminal-state').textContent).toBe('实时')
  })

  it('M118-5 卸载时退订并关闭 PTY，不再泄漏宿主侧 shell', async () => {
    const host = scriptedHost({ 'terminal.create': () => createdHandle() })
    const unsubscribe = vi.fn()
    const stream = scriptedStream({ ok: true, subscription: { unsubscribe } })

    const view = panel(host, stream)
    await flush()
    expect(stream.calls).toHaveLength(1)

    view.unmount()
    expect(unsubscribe).toHaveBeenCalled()
    expect(host.calls.at(-1)).toEqual({
      method: 'terminal.close',
      params: { terminal: 'term_1' }
    })
    expect(terminalHarness.instances.at(-1)?.dispose).toHaveBeenCalled()
  })

  it('M118-6 订阅层抛错也进入重连而不是抛进渲染树', async () => {
    const host = scriptedHost({ 'terminal.create': () => createdHandle() })
    const stream = scriptedStream('throw')

    panel(host, stream)
    await flush()

    expect(screen.getByTestId('cloud-terminal-state').textContent).toContain('正在重连')
  })

  it('M118-7 同一断开被 onError 与 onClose 双报时只布防一次重连（W5a P5）', async () => {
    const host = scriptedHost({ 'terminal.create': () => createdHandle() })
    const secondUnsubscribe = vi.fn()
    const stream = scriptedStream(subscribeOk())

    const view = panel(host, stream)
    await flush()
    expect(stream.calls).toHaveLength(1)

    act(() => {
      stream.fail({ code: 'HOST_CLOSED', message: 'frame error' })
      stream.close()
    })
    expect(screen.getByTestId('cloud-terminal-state').textContent).toContain('正在重连')

    // One drop arms one timer: the retry lands on the first backoff step, and no
    // second timer fires behind it to supersede the epoch of the stream it opened
    // (which would orphan its live subscription forever).
    stream.setOutcome({ ok: true, subscription: { unsubscribe: secondUnsubscribe } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(499)
    })
    expect(stream.calls).toHaveLength(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(stream.calls).toHaveLength(2)
    expect(stream.calls[1]?.params).toMatchObject({ terminal: 'term_1' })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(stream.calls).toHaveLength(2)
    expect(screen.getByTestId('cloud-terminal-state').textContent).toBe('实时')

    view.unmount()
    expect(secondUnsubscribe).toHaveBeenCalled()
  })

  it('U98 订阅声明 desktopViewportClaims，attach 是被动观察而不是抢尺寸', async () => {
    const host = scriptedHost({ 'terminal.create': () => createdHandle() })
    const stream = scriptedStream(subscribeOk())

    panel(host, stream)
    await flush()

    expect(stream.calls[0]?.params).toMatchObject({
      terminal: 'term_1',
      capabilities: { desktopViewportClaims: 1 }
    })
  })

  it('U112 D6 characterization：无 owner 首开只被动订阅，不接管尺寸', async () => {
    // Why pin this: U111 audit D6 found that a sole viewer's first open does not
    // take over the size floor; the PTY keeps the host default grid until an
    // explicit gesture. Behavior is intentionally unchanged pending the T ruling
    // (suggest: seed a passive owner on first subscribe, or have the host export
    // its initial fit state so the panel can show `desktop-fit`, not a conflict).
    const host = scriptedHost({ 'terminal.create': () => createdHandle() })
    const stream = scriptedStream(subscribeOk())

    panel(host, stream)
    await flush()

    // The panel publishes its grid (the later refresh has a floor to update) but
    // never claims it and never restores: no automatic take-over on first open.
    expect(stream.calls[0]?.params).toMatchObject({
      terminal: 'term_1',
      capabilities: { desktopViewportClaims: 1 },
      viewport: { cols: 80, rows: 24 }
    })
    const claims = host.calls.filter(
      (call) => call.method === 'terminal.updateViewport' && call.params?.claim === true
    )
    expect(claims).toHaveLength(0)
    expect(host.calls.some((call) => call.method === 'terminal.restoreFit')).toBe(false)
    expect(screen.queryByTestId('cloud-terminal-fit-overlay')).toBeNull()
  })

  it('U96B6-1 另一窗口持有尺寸时弹出冲突提示，接管发出 claim:true', async () => {
    const host = scriptedHost({
      'terminal.create': () => createdHandle(),
      'terminal.getAutoRestoreFit': () => ({ ok: true, result: { ms: 15_000 } }),
      'terminal.updateViewport': () => ({ ok: true, result: { updated: true, applied: true } })
    })
    const stream = scriptedStream(subscribeOk())

    panel(host, stream)
    await flush()

    act(() => {
      stream.emit({ type: 'fit-override-changed', mode: 'remote-desktop-fit', cols: 120, rows: 40 })
    })
    await flush()
    expect(screen.getByTestId('cloud-terminal-fit-overlay').textContent).toContain(
      '当前尺寸由另一个窗口控制'
    )
    expect(screen.getByTestId('cloud-terminal-fit-overlay-auto-restore').textContent).toContain(
      '15 秒'
    )

    fireEvent.click(screen.getByRole('button', { name: '使用本窗口尺寸' }))
    await flush()
    expect(host.calls.at(-1)).toMatchObject({
      method: 'terminal.updateViewport',
      params: {
        terminal: 'term_1',
        client: { type: 'desktop' },
        viewport: { cols: 80, rows: 24 },
        claim: true
      }
    })
    expect(screen.queryByTestId('cloud-terminal-fit-overlay')).toBeNull()
  })

  it('U96B6-2 手机持有时「保持现状」折叠同一提示，另一方接管时重新提示', async () => {
    const host = scriptedHost({
      'terminal.create': () => createdHandle(),
      'terminal.getAutoRestoreFit': () => ({ ok: true, result: { ms: null } })
    })
    const stream = scriptedStream(subscribeOk())

    panel(host, stream)
    await flush()

    act(() => {
      stream.emit({ type: 'fit-override-changed', mode: 'mobile-fit', cols: 50, rows: 40 })
    })
    await flush()
    expect(screen.getByTestId('cloud-terminal-fit-overlay').textContent).toContain(
      '当前尺寸由手机控制'
    )
    expect(screen.getByTestId('cloud-terminal-fit-overlay-auto-restore').textContent).toContain(
      '保持当前尺寸'
    )

    fireEvent.click(screen.getByRole('button', { name: '保持现状' }))
    expect(screen.queryByTestId('cloud-terminal-fit-overlay')).toBeNull()

    // The same holder must not re-prompt; a different one must.
    act(() => {
      stream.emit({ type: 'fit-override-changed', mode: 'mobile-fit', cols: 50, rows: 40 })
    })
    expect(screen.queryByTestId('cloud-terminal-fit-overlay')).toBeNull()

    act(() => {
      stream.emit({ type: 'fit-override-changed', mode: 'remote-desktop-fit', cols: 120, rows: 40 })
    })
    expect(screen.getByTestId('cloud-terminal-fit-overlay').textContent).toContain(
      '当前尺寸由另一个窗口控制'
    )
  })

  it('U96B6-3 手机持有尺寸时「恢复」走 terminal.restoreFit（云白名单）', async () => {
    const host = scriptedHost({
      'terminal.create': () => createdHandle(),
      'terminal.getAutoRestoreFit': () => ({ ok: true, result: { ms: null } }),
      'terminal.restoreFit': () => ({ ok: true, result: { restored: true } })
    })
    const stream = scriptedStream(subscribeOk())

    panel(host, stream)
    await flush()

    act(() => {
      stream.emit({ type: 'fit-override-changed', mode: 'mobile-fit', cols: 50, rows: 40 })
    })
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '恢复为本窗口尺寸' }))
    await flush()
    expect(host.calls.at(-1)).toEqual({
      method: 'terminal.restoreFit',
      params: { terminal: 'term_1' }
    })
    expect(screen.queryByTestId('cloud-terminal-fit-overlay')).toBeNull()
  })

  it('M118-8 create 在途时卸载仍关闭宿主侧 shell，不泄漏（W5a MIN-4）', async () => {
    let resolveCreate: (outcome: CloudRpcOutcome) => void = () => undefined
    const calls: Call[] = []
    const rpc = async (
      method: string,
      params?: Record<string, unknown>
    ): Promise<CloudRpcOutcome> => {
      calls.push({ method, params })
      if (method === 'terminal.create') {
        return new Promise((resolve) => {
          resolveCreate = resolve
        })
      }
      return { ok: false, code: 'method_not_found' }
    }
    const stream = scriptedStream(subscribeOk())

    const view = render(
      <CloudTerminalPanel rpc={rpc} subscribe={stream.subscribe} workspacePath="/srv/checkout" />
    )
    await flush()
    expect(calls.map((call) => call.method)).toEqual(['terminal.create'])

    // The cleanup runs before the handle was ever registered.
    view.unmount()
    expect(calls.map((call) => call.method)).toEqual(['terminal.create'])

    await act(async () => {
      resolveCreate(createdHandle())
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(calls.at(-1)).toEqual({ method: 'terminal.close', params: { terminal: 'term_1' } })
    expect(stream.calls).toEqual([])
  })
})

describe('云端终端 attach 与回放边界（U96 B-令3）', () => {
  it('U96B3-1 投影行已有 handle：只订阅不 create，卸载不关闭宿主 PTY', async () => {
    const host = scriptedHost({})
    const stream = scriptedStream(subscribeOk())

    const view = render(
      <CloudTerminalPanel
        rpc={host.rpc}
        subscribe={stream.subscribe}
        workspacePath="/srv/checkout"
        tabId="tab_1"
        leafId="leaf_1"
        hostTerminal="term_9"
      />
    )
    await flush()

    expect(host.calls.filter((call) => call.method === 'terminal.create')).toEqual([])
    expect(stream.calls).toHaveLength(1)
    expect(stream.calls[0]?.params).toMatchObject({ terminal: 'term_9' })
    expect(screen.getByTestId('cloud-terminal-state').textContent).toBe('实时')

    view.unmount()
    expect(host.calls.filter((call) => call.method === 'terminal.close')).toEqual([])
  })

  it('U96B3-2 宿主承接 PTY：pending 占位 → handle 到达后 attach，全程零 create', async () => {
    const host = scriptedHost({})
    const stream = scriptedStream(subscribeOk())
    const element = (hostTerminal?: string | null) => (
      <CloudTerminalPanel
        rpc={host.rpc}
        subscribe={stream.subscribe}
        workspacePath="/srv/checkout"
        tabId="tab_1"
        leafId="leaf_1"
        hostOwnsPty
        hostTerminal={hostTerminal}
      />
    )

    const view = render(element(null))
    await flush()

    expect(screen.getByTestId('cloud-terminal-pending')).toBeTruthy()
    expect(host.calls.filter((call) => call.method === 'terminal.create')).toEqual([])
    expect(stream.calls).toEqual([])

    view.rerender(element('term_7'))
    await flush()

    expect(stream.calls).toHaveLength(1)
    expect(stream.calls[0]?.params).toMatchObject({ terminal: 'term_7' })
    expect(host.calls.filter((call) => call.method === 'terminal.create')).toEqual([])
  })

  it('U112 D2 pending 超阈值转 ended，重开沿用原 tabId/leafId', async () => {
    const host = scriptedHost({
      'terminal.create': () => ({
        ok: true,
        result: { terminal: { handle: 'term_reopen' }, worktreeId: 'wt_1' }
      })
    })
    const stream = scriptedStream(subscribeOk())

    render(
      <CloudTerminalPanel
        rpc={host.rpc}
        subscribe={stream.subscribe}
        workspacePath="/srv/checkout"
        tabId="tab_1"
        leafId="leaf_1"
        hostOwnsPty
        hostTerminal={null}
      />
    )
    await flush()
    expect(screen.getByTestId('cloud-terminal-pending')).toBeTruthy()
    expect(screen.queryByTestId('cloud-terminal-ended')).toBeNull()

    // Before the threshold the row is still waiting; no local create.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PENDING_HANDLE_TIMEOUT_MS - 1)
    })
    expect(screen.getByTestId('cloud-terminal-pending')).toBeTruthy()
    expect(host.calls).toEqual([])

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(screen.queryByTestId('cloud-terminal-pending')).toBeNull()
    expect(screen.getByTestId('cloud-terminal-ended')).toBeTruthy()

    fireEvent.click(screen.getByTestId('cloud-terminal-reopen'))
    await flush()
    await flush()

    expect(host.calls.at(-1)).toMatchObject({
      method: 'terminal.create',
      params: {
        worktree: 'path:/srv/checkout',
        title: 'cloud-admin',
        tabId: 'tab_1',
        leafId: 'leaf_1'
      }
    })
    expect(stream.calls.at(-1)?.params).toMatchObject({ terminal: 'term_reopen' })
  })

  it('U112 D2 pending 在阈值内拿到 handle：直接 attach，不转 ended', async () => {
    const host = scriptedHost({})
    const stream = scriptedStream(subscribeOk())
    const element = (hostTerminal: string | null) => (
      <CloudTerminalPanel
        rpc={host.rpc}
        subscribe={stream.subscribe}
        workspacePath="/srv/checkout"
        tabId="tab_1"
        leafId="leaf_1"
        hostOwnsPty
        hostTerminal={hostTerminal}
      />
    )

    const view = render(element(null))
    await flush()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PENDING_HANDLE_TIMEOUT_MS - 1)
    })
    view.rerender(element('term_7'))
    await flush()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PENDING_HANDLE_TIMEOUT_MS * 2)
    })

    expect(stream.calls).toHaveLength(1)
    expect(stream.calls[0]?.params).toMatchObject({ terminal: 'term_7' })
    expect(screen.queryByTestId('cloud-terminal-ended')).toBeNull()
  })

  it('U96B3-3 回放边界：截断与无历史各有提示', async () => {
    const host = scriptedHost({ 'terminal.create': () => createdHandle() })
    const stream = scriptedStream(subscribeOk())

    panel(host, stream)
    await flush()

    act(() => {
      stream.emit({
        type: 'scrollback',
        serialized: '$ ',
        cols: 80,
        rows: 24,
        truncatedByByteBudget: true
      })
    })
    expect(screen.getByTestId('cloud-terminal-replay-truncated').textContent).toContain(
      '回放已截断'
    )

    act(() => {
      stream.emit({ type: 'scrollback', unavailable: 'serialize_failed' })
    })
    expect(screen.getByTestId('cloud-terminal-replay-unavailable').textContent).toContain(
      '未保留可回放的终端历史'
    )
  })

  it('U96B3-4 终端已消失：ended 提示不进退避重连，重开后订阅新 handle', async () => {
    const host = scriptedHost({
      'terminal.create': () => ({
        ok: true,
        result: { terminal: { handle: 'term_2' }, worktreeId: 'wt_1' }
      })
    })
    const stream = scriptedStream(subscribeOk())

    render(
      <CloudTerminalPanel
        rpc={host.rpc}
        subscribe={stream.subscribe}
        workspacePath="/srv/checkout"
        tabId="tab_1"
        leafId="leaf_1"
        hostTerminal="term_1"
      />
    )
    await flush()
    expect(stream.calls).toHaveLength(1)

    act(() => {
      stream.fail({ code: 'terminal_handle_stale', message: 'pty gone' })
    })
    expect(screen.getByTestId('cloud-terminal-ended')).toBeTruthy()
    expect(screen.getByTestId('cloud-terminal-ended-text').textContent).toContain('会话已结束')

    // Ended is terminal locally: the backoff budget must not replay a dead handle.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(stream.calls).toHaveLength(1)

    fireEvent.click(screen.getByTestId('cloud-terminal-reopen'))
    await flush()
    await flush()

    expect(host.calls.at(-1)).toMatchObject({
      method: 'terminal.create',
      params: {
        worktree: 'path:/srv/checkout',
        title: 'cloud-admin',
        tabId: 'tab_1',
        leafId: 'leaf_1'
      }
    })
    expect(stream.calls).toHaveLength(2)
    expect(stream.calls[1]?.params).toMatchObject({ terminal: 'term_2' })
    expect(screen.queryByTestId('cloud-terminal-ended')).toBeNull()
    expect(screen.getByTestId('cloud-terminal-state').textContent).toBe('实时')
  })
})
