/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { startLocalStructuredSessionTabsSync } from './subscription'
import {
  resetStructuredSessionReconnectSignalForTests,
  subscribeStructuredSessionReconnect
} from './structured-session-reconnect-signal'

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  resetStructuredSessionReconnectSignalForTests()
  vi.useRealTimers()
})

describe('structured session tabs subscription reconnect signal', () => {
  it('emits one signal per stream end and none for the resubscribe', async () => {
    vi.useFakeTimers()
    const priorApi = window.api
    const callbacks: ((response: unknown) => void)[] = []
    const subscribe = vi.fn(async (_args: unknown, callback: (response: unknown) => void) => {
      callbacks.push(callback)
      return { unsubscribe: vi.fn(), sendBinary: vi.fn() }
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        runtime: {
          getStatus: vi.fn().mockResolvedValue({
            capabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
          }),
          call: vi.fn().mockResolvedValue({ ok: true, result: { snapshots: [] } }),
          subscribe
        }
      }
    })
    const reconnect = vi.fn()
    subscribeStructuredSessionReconnect(reconnect)
    try {
      await startLocalStructuredSessionTabsSync({
        isDisposed: () => false,
        setUnsubscribe: () => undefined
      })
      expect(reconnect).not.toHaveBeenCalled()

      callbacks[0]?.({ ok: true, result: { type: 'end' } })
      expect(reconnect).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(250)
      await Promise.resolve()
      expect(subscribe).toHaveBeenCalledTimes(2)
      // The retry reopening the stream is the same reconnect boundary.
      expect(reconnect).toHaveBeenCalledTimes(1)

      callbacks[1]?.({ ok: true, result: { type: 'end' } })
      expect(reconnect).toHaveBeenCalledTimes(2)
    } finally {
      Object.defineProperty(window, 'api', { configurable: true, value: priorApi })
    }
  })
})
