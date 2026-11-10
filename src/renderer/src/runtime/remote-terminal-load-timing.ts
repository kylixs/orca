// Load-path instrumentation for remote terminal hydration: how long a snapshot takes
// host→wire→reassemble→replay. Answer "where is the open-a-tab bottleneck" from a
// breadcrumb bundle instead of guessing. Off unless explicitly enabled.
import { recordRendererCrashBreadcrumb } from '@/lib/crash-breadcrumb-recorder'
import type { CrashReportBreadcrumbData } from '../../../shared/crash-reporting'
import type { RemoteRuntimeMultiplexedTerminalState } from './remote-runtime-terminal-multiplexer-types'

export const REMOTE_TERMINAL_LOAD_TIMING_KEY = 'orca:remote-terminal-load-timing'
const BREADCRUMB_PREFIX = 'remote_terminal_load_timing'

// WeakMap, not a stream field: keeps transient timing out of the stream state type and
// drops with the stream. One open straddles frames, so its start must survive between them.
type LoadTimingRecord = {
  target: RemoteRuntimeMultiplexedTerminalState['snapshotTarget']
  subscribedAt: number
  startedAt: number
  firstChunkAt: number | null
  chunks: number
  bytes: number
}
const activeLoads = new WeakMap<RemoteRuntimeMultiplexedTerminalState, LoadTimingRecord>()

export function isRemoteTerminalLoadTimingEnabled(): boolean {
  try {
    return localStorage.getItem(REMOTE_TERMINAL_LOAD_TIMING_KEY) === '1'
  } catch {
    // A blocked storage getter must not break terminal startup.
    return false
  }
}

function emit(data: CrashReportBreadcrumbData): void {
  try {
    recordRendererCrashBreadcrumb(BREADCRUMB_PREFIX, data)
  } catch {
    // Optional diagnostics only; never make hydration fail.
  }
}

/**
 * Subscribe: the client sent the Subscribe frame. Establishes the T0 the later phases measure
 * against, so `requestMs` (T0→first byte) isolates the host's own serialize+durable-replay cost.
 */
export function recordSnapshotRequested(stream: RemoteRuntimeMultiplexedTerminalState): void {
  if (!isRemoteTerminalLoadTimingEnabled()) {
    return
  }
  activeLoads.set(stream, {
    target: 'initial',
    subscribedAt: performance.now(),
    startedAt: 0,
    firstChunkAt: null,
    chunks: 0,
    bytes: 0
  })
  emit({ phase: 'subscribed', streamId: stream.streamId, terminal: stream.terminal })
}

/** SnapshotStart: the host began publishing an image. */
export function beginSnapshotLoad(
  stream: RemoteRuntimeMultiplexedTerminalState,
  target: RemoteRuntimeMultiplexedTerminalState['snapshotTarget'],
  info: { scrollbackRows?: number; truncated?: boolean; cols?: number; rows?: number } | null
): void {
  if (!isRemoteTerminalLoadTimingEnabled()) {
    return
  }
  const now = performance.now()
  const existing = activeLoads.get(stream)
  activeLoads.set(stream, {
    target,
    subscribedAt: existing?.subscribedAt ?? now,
    startedAt: now,
    firstChunkAt: null,
    chunks: 0,
    bytes: 0
  })
  emit({
    phase: 'start',
    target,
    streamId: stream.streamId,
    terminal: stream.terminal,
    scrollbackRows: info?.scrollbackRows ?? null,
    truncated: info?.truncated ?? false,
    cols: info?.cols ?? null,
    rows: info?.rows ?? null
  })
}

/** SnapshotChunk: one frame of image bytes. Records the first-chunk instant (network TTFB). */
export function recordSnapshotChunk(
  stream: RemoteRuntimeMultiplexedTerminalState,
  payloadBytes: number
): void {
  if (!isRemoteTerminalLoadTimingEnabled()) {
    return
  }
  const record = activeLoads.get(stream)
  if (!record) {
    return
  }
  record.chunks += 1
  record.bytes += payloadBytes
  if (record.firstChunkAt === null) {
    record.firstChunkAt = performance.now()
  }
}

/** SnapshotEnd: all bytes arrived. Splits transfer (first byte) from reassembly (full group). */
export function endSnapshotLoad(stream: RemoteRuntimeMultiplexedTerminalState): void {
  const record = activeLoads.get(stream)
  if (!record) {
    return
  }
  activeLoads.delete(stream)
  if (!isRemoteTerminalLoadTimingEnabled()) {
    return
  }
  const now = performance.now()
  emit({
    phase: 'received',
    target: record.target,
    streamId: stream.streamId,
    terminal: stream.terminal,
    chunks: record.chunks,
    bytes: record.bytes,
    // T0(subscribe)→SnapshotStart: the host's own serialize + durable-replay cost, roughly.
    requestMs: record.startedAt - record.subscribedAt,
    firstByteMs: record.firstChunkAt === null ? null : record.firstChunkAt - record.subscribedAt,
    receiveMs: now - record.subscribedAt,
    // Time beyond the first byte: the wire + host-emit phase, not host CPU before TTFB.
    transferMs: record.firstChunkAt === null ? null : now - record.firstChunkAt
  })
}

/**
 * onSnapshot: the image has been applied (xterm replay). `onSnapshot` is synchronous, so this
 * measures the replay itself; the tail from SnapshotEnd is the client apply cost.
 */
export function recordSnapshotApplied(
  stream: RemoteRuntimeMultiplexedTerminalState,
  meta: { seq?: number; carriesHistory?: boolean } | undefined,
  dataLength: number
): void {
  if (!isRemoteTerminalLoadTimingEnabled()) {
    return
  }
  emit({
    phase: 'applied',
    target: stream.snapshotTarget,
    streamId: stream.streamId,
    terminal: stream.terminal,
    seq: meta?.seq ?? null,
    chars: dataLength,
    carriesHistory: meta?.carriesHistory ?? false
  })
}
