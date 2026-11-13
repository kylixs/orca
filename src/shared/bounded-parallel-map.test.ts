import { describe, expect, it } from 'vitest'
import { boundedParallelMap } from './bounded-parallel-map'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))

describe('boundedParallelMap', () => {
  it('never runs more than `limit` tasks at once', async () => {
    let running = 0
    let peak = 0
    await boundedParallelMap([1, 2, 3, 4, 5, 6], 2, async (value) => {
      running += 1
      peak = Math.max(peak, running)
      await tick()
      running -= 1
      return value * 2
    })
    expect(peak).toBe(2)
  })

  it('returns results in input order even when later tasks finish first', async () => {
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()]
    const pending = boundedParallelMap([0, 1, 2], 3, async (value) => {
      await gates[value].promise
      return `item-${value}`
    })
    gates[2].resolve()
    gates[1].resolve()
    gates[0].resolve()
    const results = await pending
    expect(results.map((result) => (result.status === 'fulfilled' ? result.value : null))).toEqual([
      'item-0',
      'item-1',
      'item-2'
    ])
  })

  it('returns an empty array for no items', async () => {
    await expect(boundedParallelMap([], 3, async () => 'never')).resolves.toEqual([])
  })

  it('treats a limit below one as a single worker', async () => {
    let running = 0
    let peak = 0
    const results = await boundedParallelMap([1, 2, 3], 0, async (value) => {
      running += 1
      peak = Math.max(peak, running)
      await tick()
      running -= 1
      return value
    })
    expect(peak).toBe(1)
    expect(results.map((result) => (result.status === 'fulfilled' ? result.value : null))).toEqual([
      1, 2, 3
    ])
  })

  it('isolates a rejected task to its own slot', async () => {
    const failure = new Error('boom')
    const results = await boundedParallelMap(['ok', 'bad', 'ok-too'], 2, async (value) => {
      if (value === 'bad') {
        throw failure
      }
      return value
    })
    expect(results[0]).toEqual({ status: 'fulfilled', value: 'ok' })
    expect(results[1]).toEqual({ status: 'rejected', reason: failure })
    expect(results[2]).toEqual({ status: 'fulfilled', value: 'ok-too' })
  })
})
