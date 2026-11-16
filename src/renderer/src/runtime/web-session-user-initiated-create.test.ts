import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearUserInitiatedTerminalCreateForTests,
  consumeUserInitiatedTerminalCreate,
  discardUserInitiatedTerminalCreate,
  markUserInitiatedTerminalCreate,
  peekUserInitiatedTerminalCreate
} from './web-session-user-initiated-create'

const TTL_MS = 2 * 60_000

describe('U154: user-initiated terminal create ledger', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    clearUserInitiatedTerminalCreateForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
    clearUserInitiatedTerminalCreateForTests()
  })

  it('marks and consumes one create', () => {
    markUserInitiatedTerminalCreate('tab-1')
    expect(peekUserInitiatedTerminalCreate('tab-1')).toBe(true)
    consumeUserInitiatedTerminalCreate('tab-1')
    expect(peekUserInitiatedTerminalCreate('tab-1')).toBe(false)
  })

  it('sweeps expired entries on the next mark', () => {
    markUserInitiatedTerminalCreate('stale-tab')
    vi.advanceTimersByTime(TTL_MS + 1)
    markUserInitiatedTerminalCreate('fresh-tab')

    expect(peekUserInitiatedTerminalCreate('stale-tab')).toBe(false)
    expect(peekUserInitiatedTerminalCreate('fresh-tab')).toBe(true)
  })

  it('drops the mark when a create fails or aborts', () => {
    markUserInitiatedTerminalCreate('aborted-tab')
    discardUserInitiatedTerminalCreate('aborted-tab')
    expect(peekUserInitiatedTerminalCreate('aborted-tab')).toBe(false)
  })
})
