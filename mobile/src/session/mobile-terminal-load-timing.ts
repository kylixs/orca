// Load-cycle timing for mobile terminal hydration: how long a snapshot takes
// subscribe → first frame → scrollback → replayed-into-xterm → first live data, so a slow
// "open a session" can be attributed to the host, the wire, or client replay.
import {
  logMobileTerminalDiagnostic,
  shortenMobileTerminalDiagnosticId
} from './mobile-terminal-diagnostic-log'

// Why: the cycle spans several stream events, so its start must survive between them.
// Keyed by handle; armed on each subscribe and cleared when the cycle ends or unsubscribes.
type LoadTiming = { startedAt: number; seq: number }

export class MobileTerminalLoadTiming {
  private readonly byHandle = new Map<string, LoadTiming>()

  arm(handle: string, seq: number): void {
    this.byHandle.set(handle, { startedAt: Date.now(), seq })
  }

  forget(handle: string): void {
    this.byHandle.delete(handle)
  }

  clear(): void {
    this.byHandle.clear()
  }

  /**
   * T0→now for the handle's current cycle; null when no cycle is armed or the seq is stale
   * (a superseded layout/reconnect). The host + wire cost is the first event's offset; the
   * remainder is client-side replay.
   */
  elapsedMs(handle: string, seq?: number): number | null {
    const load = this.byHandle.get(handle)
    if (load === undefined) {
      return null
    }
    if (seq !== undefined && load.seq !== seq) {
      return null
    }
    return Date.now() - load.startedAt
  }

  /** The first frame after arming (typically `subscribed`): host serialize + durable replay + wire. */
  firstStreamEvent(handle: string, seq: number, type: unknown): void {
    logMobileTerminalDiagnostic('stream-first-event', {
      handle: shortenMobileTerminalDiagnosticId(handle),
      seq,
      type: typeof type === 'string' ? type : 'unknown',
      elapsedMs: this.elapsedMs(handle, seq)
    })
  }

  /** The `serialized` scrollback landed and is about to be applied to xterm. */
  scrollbackReceived(handle: string, seq: number, serializedLength: number): void {
    logMobileTerminalDiagnostic('stream-scrollback-received', {
      handle: shortenMobileTerminalDiagnosticId(handle),
      seq,
      serializedLength,
      elapsedMs: this.elapsedMs(handle, seq)
    })
  }

  /** `ref.init()` returned: the scrollback was replayed into xterm (client CPU). */
  scrollbackApplied(handle: string, seq: number): void {
    logMobileTerminalDiagnostic('stream-scrollback-applied', {
      handle: shortenMobileTerminalDiagnosticId(handle),
      seq,
      elapsedMs: this.elapsedMs(handle, seq)
    })
  }

  /** First live `data` chunk after hydration: the cycle is complete. Ends it. */
  firstDataAfterHydration(handle: string, seq: number): void {
    logMobileTerminalDiagnostic('stream-first-data', {
      handle: shortenMobileTerminalDiagnosticId(handle),
      seq,
      elapsedMs: this.elapsedMs(handle, seq)
    })
    this.forget(handle)
  }
}
