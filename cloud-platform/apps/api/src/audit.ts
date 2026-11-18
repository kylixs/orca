import { createHash } from 'node:crypto'
import { canonicalJson } from '../../../packages/contract/src/credential.ts'
import { MAX_PROJECT_KEY_LENGTH } from '../../../packages/contract/src/project-key.ts'
import { PROJECT_PATH_MAX_CHARS } from './project-self-service.ts'
import type { AuditEvent, AuditEventInput } from './store.ts'

/** The chain needs only the tail plus the log it appends to, not the whole store. */
export type AuditStore = Pick<import('./store.ts').Store, 'audit' | 'auditSeq' | 'auditTip'>

/**
 * Single-writer hash chain. All API replicas funnel through this instance, so
 * `prevHash` never forks (design.md §13.2).
 */
export type AuditFailureReason = 'write_failed' | 'chain_broken'

export type AuditHealth =
  | { ok: true }
  | {
      ok: false
      reason: AuditFailureReason
      detail: string
      /** First reason observed; kept when a later failure escalates the verdict. */
      firstFailure?: AuditFailureReason
      /** Most recent reason, even when `reason` keeps the more severe one. */
      lastFailure?: AuditFailureReason
    }

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

/**
 * U257: every event the API hands to the writer stays under this budget, which
 * leaves 4 KiB below the writer's independent 16 KiB backstop. Measuring the
 * serialized bytes (not `.length`) is what bounds control-character inflation:
 * one `\u0000` is 1 UTF-16 unit but 6 JSON bytes.
 */
export const AUDIT_EVENT_MAX_BYTES = 12 * 1024
export const AUDIT_METADATA_MAX_BYTES = 8 * 1024
/** Shared by host maintenance and admin force-offline notes. */
export const AUDIT_REASON_MAX_CHARS = 200

const AUDIT_FIELD_MAX_CHARS = 1024
const AUDIT_ARRAY_MAX_ITEMS = 50
const AUDIT_DEPTH_MAX = 4
const AUDIT_KEYS_MAX = 64
const AUDIT_KEY_NAME_MAX_CHARS = 128
const AUDIT_DROPPED_FIELDS_MAX = 16
const AUDIT_STRING_MIN_CHARS = 64
const AUDIT_TOP_LEVEL_MAX = {
  eventType: 128,
  actor: 256,
  targetType: 64,
  targetId: 256,
  traceId: 128
} as const

/** Per-field caps; unknown keys fall back to `AUDIT_FIELD_MAX_CHARS`. */
const AUDIT_FIELD_LIMITS: Record<string, number> = {
  path: PROJECT_PATH_MAX_CHARS,
  key: MAX_PROJECT_KEY_LENGTH,
  reason: AUDIT_REASON_MAX_CHARS,
  name: 200,
  hostName: 128,
  offered: 64,
  clientVersion: 64,
  min: 64,
  version: 64,
  fingerprint: 128,
  previousFingerprint: 128,
  codeFingerprint: 128,
  code: 128,
  fileName: 255,
  savedName: 255,
  username: 128,
  subject: 128,
  error: 500
}

export type AuditSizeStats = {
  truncated: boolean
  /** Serialized size before bounding, so the marker explains the loss. */
  originalBytes: number
  droppedFields: string[]
  droppedItems: number
}

export type BoundedAuditInput = { input: AuditEventInput } & AuditSizeStats

type SanitizeStats = { fields: Set<string>; droppedItems: number; truncated: boolean }
type StringRef =
  | { holder: unknown[]; index: number; length: number; field: string | null }
  | { holder: Record<string, unknown>; key: string; length: number; field: string | null }

