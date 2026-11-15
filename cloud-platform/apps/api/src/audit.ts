import { createHash } from 'node:crypto'
import { canonicalJson } from '../../../packages/contract/src/credential.ts'
import type { AuditEvent, AuditEventInput } from './store.ts'

/** The chain needs only the tail plus the log it appends to, not the whole store. */
export type AuditStore = Pick<import('./store.ts').Store, 'audit' | 'auditSeq' | 'auditTip'>

/**
 * Single-writer hash chain. All API replicas funnel through this instance, so
 * `prevHash` never forks (design.md §13.2).
 */
export type AuditHealth =
  | { ok: true }
  | { ok: false; reason: 'write_failed' | 'chain_broken'; detail: string }

export type AuditQuery = {
  actor?: string
  eventType?: string
  /** Explicit set wins over `eventType`; `eventFamily` is resolved to this by the API. */
  eventTypes?: readonly string[]
  result?: string
  /** Correlates the event with the request/log line that produced it (AC-13). */
  traceId?: string
  since?: number
  until?: number
  /** Case-insensitive substring over metadata.fileName and metadata.path. */
  fileName?: string
  /** Case-insensitive literal over the whitelisted searchable fields (no regex). */
  keyword?: string
  /** Case-insensitive exact match on actor or metadata.subject, `user:` prefix stripped. */
  username?: string
  projectId?: string
  hostId?: string
  limit: number
  cursor?: number
}

export type AuditQueryResult = { events: AuditEvent[]; nextCursor: number | null }

/** Capacity envelope from the U66 phase-one scope (tech design §4.4). */
export const ENVELOPE_DAILY_FILE_EVENTS = 5_000
export const ENVELOPE_TOTAL_EVENTS = 1_000_000

export type AuditSummary = {
  chain: { ok: boolean; lastSeq: number }
  gaps: {
    hostsWithGap: number
    droppedTotal: number
    suppressedTotal: number
    rateLimitedTotal: number
    lastGapAt: number | null
  }
  capacity: {
    fileEventsToday: number
    fileEventsTotal: number
    dailyEnvelope: number
    totalEnvelope: number
    overDailyEnvelope: boolean
    overTotalEnvelope: boolean
  }
}

const FILE_EVENT_TYPES = new Set(['file_download', 'file_copy', 'download_blocked'])
const DAY_MS = 24 * 60 * 60_000

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function stripUserPrefix(value: string): string {
  return /^user:/i.test(value) ? value.slice(5) : value
}

function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function usernameMatches(event: AuditEvent, needle: string): boolean {
  const metadata = event.metadata ?? {}
  return (
    stripUserPrefix(str(event.actor)).toLowerCase() === needle ||
    stripUserPrefix(str(metadata.subject)).toLowerCase() === needle
  )
}

/** Precomputed at query time, so the scan does not lowercase the needle per event. */
function fileNameMatches(event: AuditEvent, needle: string): boolean {
  const metadata = event.metadata ?? {}
  return (
    str(metadata.fileName).toLowerCase().includes(needle) ||
    str(metadata.path).toLowerCase().includes(needle)
  )
}

export class AuditChain {
  private readonly store: AuditStore
  /** Optional durable sink; a failed write throws so callers cannot pretend it landed. */
  private readonly persist: ((event: AuditEvent) => void) | null
  private health: AuditHealth = { ok: true }
  /** Built on first keyword query; WeakMap lets dropped events be collected. */
  private readonly searchCache = new WeakMap<AuditEvent, string>()

  /** `now` keeps `ts` on the platform's clock, which is what time-window queries compare. */
  constructor(
    store: AuditStore,
    persist?: (event: AuditEvent) => void,
    now: () => number = () => Date.now()
  ) {
    this.store = store
    this.persist = persist ?? null
    this.now = now
  }

  private readonly now: () => number

