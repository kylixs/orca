/**
 * U138 frame-trace ring buffer: created only while the localStorage switch is on, so the closed
 * path reads one flag and allocates nothing.
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

/** Read on every entry: enabling mid-session starts with the next frame, no replay. */
export function isSessionTabsFrameTraceEnabled(): boolean {
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

export function getSessionTabsFrameTraceState(): SessionTabsFrameTraceState | null {
  if (!isSessionTabsFrameTraceEnabled()) {
    return null
  }
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

function installWindowHandle(): void {
  if (typeof window === 'undefined') {
    return
  }
  const handle: SessionTabsFrameTraceHandle = {
    get frames() {
      return traceState ? orderedFrames(traceState) : []
    },
    clear() {
      if (traceState) {
        traceState.frames.fill(undefined)
        traceState.cursor = 0
        traceState.size = 0
      }
    },
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
  traceState = null
  if (typeof window !== 'undefined') {
    delete window.__orcaSessionTabsTrace
  }
}
