// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CloudRpc } from '../../../shared/cloud-file-browser'
import type { CloudRpcOutcome } from '../../../shared/cloud-platform-ipc'
import {
  CloudTerminalEndedNotice,
  CloudTerminalReplayNotice,
  REPLAY_BYTE_BUDGET,
  REPLAY_SCROLLBACK_ROWS,
  SESSION_ENDED_NOTICE,
  buildCloudTerminalReopenParams,
  isTerminalSessionGone,
  readCloudScrollbackReplay,
  useCloudTerminalReopen,
  type CloudScrollbackBoundary
} from './cloud-terminal-replay-boundary'

/** U96 A-令7: replay caps/flags, the localOnly boundary, and the ended-state recovery. */

const CLEAN_BOUNDARY: CloudScrollbackBoundary = {
  truncated: false,
  truncatedByByteBudget: false,
  unavailable: null
}

afterEach(() => {
  cleanup()
})

describe('readCloudScrollbackReplay', () => {
  it('沿用既有上限 1000 行 / 512 KiB，不提高', () => {
    expect(REPLAY_SCROLLBACK_ROWS).toBe(1000)
    expect(REPLAY_BYTE_BUDGET).toBe(512 * 1024)
  })

  it('把宿主截断标记读进边界', () => {
    expect(
      readCloudScrollbackReplay({ type: 'scrollback', serialized: 'ANSI', truncated: true })
        .boundary
    ).toMatchObject({ truncated: true })
    expect(
      readCloudScrollbackReplay({
        type: 'scrollback',
        serialized: 'ANSI',
        truncatedByByteBudget: true
      }).boundary
    ).toMatchObject({ truncated: true, truncatedByByteBudget: true })
    expect(readCloudScrollbackReplay({ type: 'scrollback', serialized: 'ANSI' }).boundary).toEqual(
      CLEAN_BOUNDARY
    )
  })

  it('宿主无缓冲时报告 unavailable 而不是空白', () => {
    expect(
      readCloudScrollbackReplay({
        type: 'scrollback',
        serialized: '',
        unavailable: 'no-serializable-buffer'
      }).boundary
    ).toEqual({ ...CLEAN_BOUNDARY, unavailable: 'no-serializable-buffer' })
  })

  it('只读宿主 payload，绝不读取 localOnlyScrollbackByTabId', () => {
    const replay = readCloudScrollbackReplay({
      type: 'scrollback',
      serialized: 'VISIBLE-HISTORY',
      cols: 120,
      rows: 40,
      localOnlyScrollbackByTabId: { 'tab-1': { 'pane:1': 'SECRET-LOCAL-ONLY' } }
    })
    expect(replay.payload).toBe('VISIBLE-HISTORY')
    expect(replay.cols).toBe(120)
    expect(replay.rows).toBe(40)
    expect(JSON.stringify(replay)).not.toContain('SECRET-LOCAL-ONLY')

    // A payload that only exists locally must not become a cloud replay.
    expect(
      readCloudScrollbackReplay({
        type: 'scrollback',
        localOnlyScrollbackByTabId: { 'tab-1': { 'pane:1': 'SECRET-LOCAL-ONLY' } }
      }).payload
    ).toBeNull()
  })
})

describe('CloudTerminalReplayNotice', () => {
  it('截断时渲染显式提示', () => {
    render(<CloudTerminalReplayNotice boundary={{ ...CLEAN_BOUNDARY, truncated: true }} />)
    const notice = screen.getByTestId('cloud-terminal-replay-truncated')
    expect(notice.textContent).toContain('已截断')
    expect(notice.textContent).toContain('1000')
    expect(notice.textContent).toContain('512')
  })

  it('未截断且可回放时不渲染任何提示', () => {
    const { container } = render(<CloudTerminalReplayNotice boundary={CLEAN_BOUNDARY} />)
    expect(container.textContent).toBe('')
  })

  it('宿主无缓冲时给出明确说明', () => {
    render(
      <CloudTerminalReplayNotice
        boundary={{ ...CLEAN_BOUNDARY, unavailable: 'no-serializable-buffer' }}
      />
    )
    expect(screen.getByTestId('cloud-terminal-replay-unavailable').textContent).toContain('未保留')
  })
})