function noteField(stats: SanitizeStats, name: string): void {
  stats.fields.add(name.length > 64 ? name.slice(0, 64) : name)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isForbiddenKey(key: string): boolean {
  return key === '__proto__' || key === 'prototype' || key === 'constructor'
}

function jsonBytes(value: unknown): number {
  const serialized = JSON.stringify(value)
  return serialized === undefined ? 0 : Buffer.byteLength(serialized)
}

/** Caps are codepoint counts; `.length` is UTF-16 units, so one astral char would count twice. */
function countCodePoints(value: string): number {
  let count = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const low = value.charCodeAt(index + 1)
      if (low >= 0xdc00 && low <= 0xdfff) index += 1
    }
    count += 1
  }
  return count
}

/** Shrink rounds rescan the same strings; cache counts so the walk stays linear. */
const charLengthCache = new Map<string, number>()
const CHAR_LENGTH_CACHE_MAX_ENTRIES = 256
const CHAR_LENGTH_CACHE_MAX_UNITS = 4096

function charLength(value: string): number {
  const cached = charLengthCache.get(value)
  if (cached !== undefined) return cached
  const length = countCodePoints(value)
  if (value.length <= CHAR_LENGTH_CACHE_MAX_UNITS) {
    if (charLengthCache.size >= CHAR_LENGTH_CACHE_MAX_ENTRIES) charLengthCache.clear()
    charLengthCache.set(value, length)
  }
  return length
}

/** Codepoint-safe so a truncation never splits a surrogate pair. */
function truncateChars(value: string, limit: number): string {
  return Array.from(value).slice(0, limit).join('')
}

function fieldLimit(key: string): number {
  return AUDIT_FIELD_LIMITS[key] ?? AUDIT_FIELD_MAX_CHARS
}

function clipTopLevel(input: AuditEventInput): { top: AuditEventInput; clipped: string[] } {
  const clipped: string[] = []
  const text = (value: unknown, field: keyof typeof AUDIT_TOP_LEVEL_MAX): string => {
    const raw = typeof value === 'string' ? value : ''
    const limit = AUDIT_TOP_LEVEL_MAX[field]
    if (charLength(raw) > limit) {
      clipped.push(field)
      return truncateChars(raw, limit)
    }
    return raw
  }
  const nullable = (value: unknown, field: keyof typeof AUDIT_TOP_LEVEL_MAX): string | null =>
    value === null || typeof value !== 'string' ? null : text(value, field)
  const top: AuditEventInput = {
    eventType: text(input.eventType, 'eventType'),
    actor: nullable(input.actor, 'actor'),
    targetType: nullable(input.targetType, 'targetType'),
    targetId: nullable(input.targetId, 'targetId'),
    result: input.result,
    traceId: nullable(input.traceId, 'traceId')
  }
  if (input.metadata !== undefined) top.metadata = input.metadata
  return { top, clipped }
}

function sanitizeValue(
  value: unknown,
  depth: number,
  key: string | null,
  stats: SanitizeStats
): unknown {
  if (typeof value === 'string') {
    const limit = key === null ? AUDIT_FIELD_MAX_CHARS : fieldLimit(key)
    if (charLength(value) > limit) {
      stats.truncated = true
      if (key !== null) noteField(stats, key)
      return truncateChars(value, limit)
    }
    return value
  }
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  // BigInt cannot be JSON-serialized; let the caller fall back to a skeleton.
  if (typeof value === 'bigint') return value
  if (typeof value !== 'object') return undefined
  if (depth >= AUDIT_DEPTH_MAX) {
    stats.truncated = true
    if (key !== null) noteField(stats, key)
    return '[truncated]'
  }
  if (Array.isArray(value)) {
    const kept = value.slice(0, AUDIT_ARRAY_MAX_ITEMS)
    if (value.length > kept.length) {
      stats.truncated = true
      stats.droppedItems += value.length - kept.length
    }
    const output: unknown[] = []
    // Indexing, not `.map`: holes must become null too. JSON.stringify already
    // writes a hole as null, but canonicalJson emits `[1,,3]`, so a restart would
    // recompute a different hash and call the untouched chain broken.
    for (let index = 0; index < kept.length; index += 1) {
      const sanitized = sanitizeValue(kept[index], depth + 1, null, stats)
      output.push(sanitized === undefined ? null : sanitized)
    }
    return output
  }
  const output: Record<string, unknown> = {}
  let count = 0
  // SAFETY: `value` is a non-null non-array object; Object.entries reads own keys.
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
    if (isForbiddenKey(childKey)) continue
    if (childKey.length > AUDIT_KEY_NAME_MAX_CHARS || count >= AUDIT_KEYS_MAX) {
      stats.truncated = true
      noteField(stats, childKey)
      continue
    }
    const sanitized = sanitizeValue(childValue, depth + 1, childKey, stats)
    if (sanitized === undefined) continue
    output[childKey] = sanitized
    count += 1
  }
  return output
}

