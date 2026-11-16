/**
 * U138: record the `session.tabs.*` frames a web renderer exchanges with a paired host, so a
 * timeline can answer "who changed active, with which params, and did this frame win".
 *
 * Off by default; the switch is read once per page load (see the store), so the closed path never
 * touches storage again. 11 of the 13 renderer-callable `session.tabs.*` methods pass through the
 * mount points this module wraps; `unsubscribe`/`unsubscribeAll` are issued by the preload/shared
 * control layer instead. Known limits: call sites allocate their request object before the switch
 * is checked, `onClose` is not recorded, and a subscribe that rejects leaves no response frame.
 */
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import type { WebSessionTabsSnapshotApplyOptions } from './state'
import {
  appendFrame,
  frameAt,
  getSessionTabsFrameTraceState,
  nextFrameBase,
  type SessionTabsFrameTraceState
} from './session-tabs-frame-trace-store'
import {
  isRecord,
  normalizeWorktreeSelector,
  readResponseMeta,
  readString,
  summarizeApplyOptions,
  summarizeParams
} from './session-tabs-frame-summary'
import type {
  SessionTabsTraceFrame,
  SessionTabsTraceRequest,
  SessionTabsTraceSnapshotSummary,
  SessionTabsSubscriptionCallbacks
} from './session-tabs-frame-trace-types'

export {
  SESSION_TABS_FRAME_TRACE_STORAGE_KEY,
  disableSessionTabsFrameTrace,
  enableSessionTabsFrameTrace,
  isSessionTabsFrameTraceEnabled,
  resetSessionTabsFrameTraceForTests
} from './session-tabs-frame-trace-store'
export type {
  SessionTabsFrameTraceHandle,
  SessionTabsTraceApplyOptions,
  SessionTabsTraceFrame,
  SessionTabsTraceParams,
  SessionTabsTraceRequest,
  SessionTabsTraceResult,
  SessionTabsTraceSnapshotSummary,
  SessionTabsSubscriptionCallbacks
} from './session-tabs-frame-trace-types'

// The 11 methods that actually pass through the env-call/subscribe mount points; the catalog's
// `unsubscribe`/`unsubscribeAll` never do (preload/shared control issues them).
export const SESSION_TABS_TRACE_METHODS: ReadonlySet<string> = new Set([
  'session.tabs.list',
  'session.tabs.listAll',
  'session.tabs.activate',
  'session.tabs.close',
  'session.tabs.closeLifecycle',
  'session.tabs.subscribe',
  'session.tabs.subscribeAll',
  'session.tabs.createTerminal',
  'session.tabs.move',
  'session.tabs.setTabProps',
  'session.tabs.updatePaneLayout'
])

function readWorktreeFromParams(params: unknown): string | undefined {
  return isRecord(params) ? readString(params.worktree) : undefined
}

function recordRequestFrame(
  state: SessionTabsFrameTraceState,
  request: SessionTabsTraceRequest
): string {
  state.nextRequestId += 1
  const requestId = `q${state.nextRequestId}`
  const params = summarizeParams(request.params)
  appendFrame(state, {
    ...nextFrameBase(state, 'req'),
    requestId,
    method: request.method,
    environmentId: readString(request.selector),
    worktree: readString(params?.worktreeId) ?? readWorktreeFromParams(request.params),
    tabId: readString(params?.tabId),
    leafId: readString(params?.leafId),
    params
  })
  return requestId
}

function appendResponseFrame(
  state: SessionTabsFrameTraceState,
  requestId: string,
  request: SessionTabsTraceRequest,
  response: unknown
): void {
  const meta = readResponseMeta(response)
  const params = summarizeParams(request.params)
  appendFrame(state, {
    ...nextFrameBase(state, 'res'),
    requestId,
    method: request.method,
    environmentId: readString(request.selector),
    worktree: readString(params?.worktreeId) ?? readWorktreeFromParams(request.params),
    tabId: readString(params?.tabId),
    leafId: readString(params?.leafId),
    ok: meta.ok,
    errorCode: meta.errorCode,
    runtimeId: meta.runtimeId,
    result: meta.result
  })
}

/** Observe one request/response RPC. Disabled: one flag read, then the original call. */
export function traceSessionTabsCall<TResponse>(
  request: SessionTabsTraceRequest,
  call: () => Promise<TResponse>
): Promise<TResponse> {
  const state = getSessionTabsFrameTraceState()
  if (state === null || !SESSION_TABS_TRACE_METHODS.has(request.method)) {
    return call()
  }
  const requestId = recordRequestFrame(state, request)
  return call().then(
    (response) => {
      appendResponseFrame(state, requestId, request, response)
      return response
    },
    (error: unknown) => {
      appendFrame(state, {
        ...nextFrameBase(state, 'res'),
        requestId,
        method: request.method,
        environmentId: readString(request.selector),
        ok: false,
        // Why: transport failures carry messages that may embed host paths; keep only the fact.
        errorCode: 'transport_error'
      })
      throw error
    }
  )
}