describe('isTerminalSessionGone', () => {
  it('死句柄/已退出才判定 ended', () => {
    for (const code of [
      'terminal_handle_stale',
      'terminal_exited',
      'terminal_unknown',
      'terminal_not_found',
      'no_connected_pty'
    ]) {
      expect(isTerminalSessionGone(code)).toBe(true)
    }
    expect(isTerminalSessionGone('terminal_handle_stale'.toUpperCase())).toBe(true)
    expect(isTerminalSessionGone('STREAM_FAILED', 'terminal_handle_stale: gone')).toBe(true)
  })

  it('链路断开仍是重连，不是 ended', () => {
    expect(isTerminalSessionGone('HOST_CLOSED', 'frame error')).toBe(false)
    expect(isTerminalSessionGone('NOT_CONNECTED', 'transport closed')).toBe(false)
    expect(isTerminalSessionGone(null)).toBe(false)
  })
})

describe('CloudTerminalEndedNotice', () => {
  it('显式显示会话已结束，并提供重开动作', () => {
    const onReopen = vi.fn()
    render(<CloudTerminalEndedNotice onReopen={onReopen} />)
    expect(screen.getByTestId('cloud-terminal-ended-text').textContent).toBe(SESSION_ENDED_NOTICE)
    fireEvent.click(screen.getByTestId('cloud-terminal-reopen'))
    expect(onReopen).toHaveBeenCalledTimes(1)
  })
})

describe('重新打开终端', () => {
  it('terminal.create 携带同一 tabId 与工作区选择器', () => {
    expect(
      buildCloudTerminalReopenParams({
        workspacePath: '/ws',
        title: 'cloud-admin',
        tabId: 'tab-9',
        leafId: 'leaf-1'
      })
    ).toEqual({
      worktree: 'path:/ws',
      title: 'cloud-admin',
      tabId: 'tab-9',
      leafId: 'leaf-1'
    })
  })

  function ReopenProbe({
    rpc,
    onReopened
  }: {
    rpc: CloudRpc
    onReopened: (handle: string | null) => void
  }): React.JSX.Element {
    const { reopen, pending } = useCloudTerminalReopen({
      rpc,
      workspacePath: '/ws',
      title: 'cloud-admin',
      tabId: 'tab-9',
      onReopened
    })
    return (
      <button type="button" disabled={pending} onClick={() => void reopen()}>
        reopen
      </button>
    )
  }

  it('死句柄重开后用新 handle 重新订阅', async () => {
    const calls: [string, Record<string, unknown> | undefined][] = []
    const rpc: CloudRpc = async (method, params) => {
      calls.push([method, params])
      return { ok: true, result: { terminal: { handle: 'handle-new' } } }
    }
    const onReopened = vi.fn()
    render(<ReopenProbe rpc={rpc} onReopened={onReopened} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button'))
    })
    expect(calls).toEqual([
      ['terminal.create', { worktree: 'path:/ws', title: 'cloud-admin', tabId: 'tab-9' }]
    ])
    expect(onReopened).toHaveBeenCalledWith('handle-new')
  })

  it('重开失败时不伪造 handle', async () => {
    const rpc: CloudRpc = async () => ({ ok: false, code: 'workspace_scope' })
    const onReopened = vi.fn()
    render(<ReopenProbe rpc={rpc} onReopened={onReopened} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button'))
    })
    expect(onReopened).toHaveBeenCalledWith(null)
  })

  it('U96B7 重开限频：同一次点击风暴只创建一个 PTY', async () => {
    let resolveCreate: ((outcome: CloudRpcOutcome) => void) | null = null
    const rpc = vi.fn(
      (_method: string, _params?: Record<string, unknown>): Promise<CloudRpcOutcome> =>
        new Promise<CloudRpcOutcome>((resolve) => {
          resolveCreate = resolve
        })
    )
    const onReopened = vi.fn()
    const { result } = renderHook(() =>
      useCloudTerminalReopen({
        rpc,
        workspacePath: '/ws',
        title: 'cloud-admin',
        tabId: 'tab-9',
        onReopened
      })
    )

    let first: Promise<void> = Promise.resolve()
    let second: Promise<void> = Promise.resolve()
    act(() => {
      first = result.current.reopen()
      // The second click lands before the first answered; a second create here
      // would spawn a second PTY for the same tab.
      second = result.current.reopen()
    })
    expect(rpc).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveCreate?.({ ok: true, result: { terminal: { handle: 'handle-new' } } })
      await first
      await second
    })
    expect(onReopened).toHaveBeenCalledTimes(1)
    expect(onReopened).toHaveBeenCalledWith('handle-new')
  })
})
