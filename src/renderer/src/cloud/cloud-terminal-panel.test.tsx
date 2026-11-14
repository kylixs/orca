// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudRpcOutcome } from '../../../shared/cloud-platform-ipc'
import { CloudTerminalPanel, type CloudTerminalSubscribe } from './cloud-terminal-panel'
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
    expect(term?.write).toHaveBeenCalledWith('\x1b[2J\x1b[3J\x1b[H')
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
})
