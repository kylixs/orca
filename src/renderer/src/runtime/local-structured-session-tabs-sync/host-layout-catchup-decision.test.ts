import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CATCHUP_COALESCE_MS,
  catchupFreshnessVerdict,
  createCatchupSingleFlight,
  decideHostLayoutCatchup,
  type HostLayoutCatchupDecisionInput
} from './host-layout-catchup-decision'

const NOW = 1_000_000

const hostLayout = (
  overrides: Record<string, unknown> = {}
): { tabGroups?: unknown[]; tabGroupLayout?: unknown } => ({
  tabGroups: [{ id: 'g-host' }],
  tabGroupLayout: { orientation: 'horizontal' },
  ...overrides
})

const input = (
  overrides: Partial<HostLayoutCatchupDecisionInput> = {}
): HostLayoutCatchupDecisionInput => ({
  windowFocusedVisible: true,
  hostLayout: hostLayout(),
  pendingPublish: false,
  gestureActive: false,
  lastCatchupAt: null,
  now: NOW,
  inFlight: false,
  ...overrides
})

describe('decideHostLayoutCatchup', () => {
  it('applies when every guard is clear', () => {
    expect(decideHostLayoutCatchup(input())).toEqual({ action: 'apply', reason: 'ready' })
  })

  it('skips a web client before any other guard', () => {
    expect(decideHostLayoutCatchup(input({ isWebClient: true, inFlight: true }))).toEqual({
      action: 'skip',
      reason: 'web-client'
    })
  })

  it('skips until the workspace session is ready', () => {
    expect(decideHostLayoutCatchup(input({ workspaceSessionReady: false }))).toEqual({
      action: 'skip',
      reason: 'workspace-session-not-ready'
    })
  })

  it('skips a non-local execution host', () => {
    expect(decideHostLayoutCatchup(input({ executionHostIsLocal: false }))).toEqual({
      action: 'skip',
      reason: 'not-local-execution-host'
    })
  })

  it('skips when the window is neither focused nor visible', () => {
    expect(decideHostLayoutCatchup(input({ windowFocusedVisible: false }))).toEqual({
      action: 'skip',
      reason: 'window-not-focused-or-visible'
    })
  })

  it('skips while a user gesture is active', () => {
    expect(decideHostLayoutCatchup(input({ gestureActive: true }))).toEqual({
      action: 'skip',
      reason: 'gesture-active'
    })
  })

  it('defers while a publish is pending', () => {
    expect(decideHostLayoutCatchup(input({ pendingPublish: true }))).toEqual({
      action: 'defer',
      reason: 'pending-publish'
    })
  })

  it('defers while a catch-up is already in flight', () => {
    expect(decideHostLayoutCatchup(input({ inFlight: true }))).toEqual({
      action: 'defer',
      reason: 'catchup-in-flight'
    })
  })

  it('skips when the host has not reported a layout at all', () => {
    expect(decideHostLayoutCatchup(input({ hostLayout: undefined }))).toEqual({
      action: 'skip',
      reason: 'host-layout-unreported'
    })
  })

  it('skips an explicitly empty host layout that has no tree', () => {
    expect(
      decideHostLayoutCatchup(input({ hostLayout: { tabGroups: [], tabGroupLayout: undefined } }))
    ).toEqual({ action: 'skip', reason: 'host-layout-empty' })
  })

  it('treats missing groups as empty only when no tree was reported', () => {
    expect(
      decideHostLayoutCatchup(
        input({ hostLayout: { tabGroups: undefined, tabGroupLayout: undefined } })
      )
    ).toEqual({ action: 'skip', reason: 'host-layout-empty' })
  })

  it('applies an explicit empty group list when the host reported a layout tree', () => {
    expect(
      decideHostLayoutCatchup(
        input({ hostLayout: { tabGroups: [], tabGroupLayout: { orientation: 'vertical' } } })
      )
    ).toEqual({ action: 'apply', reason: 'ready' })
  })

  it('coalesces a burst of triggers that already produced a catch-up', () => {
    expect(decideHostLayoutCatchup(input({ lastCatchupAt: NOW - 10 }))).toEqual({
      action: 'skip',
      reason: 'recently-caught-up'
    })
  })

  it('applies again once the coalescing window has elapsed', () => {
    expect(
      decideHostLayoutCatchup(input({ lastCatchupAt: NOW - DEFAULT_CATCHUP_COALESCE_MS }))
    ).toEqual({ action: 'apply', reason: 'ready' })
  })

  it('honours an injected coalescing window', () => {
    expect(
      decideHostLayoutCatchup(input({ lastCatchupAt: NOW - 40, coalesceWindowMs: 25 }))
    ).toEqual({ action: 'apply', reason: 'ready' })
  })
})

