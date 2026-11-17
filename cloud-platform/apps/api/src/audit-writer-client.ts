import type { AuditHealth, AuditQuery, AuditQueryResult, AuditSummary } from './audit.ts'
import type { AuditEvent, AuditEventInput } from './store.ts'

export type { AuditQuery, AuditQueryResult } from './audit.ts'

/**
 * The API replica's half of the single audit writer (design §3). Every audited
 * mutation is a call to the writer, so sequence numbers and `prevHash` come from
 * one place no matter how many replicas serve traffic.
 *
 * `append` throws on failure because callers treat it as write-ahead audit; a
 * failed write must stop the mutation rather than leave it unrecorded.
 */

export type RemoteAudit = {
  append: (input: AuditEventInput) => Promise<AuditEvent>
  appendBestEffort: (input: AuditEventInput) => boolean
  query: (filter: AuditQuery) => Promise<AuditQueryResult>
  summary: () => Promise<AuditSummary>
  verify: () => Promise<
    { ok: true; checked: number; tip: string } | { ok: false; brokenAtSeq: number; checked: number }
  >
  getHealth: () => AuditHealth
  readonly size: number
  readonly tip: string
}

/** What the server needs from either chain implementation. */
export type AuditSink = {
  append: (input: AuditEventInput) => AuditEvent | Promise<AuditEvent>
  appendBestEffort: (input: AuditEventInput) => boolean
  query: (filter: AuditQuery) => AuditQueryResult | Promise<AuditQueryResult>
  summary: () => AuditSummary | Promise<AuditSummary>
  verify: () =>
    | { ok: true; checked: number; tip: string }
    | { ok: false; brokenAtSeq: number; checked: number }
    | Promise<
        | { ok: true; checked: number; tip: string }
        | { ok: false; brokenAtSeq: number; checked: number }
      >
  getHealth: () => AuditHealth
  readonly size: number
  readonly tip: string
}

