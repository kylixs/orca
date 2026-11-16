/**
 * Per-keystroke echo RTT meter for cloud terminal panes (U84a, observation only).
 *
 * A key press (`onData`) is stamped, and the next PTY output chunk is treated as
 * its echo once xterm has parsed the chunk into the buffer (the `write` callback
 * xterm already supports). Matching is FIFO — output bursts and fast typing
 * coarsen samples toward "time to the next visible output", which is the
 * quantity the user feels. Keys whose echo never arrives within the match
 * timeout are dropped, never counted.
 *
 * Nothing here touches the input/output path: recording is O(1) and the meter is
 * driven only from timestamps the pane already produces.
 */

/** Rolling window: the most recent N echoed keys. */
export const TERMINAL_ECHO_WINDOW_SIZE = 200
/** An echo arriving later than this no longer explains the key; it is not counted. */
export const TERMINAL_ECHO_MATCH_TIMEOUT_MS = 2_000
/** Unmatched keys are capped so a dead link cannot grow the queue forever. */
export const TERMINAL_ECHO_MAX_PENDING = 64

export type TerminalEchoSample = {
  keyAt: number
  echoAt: number
  latencyMs: number
}

export type TerminalEchoStats = {
  samples: number
  p50Ms: number | null
  p95Ms: number | null
  maxMs: number | null
}

export type TerminalEchoLatencyMeterOptions = {
  windowSize?: number
  matchTimeoutMs?: number
  maxPending?: number
  /** Millisecond clock; `performance.now` gives sub-ms monotonic deltas. */
  now?: () => number
  /** Console label for the per-key debug line (session title). */
  label?: string
}

let echoDebugLogging = true

/** Per-key `console.debug` lines are on by default; turn off for quiet sessions. */
export function setTerminalEchoDebugLogging(enabled: boolean): void {
  echoDebugLogging = enabled
}

/** Nearest-rank percentile over an unsorted sample set; null when empty. */
export function percentileOf(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) {
    return null
  }
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))
  const value = sorted[index]
  return value === undefined ? null : value
}

function formatMs(value: number | null): string {
  return value === null ? '—' : `${Math.round(value)}ms`
}

/** `echo 12ms p95`; null until the first matching echo lands. */
export function formatTerminalEchoBadge(stats: TerminalEchoStats): string | null {
  return stats.p95Ms === null ? null : `echo ${Math.round(stats.p95Ms)}ms p95`
}

/** Hover detail: P50/P95/max plus the rolling-window sample count. */
export function formatTerminalEchoTooltip(stats: TerminalEchoStats): string {
  return `回显 P50 ${formatMs(stats.p50Ms)} · P95 ${formatMs(stats.p95Ms)} · max ${formatMs(stats.maxMs)} · ${stats.samples} 键`
}

function defaultNow(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now()
}

export class TerminalEchoLatencyMeter {
  private readonly windowSize: number
  private readonly matchTimeoutMs: number
  private readonly maxPending: number
  private readonly now: () => number
  private readonly label: string
  /** Send timestamps of keys awaiting their echo, oldest first. */
  private pending: number[] = []
  /** Latencies (ms) of matched keys, oldest first, capped at `windowSize`. */
  private latencies: number[] = []

  constructor(options: TerminalEchoLatencyMeterOptions = {}) {
    this.windowSize = options.windowSize ?? TERMINAL_ECHO_WINDOW_SIZE
    this.matchTimeoutMs = options.matchTimeoutMs ?? TERMINAL_ECHO_MATCH_TIMEOUT_MS
    this.maxPending = options.maxPending ?? TERMINAL_ECHO_MAX_PENDING
    this.now = options.now ?? defaultNow
    this.label = options.label ?? ''
  }

  recordKey(at: number = this.now()): void {
    this.pending.push(at)
    if (this.pending.length > this.maxPending) {
      // The oldest unmatched key loses its slot; it was never counted.
      this.pending.splice(0, this.pending.length - this.maxPending)
    }
  }

  /** The oldest fresh pending key consumed by an output chunk; null when none is fresh. */
  recordEcho(at: number = this.now()): TerminalEchoSample | null {
    const cutoff = at - this.matchTimeoutMs
    while (this.pending.length > 0) {
      const oldest = this.pending[0]
      if (oldest === undefined || oldest >= cutoff) {
        break
      }
      // Its echo was lost (dropped stream, killed prompt): not a sample.
      this.pending.shift()
    }
    const keyAt = this.pending.shift()
    if (keyAt === undefined) {
      return null
    }
    const latencyMs = Math.max(0, at - keyAt)
    this.latencies.push(latencyMs)
    if (this.latencies.length > this.windowSize) {
      this.latencies.splice(0, this.latencies.length - this.windowSize)
    }
    const sample: TerminalEchoSample = { keyAt, echoAt: at, latencyMs }
    if (echoDebugLogging) {
      const stats = this.stats()
      console.debug(
        `[terminal-echo]${this.label === '' ? '' : ` ${this.label}`} key→echo ${latencyMs.toFixed(1)}ms`,
        {
          keyAt,
          echoAt: at,
          samples: stats.samples,
          p50Ms: stats.p50Ms,
          p95Ms: stats.p95Ms,
          maxMs: stats.maxMs
        }
      )
    }
    return sample
  }

  hasPendingKeys(): boolean {
    return this.pending.length > 0
  }

  /** A reconnect loses in-flight echoes; those keys must not match later output. */
  clearPending(): void {
    this.pending.length = 0
  }

  stats(): TerminalEchoStats {
    return {
      samples: this.latencies.length,
      p50Ms: percentileOf(this.latencies, 0.5),
      p95Ms: percentileOf(this.latencies, 0.95),
      maxMs: this.latencies.length === 0 ? null : Math.max(...this.latencies)
    }
  }

  reset(): void {
    this.pending.length = 0
    this.latencies.length = 0
  }
}
