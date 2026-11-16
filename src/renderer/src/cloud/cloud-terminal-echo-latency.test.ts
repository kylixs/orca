import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  formatTerminalEchoBadge,
  formatTerminalEchoTooltip,
  percentileOf,
  setTerminalEchoDebugLogging,
  TERMINAL_ECHO_WINDOW_SIZE,
  TerminalEchoLatencyMeter
} from './cloud-terminal-echo-latency'

/**
 * U84a: the meter is observation only — timestamps go in, percentiles come out.
 * Sequences are driven with explicit clocks so every number is deterministic.
 */

beforeEach(() => {
  setTerminalEchoDebugLogging(false)
})

afterEach(() => {
  setTerminalEchoDebugLogging(true)
  vi.restoreAllMocks()
})

describe('云端终端回显计量（U84a）', () => {
  it('U84a-1 按键后收到回显才计一个样本', () => {
    const meter = new TerminalEchoLatencyMeter()

    expect(meter.recordKey(1_000)).toBeUndefined()
    expect(meter.hasPendingKeys()).toBe(true)

    expect(meter.recordEcho(1_040)).toEqual({ keyAt: 1_000, echoAt: 1_040, latencyMs: 40 })
    expect(meter.hasPendingKeys()).toBe(false)
    expect(meter.stats()).toEqual({ samples: 1, p50Ms: 40, p95Ms: 40, maxMs: 40 })
  })

  it('U84a-2 P50/P95/max 按最近窗口计算（nearest-rank）', () => {
    const meter = new TerminalEchoLatencyMeter()
    // Latencies 10,20,…,100 ms.
    for (let i = 1; i <= 10; i += 1) {
      meter.recordKey(i * 1_000)
      meter.recordEcho(i * 1_000 + i * 10)
    }

    expect(meter.stats()).toEqual({ samples: 10, p50Ms: 50, p95Ms: 100, maxMs: 100 })
  })

  it('U84a-2b percentileOf 空集为 null，乱序输入先排序', () => {
    expect(percentileOf([], 0.5)).toBeNull()
    expect(percentileOf([100, 1, 50], 0.5)).toBe(50)
    expect(percentileOf([100, 1, 50], 0.95)).toBe(100)
    expect(percentileOf([7], 0.95)).toBe(7)
  })

  it('U84a-3 无回显的按键不计入，超时回显也不计', () => {
    const meter = new TerminalEchoLatencyMeter()

    meter.recordKey(1_000)
    expect(meter.stats()).toEqual({ samples: 0, p50Ms: null, p95Ms: null, maxMs: null })

    // 5s later: no longer attributable to the key, so no sample.
    expect(meter.recordEcho(6_000)).toBeNull()
    expect(meter.stats().samples).toBe(0)
  })

  it('U84a-4 无待回显按键时的输出不产生样本', () => {
    const meter = new TerminalEchoLatencyMeter()
    expect(meter.recordEcho(500)).toBeNull()
    expect(meter.stats()).toEqual({ samples: 0, p50Ms: null, p95Ms: null, maxMs: null })
  })

  it('U84a-5 按键与回显按 FIFO 一一配对', () => {
    const meter = new TerminalEchoLatencyMeter()

    meter.recordKey(100)
    meter.recordKey(110)

    expect(meter.recordEcho(150)).toEqual({ keyAt: 100, echoAt: 150, latencyMs: 50 })
    expect(meter.recordEcho(160)).toEqual({ keyAt: 110, echoAt: 160, latencyMs: 50 })
    // Both keys matched; the next chunk has no key to consume.
    expect(meter.recordEcho(170)).toBeNull()
    expect(meter.stats().samples).toBe(2)
  })

  it('U84a-6 滚动窗口只保留最近 N 键', () => {
    const meter = new TerminalEchoLatencyMeter()
    for (let i = 1; i <= TERMINAL_ECHO_WINDOW_SIZE + 50; i += 1) {
      meter.recordKey(i * 1_000)
      meter.recordEcho(i * 1_000 + i)
    }

    // Remaining latencies are 51..250 ms.
    expect(meter.stats()).toEqual({
      samples: TERMINAL_ECHO_WINDOW_SIZE,
      p50Ms: 150,
      p95Ms: 240,
      maxMs: 250
    })
  })

  it('U84a-7 待回显队列有上限，挤掉最老的未配对按键', () => {
    const meter = new TerminalEchoLatencyMeter({ maxPending: 3 })
    for (const at of [1, 2, 3, 4, 5]) {
      meter.recordKey(at)
    }

    expect(meter.recordEcho(10)).toEqual({ keyAt: 3, echoAt: 10, latencyMs: 7 })
  })

  it('U84a-8 重连清空在途按键，不与重连后的首个输出配对', () => {
    const meter = new TerminalEchoLatencyMeter()
    meter.recordKey(1_000)
    meter.clearPending()

    expect(meter.hasPendingKeys()).toBe(false)
    expect(meter.recordEcho(1_050)).toBeNull()
  })

  it('U84a-9 自定义窗口与重置', () => {
    const meter = new TerminalEchoLatencyMeter({ windowSize: 3 })
    for (const latency of [10, 20, 30, 40, 50]) {
      meter.recordKey(0)
      meter.recordEcho(latency)
    }
    expect(meter.stats()).toEqual({ samples: 3, p50Ms: 40, p95Ms: 50, maxMs: 50 })

    meter.reset()
    expect(meter.stats()).toEqual({ samples: 0, p50Ms: null, p95Ms: null, maxMs: null })
  })

  it('U84a-10 徽标读数与悬停明细', () => {
    const empty = { samples: 0, p50Ms: null, p95Ms: null, maxMs: null }
    expect(formatTerminalEchoBadge(empty)).toBeNull()

    const stats = { samples: 5, p50Ms: 8.4, p95Ms: 12.4, maxMs: 40 }
    expect(formatTerminalEchoBadge(stats)).toBe('echo 12ms p95')
    expect(formatTerminalEchoTooltip(stats)).toBe('回显 P50 8ms · P95 12ms · max 40ms · 5 键')
  })

  it('U84a-11 逐键 console.debug 可关且不输出按键内容', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    setTerminalEchoDebugLogging(true)
    const meter = new TerminalEchoLatencyMeter({ label: 'cloud-admin' })

    meter.recordKey(0)
    meter.recordEcho(5)
    expect(debug).toHaveBeenCalledTimes(1)
    const [line, detail] = debug.mock.calls[0] ?? []
    expect(line).toContain('[terminal-echo] cloud-admin key→echo 5.0ms')
    expect(detail).toMatchObject({ keyAt: 0, echoAt: 5, samples: 1 })

    setTerminalEchoDebugLogging(false)
    meter.recordKey(10)
    meter.recordEcho(20)
    expect(debug).toHaveBeenCalledTimes(1)
  })
})