export function createRemoteAudit(options: {
  url?: string
  /** Leader plus standby; the client sticks to whichever answers and fails over. */
  urls?: string[]
  internalToken: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}): RemoteAudit {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 3_000
  const endpoints = options.urls?.length ? options.urls : options.url ? [options.url] : []
  let current = 0
  let health: AuditHealth = { ok: true }
  let lastSize = 0
  let lastTip = ''

  const send = (base: string, path: string, init: RequestInit): Promise<Response> =>
    fetchImpl(`${base}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), 'x-internal-token': options.internalToken },
      signal: AbortSignal.timeout(timeoutMs)
    })

  /**
   * Sticky failover. An unreachable writer or a standby is retried on the next
   * one; a broken chain is global (both share the log) and is never masked by
   * trying the other endpoint.
   */
  const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
    let lastError: unknown = new Error('no audit writer configured')
    for (let attempt = 0; attempt < endpoints.length; attempt += 1) {
      const index = (current + attempt) % endpoints.length
      const base = endpoints[index] ?? ''
      let res: Response
      try {
        res = await send(base, path, init)
      } catch (error) {
        lastError = error
        continue
      }
      if (res.status === 503) {
        const body = await res
          .clone()
          .json()
          .catch(() => null)
        const refused = body?.error?.code
        if (refused === 'AUDIT_WRITER_STANDBY') {
          lastError = Object.assign(new Error('audit writer is standby'), {
            code: 'AUDIT_WRITER_STANDBY'
          })
          continue
        }
      }
      current = index
      return res
    }
    throw lastError
  }

  const markWriteFailed = (error: unknown): void => {
    // A single failure must not wedge the API forever: the next successful call clears it.
    health = {
      ok: false,
      reason: 'write_failed',
      detail: error instanceof Error ? error.message : String(error)
    }
  }

  const append = async (input: AuditEventInput): Promise<AuditEvent> => {
    let res: Response
    try {
      res = await call('/v1/append', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ events: [input] })
      })
    } catch (error) {
      markWriteFailed(error)
      throw error
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null
      const refused = body?.error?.code
      if (res.status === 503 && refused === 'AUDIT_CHAIN_BROKEN') {
        health = { ok: false, reason: 'chain_broken', detail: 'audit writer chain broken' }
        throw Object.assign(new Error('audit chain broken'), { code: 'AUDIT_CHAIN_BROKEN' })
      }
      if (res.status === 503 && refused === 'AUDIT_WRITE_FAILED') {
        // Transient sink failure: retryable, and never latched as a broken chain.
        // Older writers send no such code and fall through to AUDIT_UNAVAILABLE.
        const detail = 'audit writer write failed'
        markWriteFailed(detail)
        throw Object.assign(new Error(detail), { code: 'AUDIT_UNAVAILABLE' })
      }
      const detail = `audit writer answered ${res.status}`
      markWriteFailed(detail)
      throw Object.assign(new Error(detail), { code: 'AUDIT_UNAVAILABLE' })
    }
    const body = (await res.json()) as { events?: AuditEvent[] }
    const event = body.events?.[0]
    if (!event) {
      markWriteFailed('audit writer returned no event')
      throw Object.assign(new Error('audit writer returned no event'), {
        code: 'AUDIT_UNAVAILABLE'
      })
    }
    health = { ok: true }
    lastSize = Math.max(lastSize, event.seq)
    lastTip = event.hash
    return event
  }

  return {
    append,
    appendBestEffort: (input) => {
      void append(input).catch(() => undefined)
      return true
    },
    query: async (filter) => {
      const params = new URLSearchParams({ limit: String(filter.limit) })
      if (filter.actor) params.set('actor', filter.actor)
      if (filter.eventType) params.set('eventType', filter.eventType)
      if (filter.eventTypes && filter.eventTypes.length > 0) {
        params.set('eventTypes', filter.eventTypes.join(','))
      }
      if (filter.result) params.set('result', filter.result)
      if (filter.traceId) params.set('traceId', filter.traceId)
      if (filter.since !== undefined) params.set('since', String(filter.since))
      if (filter.until !== undefined) params.set('until', String(filter.until))
      if (filter.fileName) params.set('fileName', filter.fileName)
      if (filter.keyword) params.set('q', filter.keyword)
      if (filter.username) params.set('username', filter.username)
      if (filter.projectId) params.set('projectId', filter.projectId)
      if (filter.hostId) params.set('hostId', filter.hostId)
      if (filter.cursor !== undefined) params.set('cursor', String(filter.cursor))
      const res = await call(`/v1/events?${params.toString()}`)
      if (!res.ok) {
        throw Object.assign(new Error(`audit query failed: ${res.status}`), {
          code: 'AUDIT_UNAVAILABLE'
        })
      }
      return (await res.json()) as AuditQueryResult
    },
    summary: async () => {
      const res = await call('/v1/summary')
      if (!res.ok) {
        markWriteFailed(`audit summary failed: ${res.status}`)
        throw Object.assign(new Error(`audit summary failed: ${res.status}`), {
          code: 'AUDIT_UNAVAILABLE'
        })
      }
      return (await res.json()) as AuditSummary
    },
    verify: async () => {
      const res = await call('/v1/verify')
      if (!res.ok) {
        markWriteFailed(`audit verify failed: ${res.status}`)
        return { ok: false, brokenAtSeq: 0, checked: 0 }
      }
      const body = (await res.json()) as
        | { ok: true; checked: number; tip: string; size?: number }
        | { ok: false; brokenAtSeq: number; checked: number; size?: number }
      if (body.ok) {
        health = { ok: true }
        lastSize = body.size ?? lastSize
        lastTip = body.tip
      }
      return body.ok
        ? { ok: true, checked: body.checked, tip: body.tip }
        : { ok: false, brokenAtSeq: body.brokenAtSeq, checked: body.checked }
    },
    getHealth: () => health,
    get size() {
      return lastSize
    },
    get tip() {
      return lastTip
    }
  }
}