describe('catchupFreshnessVerdict', () => {
  it('applies a first catch-up when no local cursor exists', () => {
    expect(
      catchupFreshnessVerdict({
        history: undefined,
        version: undefined,
        epoch: 'e1',
        replySnapshotVersion: 1
      })
    ).toEqual({ action: 'apply', reason: 'no-local-cursor', revivesEpoch: false })
  })

  it('skips a same-lineage reply whose version is not newer', () => {
    expect(
      catchupFreshnessVerdict({
        history: undefined,
        version: { publicationEpoch: 'e1', snapshotVersion: 5 },
        epoch: 'e1',
        replySnapshotVersion: 5
      })
    ).toEqual({ action: 'skip', reason: 'same-lineage-not-newer', revivesEpoch: false })
  })

  it('applies a newer same-lineage reply', () => {
    expect(
      catchupFreshnessVerdict({
        history: undefined,
        version: { publicationEpoch: 'e1', snapshotVersion: 5 },
        epoch: 'e1',
        replySnapshotVersion: 6
      })
    ).toEqual({ action: 'apply', reason: 'same-lineage-newer', revivesEpoch: false })
  })

  it('treats a headless merge as the same lineage', () => {
    expect(
      catchupFreshnessVerdict({
        history: undefined,
        version: { publicationEpoch: 'e1', snapshotVersion: 5 },
        epoch: 'e1:headless-merge:host-1',
        replySnapshotVersion: 4
      })
    ).toEqual({ action: 'skip', reason: 'same-lineage-not-newer', revivesEpoch: false })
  })

  it('admits a cross-lineage reply because epochs have no total order', () => {
    expect(
      catchupFreshnessVerdict({
        history: undefined,
        version: { publicationEpoch: 'e1', snapshotVersion: 9 },
        epoch: 'e2',
        replySnapshotVersion: 1
      })
    ).toEqual({ action: 'apply', reason: 'cross-lineage', revivesEpoch: false })
  })

  it('skips a retired epoch unless the read is authoritative', () => {
    expect(
      catchupFreshnessVerdict({
        history: { current: 'e2', retired: ['e1'] },
        version: undefined,
        epoch: 'e1',
        replySnapshotVersion: 1,
        authoritative: false
      })
    ).toEqual({ action: 'skip', reason: 'retired-epoch', revivesEpoch: false })
  })

  it('admits a retired epoch authoritatively and reports the un-retire', () => {
    expect(
      catchupFreshnessVerdict({
        history: { current: 'e2', retired: ['e1'] },
        version: undefined,
        epoch: 'e1',
        replySnapshotVersion: 1
      })
    ).toEqual({ action: 'apply', reason: 'no-local-cursor', revivesEpoch: true })
  })

  it('never writes the shared history it is given', () => {
    const history = { current: 'e2', retired: ['e1'] }
    catchupFreshnessVerdict({
      history,
      version: undefined,
      epoch: 'e1',
      replySnapshotVersion: 1,
      authoritative: true
    })
    expect(history).toEqual({ current: 'e2', retired: ['e1'] })
  })

  it('reports no revival when an authoritative epoch was never retired', () => {
    expect(
      catchupFreshnessVerdict({
        history: { current: 'e1', retired: [] },
        version: undefined,
        epoch: 'e2',
        replySnapshotVersion: 1
      })
    ).toEqual({ action: 'apply', reason: 'no-local-cursor', revivesEpoch: false })
  })
})

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('createCatchupSingleFlight', () => {
  it('merges triggers during a flight and runs exactly once more', async () => {
    const latch = createCatchupSingleFlight<string>()
    const first = deferred<string>()
    const superseded = deferred<string>()
    const latest = deferred<string>()

    const run1 = latch.run(() => first.promise)
    expect(run1.status).toBe('ran')
    expect(latch.inFlight).toBe(true)

    const run2 = latch.run(() => superseded.promise)
    const run3 = latch.run(() => latest.promise)
    expect(run2.status).toBe('merged')
    expect(run3.status).toBe('merged')
    expect(latch.trailingScheduled).toBe(true)

    first.resolve('one')
    await expect(run1.completion).resolves.toBe('one')

    latest.resolve('three')
    await expect(run3.completion).resolves.toBe('three')
    await expect(run2.completion).resolves.toBe('three')
    expect(latch.inFlight).toBe(false)
    expect(latch.trailingScheduled).toBe(false)
  })

  it('accepts a new run after a completed flight', async () => {
    const latch = createCatchupSingleFlight<number>()
    await expect(latch.run(async () => 1).completion).resolves.toBe(1)
    expect(latch.inFlight).toBe(false)
    await expect(latch.run(async () => 2).completion).resolves.toBe(2)
  })

  it('does not stay stuck after a failed flight', async () => {
    const latch = createCatchupSingleFlight<number>()
    await expect(
      latch.run(async () => {
        throw new Error('boom')
      }).completion
    ).rejects.toThrow('boom')
    expect(latch.inFlight).toBe(false)
    await expect(latch.run(async () => 3).completion).resolves.toBe(3)
  })

  it('does not poison later runs when the trailing run fails', async () => {
    const latch = createCatchupSingleFlight<string>()
    const first = deferred<string>()
    const run1 = latch.run(() => first.promise)
    const run2 = latch.run(async () => {
      throw new Error('trailing boom')
    })

    first.resolve('one')
    await expect(run1.completion).resolves.toBe('one')
    await expect(run2.completion).rejects.toThrow('trailing boom')
    expect(latch.inFlight).toBe(false)
    await expect(latch.run(async () => 'next').completion).resolves.toBe('next')
  })
})
