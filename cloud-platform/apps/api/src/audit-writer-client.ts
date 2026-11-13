import type { AuditHealth } from './audit.ts'
import type { AuditEvent, AuditEventInput } from './store.ts'

/**
 * The API replica's half of the single audit writer (design §3). Every audited
 * mutation is a call to the writer, so sequence numbers and `prevHash` come from
 * one place no matter how many replicas serve traffic.
 *
 * `append` throws on failure because callers treat it as write-ahead audit; a
 * failed write must stop the mutation rather than leave it unrecorded.
 */

export type AuditQuery = {
  actor?: string
  eventType?: string
  result?: string
  since?: number
  limit: number
  cursor?: number
}

export type AuditQueryResult = { events: AuditEvent[]; nextCursor: number | null }

export type RemoteAudit = {
  append: (input: AuditEventInput) => Promise<AuditEvent>
  appendBestEffort: (input: AuditEventInput) => boolean
  query: (filter: AuditQuery) => Promise<AuditQueryResult>
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
  verify: () =>
    | { ok: true; checked: number; tip: string }
    | { ok: false; brokenAtSeq: number; checked: number }
    | Promise<
        { ok: true; checked: number; tip: string } | { ok: false; brokenAtSeq: number; checked: number }
      >
  getHealth: () => AuditHealth
  readonly size: number
  readonly tip: string
}

export function createRemoteAudit(options: {
  url: string
  internalToken: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}): RemoteAudit {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 3_000
  let health: AuditHealth = { ok: true }
  let lastSize = 0
  let lastTip = ''

  const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const res = await fetchImpl(`${options.url}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), 'x-internal-token': options.internalToken },
      signal: AbortSignal.timeout(timeoutMs)
    })
    return res
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
      if (filter.result) params.set('result', filter.result)
      if (filter.since !== undefined) params.set('since', String(filter.since))
      if (filter.cursor !== undefined) params.set('cursor', String(filter.cursor))
      const res = await call(`/v1/events?${params.toString()}`)
      if (!res.ok) {
        throw Object.assign(new Error(`audit query failed: ${res.status}`), {
          code: 'AUDIT_UNAVAILABLE'
        })
      }
      return (await res.json()) as AuditQueryResult
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