/** Observe one subscription: the subscribe request plus every stream frame it emits. */
export function traceSessionTabsSubscription<THandle>(
  request: SessionTabsTraceRequest,
  callbacks: SessionTabsSubscriptionCallbacks,
  subscribe: (callbacks: SessionTabsSubscriptionCallbacks) => Promise<THandle>
): Promise<THandle> {
  const state = getSessionTabsFrameTraceState()
  if (state === null || !SESSION_TABS_TRACE_METHODS.has(request.method)) {
    return subscribe(callbacks)
  }
  const requestId = recordRequestFrame(state, request)
  return subscribe({
    ...callbacks,
    onResponse: (response) => {
      state.nextStreamSeq += 1
      const meta = readResponseMeta(response)
      appendFrame(state, {
        ...nextFrameBase(state, 'stream'),
        requestId,
        streamSeq: state.nextStreamSeq,
        method: request.method,
        environmentId: readString(request.selector),
        ok: meta.ok,
        errorCode: meta.errorCode,
        runtimeId: meta.runtimeId,
        result: meta.result
      })
      callbacks.onResponse(response)
    },
    onError: (error) => {
      state.nextStreamSeq += 1
      appendFrame(state, {
        ...nextFrameBase(state, 'stream'),
        requestId,
        streamSeq: state.nextStreamSeq,
        method: request.method,
        environmentId: readString(request.selector),
        ok: false,
        errorCode: error.code
      })
      callbacks.onError?.(error)
    }
  })
}

function snapshotMatchesSummary(
  summary: SessionTabsTraceSnapshotSummary,
  snapshot: RuntimeMobileSessionTabsResult
): boolean {
  const worktree = normalizeWorktreeSelector(snapshot.worktree)
  if (worktree !== undefined && summary.worktree !== worktree) {
    return false
  }
  if (
    summary.snapshotVersion !== undefined &&
    snapshot.snapshotVersion !== undefined &&
    summary.snapshotVersion !== snapshot.snapshotVersion
  ) {
    return false
  }
  if (
    summary.publicationEpoch !== undefined &&
    snapshot.publicationEpoch &&
    summary.publicationEpoch !== snapshot.publicationEpoch
  ) {
    return false
  }
  return summary.snapshotVersion !== undefined || summary.publicationEpoch !== undefined
}

function annotateFrame(
  frame: SessionTabsTraceFrame,
  snapshot: RuntimeMobileSessionTabsResult,
  applied: boolean,
  options: WebSessionTabsSnapshotApplyOptions | undefined
): boolean {
  const result = frame.result
  if (!result) {
    return false
  }
  if (result.snapshots) {
    const summary = result.snapshots.find((candidate) =>
      snapshotMatchesSummary(candidate, snapshot)
    )
    if (!summary) {
      return false
    }
    summary.applied = applied
    if (applied && options) {
      summary.applyOptions = summarizeApplyOptions(options)
    } else if (!applied) {
      delete summary.applyOptions
    }
    // Why: the frame-level flag is an aggregate over its snapshots; the latest verdict wins.
    frame.applied = result.snapshots.some((candidate) => candidate.applied === true)
  } else {
    if (!snapshotMatchesSummary(result, snapshot)) {
      return false
    }
    if (applied && options) {
      frame.applyOptions = summarizeApplyOptions(options)
    } else if (!applied) {
      delete frame.applyOptions
    }
    frame.applied = applied
  }
  return true
}

/** Backfill the frame that carried this snapshot with the apply layer's verdict. */
export function traceSessionTabsApplyDecision(
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult,
  applied: boolean,
  options?: WebSessionTabsSnapshotApplyOptions
): void {
  const state = getSessionTabsFrameTraceState()
  if (state === null) {
    return
  }
  const worktree = normalizeWorktreeSelector(snapshot.worktree)
  for (let index = state.size - 1; index >= 0; index -= 1) {
    const frame = frameAt(state, index)
    if (!frame || frame.dir === 'req' || frame.environmentId !== environmentId) {
      continue
    }
    // Frames that carry no worktree (subscribeAll) still match on version/epoch.
    if (
      worktree !== undefined &&
      frame.worktree !== undefined &&
      normalizeWorktreeSelector(frame.worktree) !== worktree
    ) {
      continue
    }
    if (annotateFrame(frame, snapshot, applied, options)) {
      return
    }
  }
}