function buildAuditSize(stats: SanitizeStats, originalBytes: number): Record<string, unknown> {
  const mark: Record<string, unknown> = { truncated: true, originalBytes }
  if (stats.fields.size > 0) {
    mark.droppedFields = [...stats.fields].slice(0, AUDIT_DROPPED_FIELDS_MAX)
  }
  if (stats.droppedItems > 0) mark.droppedItems = stats.droppedItems
  return mark
}

function withAuditSize(
  metadata: Record<string, unknown>,
  stats: SanitizeStats,
  originalBytes: number
): Record<string, unknown> {
  return { ...metadata, auditSize: buildAuditSize(stats, originalBytes) }
}

function findLongestString(
  value: unknown,
  field: string | null,
  depth: number,
  holder: Record<string, unknown> | unknown[] | null,
  key: string | number | null,
  best: { ref: StringRef | null }
): void {
  if (typeof value === 'string') {
    const length = charLength(value)
    if (
      length > AUDIT_STRING_MIN_CHARS &&
      holder !== null &&
      key !== null &&
      (best.ref === null || length > best.ref.length)
    ) {
      if (Array.isArray(holder) && typeof key === 'number') {
        best.ref = { holder, index: key, length, field }
      } else if (!Array.isArray(holder) && typeof key === 'string') {
        best.ref = { holder, key, length, field }
      }
    }
    return
  }
  if (depth >= AUDIT_DEPTH_MAX || value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((item, index) => findLongestString(item, field, depth + 1, value, index, best))
    return
  }
  // SAFETY: `value` is a non-null non-array object; Object.entries reads own keys.
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
    findLongestString(childValue, field ?? childKey, depth + 1, value, childKey, best)
  }
}

/** Halves the longest remaining string; returns false when none is shrinkable. */
function shrinkLongestString(metadata: Record<string, unknown>, stats: SanitizeStats): boolean {
  const best: { ref: StringRef | null } = { ref: null }
  findLongestString(metadata, null, 0, null, null, best)
  const ref = best.ref
  if (ref === null) return false
  const current = Array.isArray(ref.holder) ? ref.holder[ref.index] : ref.holder[ref.key]
  if (typeof current !== 'string') return false
  const target = Math.max(AUDIT_STRING_MIN_CHARS, Math.floor(ref.length / 2))
  if (target >= ref.length) return false
  const shrunk = truncateChars(current, target)
  if (Array.isArray(ref.holder)) ref.holder[ref.index] = shrunk
  else ref.holder[ref.key] = shrunk
  stats.truncated = true
  if (ref.field !== null) noteField(stats, ref.field)
  return true
}

/** Drops explanatory fields first, then the largest; metadata always keeps a key. */
function dropLargestField(metadata: Record<string, unknown>, stats: SanitizeStats): boolean {
  const keys = Object.keys(metadata).filter((key) => key !== 'auditSize')
  if (keys.length === 0) return false
  const lowPriority = new Set(['limits', 'sampleKeys', 'excerpt', 'items', 'entries'])
  keys.sort((a, b) => {
    // Low-priority (drop first) sorts ahead of high-priority.
    const priority = Number(lowPriority.has(b)) - Number(lowPriority.has(a))
    return priority !== 0 ? priority : jsonBytes(metadata[b]) - jsonBytes(metadata[a])
  })
  const victim = keys[0]
  if (victim === undefined) return false
  delete metadata[victim]
  stats.truncated = true
  noteField(stats, victim)
  return true
}

