/**
 * U138 frame-trace ring buffer. The `orca.debug.sessionTabs` flag is read once per page load and
 * cached, so the closed path allocates nothing and never touches storage again.
 */
import type {
  SessionTabsFrameTraceHandle,
  SessionTabsTraceFrame
} from './session-tabs-frame-trace-types'

export const SESSION_TABS_FRAME_TRACE_STORAGE_KEY = 'orca.debug.sessionTabs'
const FRAME_TRACE_CAPACITY = 300

export type SessionTabsFrameTraceState = {
  frames: (SessionTabsTraceFrame | undefined)[]
  cursor: number
  size: number
  nextSeq: number
  nextStreamSeq: number
  nextRequestId: number
}

let traceState: SessionTabsFrameTraceState | null = null
/** `null` until the first entry point runs, i.e. the page-load read. */
let enabledCache: boolean | null = null

function readStoredFlag(): boolean {
  try {
    if (typeof localStorage === 'undefined') {
      return false
    }
    return localStorage.getItem(SESSION_TABS_FRAME_TRACE_STORAGE_KEY) === '1'
  } catch {
    // A blocked storage getter must not break tab sync.
    return false
  }
}

/** One storage read per page load; every later call is a cached boolean. */
export function isSessionTabsFrameTraceEnabled(): boolean {
  if (enabledCache === null) {
    enabledCache = readStoredFlag()
  }
  return enabledCache
}

/** Runtime entry point: persist the switch, start a fresh ring, and install the window handle. */
export function enableSessionTabsFrameTrace(): void {
  if (enabledCache === true && traceState !== null) {
    return
  }
  enabledCache = true
  try {
    localStorage.setItem(SESSION_TABS_FRAME_TRACE_STORAGE_KEY, '1')
  } catch {
    // In-memory tracing still works when storage is blocked.
  }
  ensureTraceState()
}

/** Close the switch for this page and remove the window handle and retained frames. */
export function disableSessionTabsFrameTrace(): void {
  enabledCache = false
  traceState = null
  try {
    localStorage.removeItem(SESSION_TABS_FRAME_TRACE_STORAGE_KEY)
  } catch {
    // Nothing to clear when storage is blocked.
  }
  uninstallWindowHandle()
}

export function getSessionTabsFrameTraceState(): SessionTabsFrameTraceState | null {
  if (!isSessionTabsFrameTraceEnabled()) {
    return null
  }
  return ensureTraceState()
}

function ensureTraceState(): SessionTabsFrameTraceState {
  if (!traceState) {
    traceState = {
      frames: Array.from<SessionTabsTraceFrame | undefined>({ length: FRAME_TRACE_CAPACITY }),
      cursor: 0,
      size: 0,
      nextSeq: 0,
      nextStreamSeq: 0,
      nextRequestId: 0
    }
    installWindowHandle()
  }
  return traceState
}

function uninstallWindowHandle(): void {
  if (typeof window !== 'undefined') {
    delete window.__orcaSessionTabsTrace
  }
}

function installWindowHandle(): void {
  if (typeof window === 'undefined') {
    return
  }
  const handle: SessionTabsFrameTraceHandle = {
    get frames() {
      return traceState ? orderedFrames(traceState) : []
    },
    // Why: clear keeps the handle (and the seq counters) so a probe can keep sampling.
    clear() {
      if (traceState) {
        traceState.frames.fill(undefined)
        traceState.cursor = 0
        traceState.size = 0
      }
    },
    enable: enableSessionTabsFrameTrace,
    disable: disableSessionTabsFrameTrace,
    dump() {
      return JSON.stringify({
        capacity: FRAME_TRACE_CAPACITY,
        size: traceState?.size ?? 0,
        frames: traceState ? orderedFrames(traceState) : []
      })
    }
  }
  window.__orcaSessionTabsTrace = handle
}

function orderedFrames(state: SessionTabsFrameTraceState): SessionTabsTraceFrame[] {
  const ordered: SessionTabsTraceFrame[] = []
  const start = state.size === FRAME_TRACE_CAPACITY ? state.cursor : 0
  for (let index = 0; index < state.size; index += 1) {
    const frame = state.frames[(start + index) % FRAME_TRACE_CAPACITY]
    if (frame) {
      ordered.push(frame)
    }
  }
  return ordered
}

export function frameAt(
  state: SessionTabsFrameTraceState,
  logicalIndex: number
): SessionTabsTraceFrame | undefined {
  const start = state.size === FRAME_TRACE_CAPACITY ? state.cursor : 0
  return state.frames[(start + logicalIndex) % FRAME_TRACE_CAPACITY]
}

export function appendFrame(state: SessionTabsFrameTraceState, frame: SessionTabsTraceFrame): void {
  state.frames[state.cursor] = frame
  state.cursor = (state.cursor + 1) % FRAME_TRACE_CAPACITY
  state.size = Math.min(state.size + 1, FRAME_TRACE_CAPACITY)
}

export function nextFrameBase(
  state: SessionTabsFrameTraceState,
  dir: SessionTabsTraceFrame['dir']
) {
  state.nextSeq += 1
  return { seq: state.nextSeq, ts: Date.now(), dir }
}

export function resetSessionTabsFrameTraceForTests(): void {
  enabledCache = null
  traceState = null
  uninstallWindowHandle()
}
