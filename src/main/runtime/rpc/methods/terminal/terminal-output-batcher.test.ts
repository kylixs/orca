import { expect, it } from 'vitest'
import type { TerminalOutputSourceRange } from '../../../../../shared/terminal-output-source-range'
import { createTerminalOutputBatcher } from './terminal-output-batcher'

function range(start: number): TerminalOutputSourceRange {
  return {
    id: 'pty',
    providerGeneration: 1,
    clientGeneration: 1,
    ownerGeneration: 1,
    ptyIncarnation: 'incarnation',
    deliveryToken: 'delivery',
    spanId: `span-${start}`,
    sourceStartSu: start,
    sourceEndSu: start + 1,
    displayStart: start,
    displayEnd: start + 1,
    splittable: true,
    transform: { transformed: false, rawLengthSu: 1, scalarSafe: true }
  }
}

it('flushes a lone small interactive write at once and still coalesces a burst', () => {
  const delivered: string[] = []
  const batcher = createTerminalOutputBatcher((data) => delivered.push(data))
  try {
    // One keystroke echo must not wait for the 5ms coalescing timer.
    batcher.push('a')
    expect(delivered).toEqual(['a'])
    // A burst keeps batching: only an isolated write skips the timer.
    batcher.push('b')
    batcher.push('c')
    expect(delivered).toEqual(['a'])
    batcher.flush()
    expect(delivered).toEqual(['a', 'bc'])
    // A write above the interactive size still rides the coalescing timer.
    batcher.push('x'.repeat(257))
    expect(delivered).toEqual(['a', 'bc'])
    batcher.flush()
    expect(delivered).toHaveLength(3)
  } finally {
    batcher.dispose()
  }
})

it('keeps delivered ranges frozen and isolated from reentrant flushes and disposal', () => {
  const firstRange = range(0)
  const secondRange = range(1)
  const sourceRanges = [firstRange]
  const delivered: (readonly TerminalOutputSourceRange[])[] = []
  const batcher = createTerminalOutputBatcher((_data, meta) => {
    delivered.push(meta!.sourceRanges!)
    if (delivered.length === 1) {
      batcher.push('b', { sourceRanges: [secondRange] })
      batcher.flush()
    }
  })
  try {
    batcher.push('a', { sourceRanges })
    batcher.flush()
    sourceRanges.push(secondRange)
    batcher.dispose()
    expect(delivered).toEqual([[firstRange], [secondRange]])
    expect(delivered[0]).not.toBe(delivered[1])
    expect(delivered.every(Object.isFrozen)).toBe(true)
    expect(Object.isFrozen(sourceRanges)).toBe(false)
  } finally {
    batcher.dispose()
  }
})