  /** Restores a persisted chain before any new event is appended. */
  restore(events: AuditEvent[]): void {
    this.store.audit = [...events]
    this.store.auditSeq = events.at(-1)?.seq ?? 0
    this.store.auditTip = events.at(-1)?.hash ?? 'GENESIS'
    // A chain that is already broken must not silently accept new events on top:
    // the tampering would be laundered into an otherwise valid-looking tail.
    const verdict = this.verify()
    if (!verdict.ok) {
      this.markUnhealthy('chain_broken', `broken at seq ${verdict.brokenAtSeq}`)
    }
  }

  /**
   * Whether audit writes may be relied on. Sensitive mutations gate on this so a
   * full disk or a tampered log stops grants from being minted unrecorded.
   */
  getHealth(): AuditHealth {
    return this.health
  }

  private markUnhealthy(reason: 'write_failed' | 'chain_broken', detail: string): void {
    if (!this.health.ok) {
      return
    }
    this.health = { ok: false, reason, detail }
  }

  /** For informational events: the caller keeps serving, but the platform is now unhealthy. */
  appendBestEffort(input: AuditEventInput): boolean {
    try {
      this.append(input)
      return true
    } catch {
      return false
    }
  }

  append(input: AuditEventInput): AuditEvent {
    const seq = this.store.auditSeq + 1
    const ts = this.now()
    const prevHash = this.store.auditTip
    const body = {
      seq,
      ts,
      eventType: input.eventType,
      actor: input.actor,
      targetType: input.targetType,
      targetId: input.targetId,
      result: input.result,
      traceId: input.traceId,
      metadata: input.metadata ?? {}
    }
    const hash = createHash('sha256').update(`${prevHash}|${canonicalJson(body)}`).digest('hex')
    const event: AuditEvent = { ...input, seq, ts, prevHash, hash }
    this.store.audit.push(event)
    this.store.auditSeq = seq
    this.store.auditTip = hash
    try {
      this.persist?.(event)
      // A successful write clears a transient write failure; a broken chain stays
      // latched until the log is repaired and the process restarts.
      if (!this.health.ok && this.health.reason === 'write_failed') {
        this.health = { ok: true }
      }
    } catch (error) {
      // Recorded in memory but not durable: treat the log as unreliable so the next
      // sensitive mutation is refused instead of silently going unrecorded.
      this.markUnhealthy('write_failed', error instanceof Error ? error.message : String(error))
      throw error
    }
    return event
  }

  get size(): number {
    return this.store.audit.length
  }

  get tip(): string {
    return this.store.auditTip
  }

  /**
   * Recomputes the chain from GENESIS. `checked` is how many events were verified,
   * so an empty log reports 0 rather than a vacuous "ok" that looks like coverage.
   */
  verify(): { ok: true; checked: number; tip: string } | { ok: false; brokenAtSeq: number; checked: number } {
    let prev = 'GENESIS'
    let checked = 0
    for (const event of this.store.audit) {
      const body = {
        seq: event.seq,
        ts: event.ts,
        eventType: event.eventType,
        actor: event.actor,
        targetType: event.targetType,
        targetId: event.targetId,
        result: event.result,
        traceId: event.traceId,
        metadata: event.metadata ?? {}
      }
      const expected = createHash('sha256').update(`${prev}|${canonicalJson(body)}`).digest('hex')
      if (event.prevHash !== prev || event.hash !== expected) {
        this.markUnhealthy('chain_broken', `broken at seq ${event.seq}`)
        return { ok: false, brokenAtSeq: event.seq, checked }
      }
      prev = event.hash
      checked += 1
    }
    return { ok: true, checked, tip: prev }
  }

