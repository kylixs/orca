import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearUserInitiatedTerminalCreateForTests,
  consumeUserInitiatedTerminalCreate,
  discardUserInitiatedTerminalCreate,
  markUserInitiatedTerminalCreate,
  peekUserInitiatedTerminalCreate,
  peekUserInitiatedTerminalCreateForWorktree
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

  it('keeps worktree gestures isolated from each other', () => {
    markUserInitiatedTerminalCreate('tab-a', 'wt-a')
    markUserInitiatedTerminalCreate('tab-b', 'wt-b')

    expect(peekUserInitiatedTerminalCreateForWorktree('wt-a')).toBe(true)
    expect(peekUserInitiatedTerminalCreateForWorktree('wt-b')).toBe(true)
    expect(peekUserInitiatedTerminalCreateForWorktree('wt-c')).toBe(false)

    consumeUserInitiatedTerminalCreate('tab-a')
    expect(peekUserInitiatedTerminalCreateForWorktree('wt-a')).toBe(false)
    expect(peekUserInitiatedTerminalCreateForWorktree('wt-b')).toBe(true)
  })

  it('does not let an unmarked tab answer for a worktree', () => {
    markUserInitiatedTerminalCreate('no-worktree-tab')
    expect(peekUserInitiatedTerminalCreateForWorktree('wt-a')).toBe(false)
  })

  it('scopes a gesture to its environment when two environments share a worktree (U161 R3)', () => {
    markUserInitiatedTerminalCreate('tab-env-a', 'wt-shared', 'env-a')
    markUserInitiatedTerminalCreate('tab-env-b', 'wt-shared', 'env-b')

    expect(peekUserInitiatedTerminalCreateForWorktree('wt-shared', 'env-a')).toBe(true)
    expect(peekUserInitiatedTerminalCreateForWorktree('wt-shared', 'env-b')).toBe(true)
    expect(peekUserInitiatedTerminalCreateForWorktree('wt-shared', 'env-c')).toBe(false)

    // A-ing a gesture must not let the other environment borrow it.
    consumeUserInitiatedTerminalCreate('tab-env-a', 'env-a')
    expect(peekUserInitiatedTerminalCreateForWorktree('wt-shared', 'env-a')).toBe(false)
    expect(peekUserInitiatedTerminalCreateForWorktree('wt-shared', 'env-b')).toBe(true)
  })

  it('keeps an env-less legacy mark out of a scoped worktree query', () => {
    markUserInitiatedTerminalCreate('legacy-tab', 'wt-shared')

    expect(peekUserInitiatedTerminalCreateForWorktree('wt-shared', 'env-a')).toBe(false)
    // Unscoped (legacy) readers still see it.
    expect(peekUserInitiatedTerminalCreateForWorktree('wt-shared')).toBe(true)
    expect(peekUserInitiatedTerminalCreate('legacy-tab')).toBe(true)
  })
})
