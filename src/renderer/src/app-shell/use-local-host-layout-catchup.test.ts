// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  decideHostLayoutCatchup,
  type HostLayoutCatchupDecision
} from '../runtime/local-structured-session-tabs-sync/host-layout-catchup-decision'
import type {
  LocalHostLayoutCatchupOutcome,
  RunLocalHostLayoutCatchupArgs
} from '../runtime/local-structured-session-tabs-sync/run-local-host-layout-catchup'
import {
  useLocalHostLayoutCatchup,
  type LocalHostLayoutCatchupOptions
} from './use-local-host-layout-catchup'

const WORKTREE_ID = 'worktree-1'

function createHarness(overrides: Partial<LocalHostLayoutCatchupOptions> = {}) {
  let visible = true
  let focused = true
  let pending = false
  let visibilityListener: (() => void) | null = null
  let systemResumeCallback: (() => void) | null = null
  const unsubscribeVisibility = vi.fn(() => {
    visibilityListener = null
  })
  const unsubscribeSystemResumed = vi.fn(() => {
    systemResumeCallback = null
  })
  const unsubscribeReconnect = vi.fn()
  const settleListeners = new Set<() => void>()
  const decisions: HostLayoutCatchupDecision[] = []
  const outcomes: LocalHostLayoutCatchupOutcome[] = []

  const runCatchup = vi.fn(async (_args: RunLocalHostLayoutCatchupArgs) => {
    const outcome: LocalHostLayoutCatchupOutcome = pending
      ? { status: 'deferred', reason: 'pending-publish' }
      : { status: 'applied', groupCount: 1 }
    outcomes.push(outcome)
    return outcome
  })
  const decide = vi.fn((input: Parameters<typeof decideHostLayoutCatchup>[0]) => {
    const decision = decideHostLayoutCatchup(input)
    decisions.push(decision)
    return decision
  })

  const deps: LocalHostLayoutCatchupOptions = {
    getState: () => ({ activeWorktreeId: WORKTREE_ID, workspaceSessionReady: true }),
    isWindowFocused: () => focused,
    getVisible: () => visible,
    isPublishPending: () => pending,
    isGestureActive: () => false,
    subscribeVisibility: (onChange) => {
      visibilityListener = onChange
      return unsubscribeVisibility
    },
    subscribeSystemResumed: (callback) => {
      systemResumeCallback = callback
      return unsubscribeSystemResumed
    },
    subscribePublishSettled: (onSettled) => {
      settleListeners.add(onSettled)
      return () => settleListeners.delete(onSettled)
    },
    subscribeStructuredReconnect: () => unsubscribeReconnect,
    decide,
    runCatchup,
    ...overrides
  }

  return {
    deps,
    decide,
    runCatchup,
    decisions,
    outcomes,
    setVisible: (next: boolean) => {
      visible = next
    },
    setFocused: (next: boolean) => {
      focused = next
    },
    setPending: (next: boolean) => {
      pending = next
    },
    fireVisibilityChange: () => visibilityListener?.(),
    fireSystemResume: () => systemResumeCallback?.(),
    settlePublish: () => {
      pending = false
      for (const listener of settleListeners) {
        listener()
      }
    },
    unsubscribeVisibility,
    unsubscribeSystemResumed,
    unsubscribeReconnect
  }
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

describe('useLocalHostLayoutCatchup', () => {
  it('runs one catch-up for the active worktree on window focus', async () => {
    const harness = createHarness()
    renderHook(() => useLocalHostLayoutCatchup(harness.deps))

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await flush()

    expect(harness.runCatchup).toHaveBeenCalledTimes(1)
    expect(harness.runCatchup).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: WORKTREE_ID, windowFocusedVisible: true })
    )
  })

  it('skips while the window is not visible, then adopts the visibility resume edge', async () => {
    const harness = createHarness()
    harness.setVisible(false)
    renderHook(() => useLocalHostLayoutCatchup(harness.deps))

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await flush()
    expect(harness.runCatchup).not.toHaveBeenCalled()

    harness.setVisible(true)
    await act(async () => {
      harness.fireVisibilityChange()
    })
    await flush()

    expect(harness.runCatchup).toHaveBeenCalledTimes(1)
    expect(harness.runCatchup).toHaveBeenCalledWith(
      expect.objectContaining({ windowFocusedVisible: true })
    )
  })

  it('defers on a pending publish and reruns once at the settle edge', async () => {
    const harness = createHarness()
    harness.setPending(true)
    renderHook(() => useLocalHostLayoutCatchup(harness.deps))

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await flush()

    expect(harness.decisions.map((decision) => decision.action)).toEqual(['defer'])
    expect(harness.runCatchup).toHaveBeenCalledTimes(1)
    expect(harness.outcomes[0]).toEqual({ status: 'deferred', reason: 'pending-publish' })

    await act(async () => {
      harness.settlePublish()
    })
    await flush()

    expect(harness.decisions.map((decision) => decision.action)).toEqual(['defer', 'apply'])
    expect(harness.runCatchup).toHaveBeenCalledTimes(2)
    expect(harness.outcomes.filter((outcome) => outcome.status === 'applied')).toHaveLength(1)
  })

  it('treats online and system resume as catch-up triggers', async () => {
    const harness = createHarness()
    renderHook(() => useLocalHostLayoutCatchup(harness.deps))

    await act(async () => {
      window.dispatchEvent(new Event('online'))
      harness.fireSystemResume()
    })
    await flush()

    expect(harness.runCatchup).toHaveBeenCalledTimes(2)
  })

  it('stops triggering after unmount and releases every subscription', async () => {
    const harness = createHarness()
    const { unmount } = renderHook(() => useLocalHostLayoutCatchup(harness.deps))
    unmount()

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      window.dispatchEvent(new Event('online'))
      harness.fireSystemResume()
      harness.fireVisibilityChange()
    })
    await flush()

    expect(harness.runCatchup).not.toHaveBeenCalled()
    expect(harness.unsubscribeVisibility).toHaveBeenCalledTimes(1)
    expect(harness.unsubscribeSystemResumed).toHaveBeenCalledTimes(1)
    expect(harness.unsubscribeReconnect).toHaveBeenCalledTimes(1)
  })

  it('still triggers for a terminal-only workspace without a structured reconnect source', async () => {
    const harness = createHarness({ subscribeStructuredReconnect: undefined })
    renderHook(() => useLocalHostLayoutCatchup(harness.deps))

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await flush()

    expect(harness.decisions).toHaveLength(1)
    expect(harness.decisions[0]).toEqual({ action: 'apply', reason: 'ready' })
    expect(harness.runCatchup).toHaveBeenCalledTimes(1)
  })
})
