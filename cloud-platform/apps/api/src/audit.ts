import { createHash } from 'node:crypto'
import { canonicalJson } from '../../../packages/contract/src/credential.ts'
import type { AuditEvent, AuditEventInput, Store } from './store.ts'

/**
 * Single-writer hash chain. All API replicas funnel through this instance, so
 * `prevHash` never forks (design.md §13.2).
 */
export type AuditHealth =
  | { ok: true }
  | { ok: false; reason: 'write_failed' | 'chain_broken'; detail: string }

export class AuditChain {
  private readonly store: Store
  /** Optional durable sink; a failed write throws so callers cannot pretend it landed. */
  private readonly persist: ((event: AuditEvent) => void) | null
  private health: AuditHealth = { ok: true }

  constructor(store: Store, persist?: (event: AuditEvent) => void) {
    this.store = store
    this.persist = persist ?? null
  }

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
    const ts = Date.now()
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

  query(filter: {
    actor?: string
    eventType?: string
    result?: string
    since?: number
    limit: number
    cursor?: number
  }): { events: AuditEvent[]; nextCursor: number | null } {
    const filtered = this.store.audit.filter((e) => {
      if (filter.actor && e.actor !== filter.actor) return false
      if (filter.eventType && e.eventType !== filter.eventType) return false
      if (filter.result && e.result !== filter.result) return false
      if (filter.since && e.ts < filter.since) return false
      if (filter.cursor && e.seq >= filter.cursor) return false
      return true
    })
    const page = filtered.slice(-filter.limit).reverse()
    const oldest = page.at(-1)
    return { events: page, nextCursor: page.length === filter.limit && oldest ? oldest.seq : null }
  }
}