  query(filter: AuditQuery): AuditQueryResult {
    const events = this.store.audit
    const types =
      filter.eventTypes && filter.eventTypes.length > 0 ? new Set(filter.eventTypes) : null
    const keywordLower = filter.keyword?.toLowerCase()
    const fileNameLower = filter.fileName?.toLowerCase()
    const usernameLower = filter.username?.toLowerCase()
    // Why reverse: a page is the newest matches, so the scan can stop at `limit`
    // instead of filtering the whole chain and slicing its tail (tech design §4.4).
    const out: AuditEvent[] = []
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (!event) continue
      if (filter.cursor && event.seq >= filter.cursor) continue
      if (filter.since && event.ts < filter.since) continue
      if (filter.until !== undefined && event.ts > filter.until) continue
      if (types ? !types.has(event.eventType) : filter.eventType && event.eventType !== filter.eventType) {
        continue
      }
      if (filter.actor && event.actor !== filter.actor) continue
      if (filter.result && event.result !== filter.result) continue
      if (filter.traceId && event.traceId !== filter.traceId) continue
      if (filter.projectId && event.targetId !== filter.projectId) continue
      const metadata = event.metadata ?? {}
      if (filter.hostId && metadata.hostId !== filter.hostId) continue
      if (usernameLower && !usernameMatches(event, usernameLower)) continue
      if (fileNameLower && !fileNameMatches(event, fileNameLower)) continue
      if (keywordLower && !this.searchable(event).includes(keywordLower)) continue
      out.push(event)
      if (out.length === filter.limit) break
    }
    const oldest = out.at(-1)
    return { events: out, nextCursor: out.length === filter.limit && oldest ? oldest.seq : null }
  }

  /**
   * Lowercased whitelist join, cached per event: q must never match event display
   * names, branch/reason, or other metadata (tech design §4.1/§4.4). Excerpt is
   * absent until the phase-two switch exists. U78 adds eventType and targetId —
   * targetId is where endpoint paths like /install/host.sh land.
   */
  private searchable(event: AuditEvent): string {
    const cached = this.searchCache.get(event)
    if (cached !== undefined) return cached
    const metadata = event.metadata ?? {}
    const parts = [
      event.eventType,
      event.targetId,
      str(metadata.fileName),
      str(metadata.path),
      str(event.actor),
      str(metadata.subject),
      str(metadata.projectKey)
    ]
    const text = parts.filter((part) => part !== '').join('\n').toLowerCase()
    this.searchCache.set(event, text)
    return text
  }

  /** Chain health plus the two gap/capacity summaries the status endpoint reports. */
  summary(): AuditSummary {
    const now = this.now()
    const dayStart = now - (now % DAY_MS)
    let fileEventsToday = 0
    let fileEventsTotal = 0
    let droppedTotal = 0
    let suppressedTotal = 0
    let rateLimitedTotal = 0
    let lastGapAt: number | null = null
    const hostsWithGap = new Set<string>()
    for (const event of this.store.audit) {
      if (FILE_EVENT_TYPES.has(event.eventType)) {
        fileEventsTotal += 1
        if (event.ts >= dayStart) fileEventsToday += 1
      }
      if (event.eventType !== 'host.audit_gap') continue
      const metadata = event.metadata ?? {}
      const dropped = countOf(metadata.dropped)
      const suppressed = countOf(metadata.suppressed)
      const rateLimited = countOf(metadata.rateLimited)
      if (dropped === 0 && suppressed === 0 && rateLimited === 0) continue
      droppedTotal += dropped
      suppressedTotal += suppressed
      rateLimitedTotal += rateLimited
      const hostId = str(metadata.hostId)
      if (hostId !== '') hostsWithGap.add(hostId)
      if (lastGapAt === null || event.ts > lastGapAt) lastGapAt = event.ts
    }
    return {
      chain: { ok: this.health.ok, lastSeq: this.store.auditSeq },
      gaps: {
        hostsWithGap: hostsWithGap.size,
        droppedTotal,
        suppressedTotal,
        rateLimitedTotal,
        lastGapAt
      },
      capacity: {
        fileEventsToday,
        fileEventsTotal,
        dailyEnvelope: ENVELOPE_DAILY_FILE_EVENTS,
        totalEnvelope: ENVELOPE_TOTAL_EVENTS,
        overDailyEnvelope: fileEventsToday > ENVELOPE_DAILY_FILE_EVENTS,
        overTotalEnvelope: fileEventsTotal > ENVELOPE_TOTAL_EVENTS
      }
    }
  }
}
