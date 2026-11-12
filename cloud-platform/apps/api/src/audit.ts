import { createHash } from 'node:crypto'
import { canonicalJson } from '../../../packages/contract/src/credential.ts'
import type { AuditEvent, AuditEventInput, Store } from './store.ts'

/**
 * Single-writer hash chain. All API replicas funnel through this instance, so
 * `prevHash` never forks (design.md §13.2).
 */
export class AuditChain {
  private readonly store: Store

  constructor(store: Store) {
    this.store = store
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
    return event
  }

  verify(): { ok: true } | { ok: false; brokenAtSeq: number } {
    let prev = 'GENESIS'
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
        return { ok: false, brokenAtSeq: event.seq }
      }
      prev = event.hash
    }
    return { ok: true }
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