function boundMetadataBytes(
  metadata: Record<string, unknown>,
  stats: SanitizeStats,
  originalBytes: number
): Record<string, unknown> {
  for (let round = 0; round < 8; round += 1) {
    const candidate = withAuditSize(metadata, stats, originalBytes)
    if (jsonBytes(candidate) <= AUDIT_METADATA_MAX_BYTES) return candidate
    if (shrinkLongestString(metadata, stats)) continue
    if (dropLargestField(metadata, stats)) continue
    return { auditSize: buildAuditSize(stats, originalBytes) }
  }
  const candidate = withAuditSize(metadata, stats, originalBytes)
  return jsonBytes(candidate) <= AUDIT_METADATA_MAX_BYTES
    ? candidate
    : { auditSize: buildAuditSize(stats, originalBytes) }
}

function shrinkTopLevel(input: AuditEventInput): AuditEventInput {
  const shrinkText = (value: string): string => {
    const length = charLength(value)
    return length > AUDIT_STRING_MIN_CHARS
      ? truncateChars(value, Math.max(AUDIT_STRING_MIN_CHARS, Math.floor(length / 2)))
      : value
  }
  const shrinkNullable = (value: string | null): string | null =>
    value === null ? null : shrinkText(value)
  let next: AuditEventInput = { ...input }
  for (let round = 0; round < 8; round += 1) {
    if (jsonBytes(next) <= AUDIT_EVENT_MAX_BYTES) return next
    next = {
      ...next,
      eventType: shrinkText(next.eventType),
      actor: shrinkNullable(next.actor),
      targetType: shrinkNullable(next.targetType),
      targetId: shrinkNullable(next.targetId),
      traceId: shrinkNullable(next.traceId)
    }
  }
  return next
}

/**
 * The normalized metadata must be JSON-stable: the log stores `JSON.stringify`
 * and restart verification recomputes with canonicalJson.
 */
function assertJsonRoundTrip(metadata: Record<string, unknown>): void {
  const serialized = JSON.stringify(metadata)
  if (serialized === undefined) throw new Error('audit metadata is not serializable')
  const roundTripped: unknown = JSON.parse(serialized)
  if (canonicalJson(metadata) !== canonicalJson(roundTripped)) {
    throw new Error('audit metadata does not survive a JSON roundtrip')
  }
}

/**
 * U257: the one place an audit event is bounded before it is hashed, stored, or
 * sent to the writer. Normal input is returned byte-for-byte unchanged (no
 * marker); overflow is reduced by serialized bytes, never by character count.
 */
