// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { WebRuntimeSubscriptionCallbacks } from '../web/web-runtime-subscription-contract'
import type { OpenConnection } from './cloud-browser-bridge-replies'
import {
  subscribeOverConnection,
  type CloudSubscriptionCallbacks
} from './cloud-browser-bridge-subscription'

/**
 * The bridge's stream seam under `terminal.subscribe` (M118): what one runtime
 * frame, a refused frame, the closing end frame and an unsubscribe each become
 * for the caller. The component tests script above this seam, so these are the
 * only tests that pin the mapping itself.
 */

const OPEN: OpenConnection = {
  client: { connectionState: 'connected', call: vi.fn(), close: vi.fn() },
  route: 'direct',
  workspace: {
    projectRoot: '/srv/payment-service',
    workspaceRoot: '/srv/payment-service/.orca-worktrees/zhangsan',
    defaultBranch: 'main'
  },
  capabilities: ['terminal'],
  hostId: 'host-1',
  hostFingerprint: 'fp'
}

type ScriptedStream = {
  entry: OpenConnection
  calls: { method: string; params: unknown }[]
  /** What the frame router hands over for one `{streaming:…}`/data frame. */
  emit: (response: RuntimeRpcResponse<unknown>) => void
  /** What the frame router hands over for one non-ok frame. */
  refuse: (error: { code: string; message: string }) => void
  /** What the frame router hands over after the `{type:'end'}` frame. */
  end: () => void
  unsubscribe: ReturnType<typeof vi.fn>
}

function scriptedStream(): ScriptedStream {
  const calls: { method: string; params: unknown }[] = []
  const unsubscribe = vi.fn()
  let transport: WebRuntimeSubscriptionCallbacks | null = null
  const entry: OpenConnection = {
    ...OPEN,
    client: {
      connectionState: 'connected',
      call: vi.fn(),
      close: vi.fn(),
      subscribe: async (method, params, callbacks) => {
        calls.push({ method, params })
        transport = callbacks
        return { unsubscribe, sendBinary: () => undefined }
      }
    }
  }
  return {
    entry,
    calls,
    emit: (response) => transport?.onResponse(response),
    refuse: (error) => transport?.onError?.(error),
    end: () => transport?.onClose?.(),
    unsubscribe
  }
}

function recordingCallbacks() {
  const events: unknown[] = []
  const errors: { code: string; message: string }[] = []
  let closes = 0
  return {
    events,
    errors,
    closeCount: () => closes,
    callbacks: {
      onEvent: (event: unknown) => events.push(event),
      onError: (error: { code: string; message: string }) => errors.push(error),
      onClose: () => {
        closes += 1
      }
    } satisfies CloudSubscriptionCallbacks
  }
}

const frame = (result: unknown): RuntimeRpcResponse<unknown> => ({
  id: 'stream-1',
  ok: true,
  result,
  _meta: { runtimeId: 'runtime-1' }
})

const refusedFrame = (error: { code: string; message: string }): RuntimeRpcResponse<unknown> => ({
  id: 'stream-1',
  ok: false,
  error
})

describe('浏览器桥的流订阅映射（terminal.subscribe 的传输层）', () => {
  it('数据帧→onEvent、拒绝帧→onError、end 帧→onClose，退订释放 child socket', async () => {
    const stream = scriptedStream()
    const { callbacks, events, errors, closeCount } = recordingCallbacks()

    const outcome = await subscribeOverConnection(
      stream.entry,
      'terminal.subscribe',
      { terminal: 'term_1', client: { id: 'browser-1', type: 'desktop' } },
      callbacks
    )
    expect(outcome.ok).toBe(true)
    expect(stream.calls).toEqual([
      {
        method: 'terminal.subscribe',
        params: { terminal: 'term_1', client: { id: 'browser-1', type: 'desktop' } }
      }
    ])

    stream.emit(frame({ type: 'data', chunk: 'hello\r\n' }))
    expect(events).toEqual([{ type: 'data', chunk: 'hello\r\n' }])

    // A mid-stream refusal reaches the caller instead of being dropped with the frame.
    stream.emit(refusedFrame({ code: 'missing_permission', message: 'terminal was revoked' }))
    expect(errors).toEqual([{ code: 'missing_permission', message: 'terminal was revoked' }])

    stream.end()
    expect(closeCount()).toBe(1)

    if (outcome.ok) {
      outcome.subscription.unsubscribe()
    }
    expect(stream.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('无连接时返回 NOT_CONNECTED，且不触碰任何回调', async () => {
    const { callbacks, events, errors, closeCount } = recordingCallbacks()

    const outcome = await subscribeOverConnection(null, 'terminal.subscribe', {}, callbacks)

    expect(outcome).toEqual({ ok: false, code: 'NOT_CONNECTED' })
    expect(events).toEqual([])
    expect(errors).toEqual([])
    expect(closeCount()).toBe(0)
  })

  it('客户端没有 subscribe 能力时返回 STREAM_UNSUPPORTED（桌面 preload 的现状）', async () => {
    const { callbacks } = recordingCallbacks()

    const outcome = await subscribeOverConnection(OPEN, 'terminal.subscribe', {}, callbacks)

    expect(outcome).toEqual({ ok: false, code: 'STREAM_UNSUPPORTED' })
  })

  it('传输在订阅建立时抛错降级为失败结果，带自身 code 与消息', async () => {
    const { callbacks } = recordingCallbacks()
    const entry: OpenConnection = {
      ...OPEN,
      client: {
        connectionState: 'connected',
        call: vi.fn(),
        close: vi.fn(),
        subscribe: async () => {
          throw Object.assign(new Error('socket gone'), { code: 'SOCKET_LOST' })
        }
      }
    }

    const outcome = await subscribeOverConnection(entry, 'terminal.subscribe', {}, callbacks)
    expect(outcome).toEqual({
      ok: false,
      code: 'SOCKET_LOST',
      message: 'socket gone'
    })
  })

  it('传输抛出无 code 的错误时落回 STREAM_FAILED', async () => {
    const { callbacks } = recordingCallbacks()
    const entry: OpenConnection = {
      ...OPEN,
      client: {
        connectionState: 'connected',
        call: vi.fn(),
        close: vi.fn(),
        subscribe: async () => {
          throw new Error('socket gone')
        }
      }
    }

    const outcome = await subscribeOverConnection(entry, 'terminal.subscribe', {}, callbacks)
    expect(outcome).toEqual({ ok: false, code: 'STREAM_FAILED', message: 'socket gone' })
  })
})
