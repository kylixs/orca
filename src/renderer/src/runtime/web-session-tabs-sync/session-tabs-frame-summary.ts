import type { WebSessionTabsSnapshotApplyOptions } from './state'
import type {
  SessionTabsTraceApplyOptions,
  SessionTabsTraceParamKey,
  SessionTabsTraceParams,
  SessionTabsTraceResult,
  SessionTabsTraceSnapshotSummary
} from './session-tabs-frame-trace-types'

const TRACED_PARAM_KEYS: readonly SessionTabsTraceParamKey[] = [
  'navigation',
  'intent',
  'materializeOnly',
  'notifyClients',
  'persistSelection',
  'reason',
  'worktreeId',
  'tabId',
  'leafId'
]

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readPrimitive(value: unknown): string | boolean | number | undefined {
  return typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number'
    ? value
    : undefined
}

export function summarizeParams(params: unknown): SessionTabsTraceParams | undefined {
  if (!isRecord(params)) {
    return undefined
  }
  const summary: SessionTabsTraceParams = {}
  let present = false
  for (const key of TRACED_PARAM_KEYS) {
    const value = readPrimitive(params[key])
    if (value !== undefined) {
      summary[key] = value
      present = true
    }
  }
  return present ? summary : undefined
}

export function summarizeApplyOptions(
  options: WebSessionTabsSnapshotApplyOptions
): SessionTabsTraceApplyOptions {
  return {
    hostActiveAuthoritative: options.hostActiveAuthoritative === true,
    adoptHostLayout: options.adoptHostLayout === true
  }
}

function summarizeSnapshot(source: Record<string, unknown>): SessionTabsTraceSnapshotSummary {
  const summary: SessionTabsTraceSnapshotSummary = {}
  if (typeof source.activeTabId === 'string' || source.activeTabId === null) {
    summary.activeTabId = source.activeTabId
  }
  if (typeof source.activeGroupId === 'string' || source.activeGroupId === null) {
    summary.activeGroupId = source.activeGroupId
  }
  if (typeof source.snapshotVersion === 'number') {
    summary.snapshotVersion = source.snapshotVersion
  }
  if (typeof source.publicationEpoch === 'string') {
    summary.publicationEpoch = source.publicationEpoch
  }
  return summary
}

function summarizeResult(result: unknown): SessionTabsTraceResult | undefined {
  if (!isRecord(result)) {
    return undefined
  }
  if (Array.isArray(result.snapshots)) {
    const snapshots = result.snapshots.filter(isRecord).map(summarizeSnapshot)
    return snapshots.length > 0 ? { snapshots } : undefined
  }
  const summary = summarizeSnapshot(result)
  return Object.keys(summary).length > 0 ? summary : undefined
}

export function readResponseMeta(response: unknown): {
  ok: boolean
  errorCode?: string
  runtimeId?: string
  result?: SessionTabsTraceResult
} {
  if (!isRecord(response)) {
    return { ok: false }
  }
  const ok = response.ok === true
  const runtimeId =
    isRecord(response._meta) && typeof response._meta.runtimeId === 'string'
      ? response._meta.runtimeId
      : undefined
  const errorCode =
    !ok && isRecord(response.error) && typeof response.error.code === 'string'
      ? response.error.code
      : undefined
  const result = ok ? summarizeResult(response.result) : undefined
  return { ok, errorCode, runtimeId, result }
}
