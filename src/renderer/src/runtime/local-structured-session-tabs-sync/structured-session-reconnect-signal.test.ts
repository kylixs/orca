import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  emitStructuredSessionReconnect,
  resetStructuredSessionReconnectSignalForTests,
  subscribeStructuredSessionReconnect
} from './structured-session-reconnect-signal'

afterEach(() => {
  resetStructuredSessionReconnectSignalForTests()
})

describe('structured session reconnect signal', () => {
  it('does not throw when nothing is listening', () => {
    expect(() => emitStructuredSessionReconnect()).not.toThrow()
  })

  it('notifies each listener once per emit and stops after unsubscribe', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeStructuredSessionReconnect(listener)

    emitStructuredSessionReconnect()
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    emitStructuredSessionReconnect()
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
