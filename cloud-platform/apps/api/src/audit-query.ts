/**
 * Shared parser for audit query filters (`GET /v1/audit/events` and, later,
 * audit export). Pure: no store, no clock, no HTTP response.
 */

export const AUDIT_WINDOW_MS = 31 * 24 * 60 * 60_000
export const AUDIT_RECENT_WINDOW_MS = 7 * 24 * 60 * 60_000
export const AUDIT_MAX_LIMIT = 200
export const AUDIT_DEFAULT_LIMIT = 50

export type AuditQueryErrorCode = 'INVALID_QUERY' | 'TIME_WINDOW_TOO_LARGE'

export type AuditQueryFilters = {
  limit: number
  /** Explicit eventTypes win over the eventFamily shortcut. */
  eventTypes?: string[]
  fileName?: string
  keyword?: string
  /** Effective lower bound: explicit since, else 31d before until, else 7d for q/fileName. */
  since?: number
  until?: number
}

export type AuditQueryParseResult =
  | { ok: true; value: AuditQueryFilters }
  | { ok: false; code: AuditQueryErrorCode; message: string }

export function parseAuditQuery(
  params: URLSearchParams,
  nowMs: number
): AuditQueryParseResult {
  // Why clamp rather than 400: 0/-1/NaN reached audit.slice as 0/-1/NaN and
  // returned the whole chain. Falling back to the documented page size keeps
  // older callers working while never widening the page (U57 U8).
  const requestedLimit = Number(params.get('limit') ?? AUDIT_DEFAULT_LIMIT)
  const limit =
    Number.isInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, AUDIT_MAX_LIMIT)
      : AUDIT_DEFAULT_LIMIT

  const rawEventTypes = (params.get('eventTypes') ?? '')
    .split(',')
    .map((type) => type.trim())
    .filter((type) => type !== '')
  if (rawEventTypes.length > 20) {
    return { ok: false, code: 'INVALID_QUERY', message: 'eventTypes 最多 20 个。' }
  }
  if (rawEventTypes.some((type) => type.length > 64)) {
    return { ok: false, code: 'INVALID_QUERY', message: 'eventTypes 每个最多 64 字符。' }
  }

  const family = params.get('eventFamily')
  let familyTypes: string[] | undefined
  if (family === 'download') familyTypes = ['file_download', 'download_blocked']
  else if (family === 'copy') familyTypes = ['file_copy']
  else if (family !== null && family !== '') {
    return { ok: false, code: 'INVALID_QUERY', message: 'eventFamily 仅支持 download/copy。' }
  }
  // Explicit eventTypes wins over the family shortcut and over eventType.
  const eventTypes = rawEventTypes.length > 0 ? rawEventTypes : familyTypes

  const fileNameRaw = (params.get('fileName') ?? '').trim()
  if (fileNameRaw.length > 128) {
    return { ok: false, code: 'INVALID_QUERY', message: 'fileName 最多 128 字符。' }
  }
  const fileName = fileNameRaw === '' ? undefined : fileNameRaw

  const keywordRaw = (params.get('q') ?? params.get('keyword') ?? '').trim()
  if (keywordRaw.length > 128) {
    return { ok: false, code: 'INVALID_QUERY', message: 'q 最多 128 字符。' }
  }
  if (keywordRaw.length === 1) {
    return { ok: false, code: 'INVALID_QUERY', message: 'q 至少 2 个字符。' }
  }
  const keyword = keywordRaw === '' ? undefined : keywordRaw

  const sinceParam = params.get('since')
  const parsedSince = sinceParam ? Date.parse(sinceParam) : undefined
  // Why ignore a bad since: old clients sent strings the chain silently dropped;
  // a bad until is new input, so it is a caller error instead.
  const since =
    parsedSince !== undefined && !Number.isNaN(parsedSince) ? parsedSince : undefined
  const untilParam = params.get('until')
  const until = untilParam === null ? undefined : Date.parse(untilParam)
  if (until !== undefined && Number.isNaN(until)) {
    return { ok: false, code: 'INVALID_QUERY', message: 'until 不是有效时间。' }
  }
  if (until !== undefined) {
    const lower = since ?? until - AUDIT_WINDOW_MS
    if (lower > until || until - lower > AUDIT_WINDOW_MS) {
      return { ok: false, code: 'TIME_WINDOW_TOO_LARGE', message: '查询时间窗最大 31 天。' }
    }
  } else if (since && nowMs - since > AUDIT_WINDOW_MS) {
    return { ok: false, code: 'TIME_WINDOW_TOO_LARGE', message: '查询时间窗最大 31 天。' }
  }
  // Keyword/fileName without an explicit window would scan the whole chain;
  // default it to the documented seven days (AC-13), never to no lower bound.
  let querySince = since ?? (until !== undefined ? until - AUDIT_WINDOW_MS : undefined)
  if (querySince === undefined && (fileName !== undefined || keyword !== undefined)) {
    querySince = nowMs - AUDIT_RECENT_WINDOW_MS
  }

  return {
    ok: true,
    value: { limit, eventTypes, fileName, keyword, since: querySince, until }
  }
}