export function boundedAuditMetadata(input: AuditEventInput): BoundedAuditInput {
  let originalBytes = 0
  try {
    originalBytes = jsonBytes(input)
  } catch {
    originalBytes = 0
  }
  try {
    const { top, clipped } = clipTopLevel(input)
    const rawMetadata: unknown = input.metadata ?? {}
    const marked =
      isRecord(rawMetadata) &&
      isRecord(rawMetadata.auditSize) &&
      rawMetadata.auditSize.truncated === true
    if (marked && jsonBytes(top) <= AUDIT_EVENT_MAX_BYTES) {
      // Idempotent: this is our own output, already inside both budgets.
      return { input: top, truncated: true, originalBytes, droppedFields: [], droppedItems: 0 }
    }
    const stats: SanitizeStats = {
      fields: new Set(clipped),
      droppedItems: 0,
      truncated: clipped.length > 0
    }
    const sanitized = sanitizeValue(rawMetadata, 0, null, stats)
    const metadata = isRecord(sanitized) ? sanitized : {}
    // Reserved: a caller-supplied marker must never be trusted or survive.
    delete metadata.auditSize
    const hadMetadata = input.metadata !== undefined
    if (!stats.truncated && jsonBytes(metadata) <= AUDIT_METADATA_MAX_BYTES) {
      // The normal path must be JSON-stable too: sparse arrays and undefined are
      // where stringify-on-disk and canonicalJson-on-verify disagree.
      assertJsonRoundTrip(metadata)
      const bounded: AuditEventInput = hadMetadata ? { ...top, metadata } : top
      return { input: bounded, truncated: false, originalBytes, droppedFields: [], droppedItems: 0 }
    }
    let boundedMetadata = boundMetadataBytes(metadata, stats, originalBytes)
    let bounded: AuditEventInput = { ...top, metadata: boundedMetadata }
    if (jsonBytes(bounded) > AUDIT_EVENT_MAX_BYTES) {
      boundedMetadata = { auditSize: buildAuditSize(stats, originalBytes) }
      bounded = { ...top, metadata: boundedMetadata }
    }
    if (jsonBytes(bounded) > AUDIT_EVENT_MAX_BYTES) {
      bounded = { ...shrinkTopLevel({ ...top, metadata: boundedMetadata }) }
    }
    assertJsonRoundTrip(boundedMetadata)
    return {
      input: bounded,
      truncated: true,
      originalBytes,
      droppedFields: [...stats.fields].slice(0, AUDIT_DROPPED_FIELDS_MAX),
      droppedItems: stats.droppedItems
    }
  } catch {
    // BigInt/circular metadata must not wedge the request: keep the event
    // skeleton and let the operation proceed (or fail) on its own semantics.
    const { top } = clipTopLevel(input)
    return {
      input: {
        eventType: top.eventType,
        actor: top.actor,
        targetType: top.targetType,
        targetId: top.targetId,
        result: top.result,
        traceId: top.traceId,
        metadata: { auditSize: { truncated: true, originalBytes, reason: 'unserializable' } }
      },
      truncated: true,
      originalBytes,
      droppedFields: [],
      droppedItems: 0
    }
  }
}

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

  private markUnhealthy(reason: AuditFailureReason, detail: string): void {
    const current = this.health
    if (current.ok) {
      this.health = { ok: false, reason, detail, firstFailure: reason, lastFailure: reason }
      return
    }
    // `chain_broken` is strictly more severe than a retryable write failure and
    // must replace it; the reverse must never hide a real break.
    if (reason === 'chain_broken' && current.reason === 'write_failed') {
      this.health = {
        ok: false,
        reason,
        detail,
        firstFailure: current.firstFailure ?? current.reason,
        lastFailure: reason
      }
      return
    }
    this.health = { ...current, lastFailure: reason }
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

  append(rawInput: AuditEventInput): AuditEvent {
    const input = boundedAuditMetadata(rawInput).input
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
    const hash = createHash('sha256')
      .update(`${prevHash}|${canonicalJson(body)}`)
      .digest('hex')
    const event: AuditEvent = { ...input, seq, ts, prevHash, hash }
    try {
      this.persist?.(event)
    } catch (error) {
      // Commit memory only after the log: a phantom tail event would be counted by
      // verify/query and become the next event's predecessor, breaking the log on restart.
      this.markUnhealthy('write_failed', error instanceof Error ? error.message : String(error))
      throw error
    }
    this.store.audit.push(event)
    this.store.auditSeq = seq
    this.store.auditTip = hash
    // A successful write clears a transient write failure; a broken chain stays
    // latched until the log is repaired and the process restarts.
    if (!this.health.ok && this.health.reason === 'write_failed') {
      this.health = { ok: true }
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
  verify():
    | { ok: true; checked: number; tip: string }
    | { ok: false; brokenAtSeq: number; checked: number } {
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
      const expected = createHash('sha256')
        .update(`${prev}|${canonicalJson(body)}`)
        .digest('hex')
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
      if (
        types
          ? !types.has(event.eventType)
          : filter.eventType && event.eventType !== filter.eventType
      ) {
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
    const text = parts
      .filter((part) => part !== '')
      .join('\n')
      .toLowerCase()
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
