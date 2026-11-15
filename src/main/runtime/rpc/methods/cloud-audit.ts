import { z } from 'zod'
import { defineMethod, InvalidArgumentError } from '../core'
import type { RpcContext } from '../core'

/**
 * U66 §2.10 `audit.recordFileEvent` (R-01): the client-declared file-event
 * channel. The handler mirrors the platform's §2.5 field whitelist so bad data
 * is refused on the host instead of travelling to the platform's own validation
 * (host-audit-ingest.ts re-checks — the platform stays authoritative), then
 * hands the report to the host intake, which owns rate limiting, dedupe, the
 * savedName merge and the queue.
 *
 * Non-cloud sessions answer `{queued:false, reason:'non-cloud-session'}` (§2.10.2):
 * SSH and local projects produce no file events.
 */

const EVENT_TYPES = ['file_download', 'file_copy', 'download_blocked'] as const
const RESULTS = ['success', 'failure', 'denied'] as const

const FILE_EVENT_PARAMS = z
  .object({
    eventType: z.enum(EVENT_TYPES),
    result: z.enum(RESULTS),
    traceId: z.string().max(128).optional(),
    metadata: z.record(z.string(), z.unknown()).optional()
  })
  .strict()

/** String metadata fields and their §2.5 caps. */
const TEXT_FIELDS: Readonly<Record<string, number>> = {
  hostId: 128,
  hostName: 128,
  projectKey: 128,
  method: 128,
  kind: 128,
  surface: 128,
  capturePoint: 128,
  captureConfidence: 128,
  copyKind: 128,
  policy: 128,
  reason: 128,
  mime: 128,
  clientVersion: 64,
  fileName: 255,
  savedName: 255,
  path: 1024
}
const INT_FIELDS = new Set(['sizeBytes', 'copiedChars', 'copiedBytes', 'itemCount', 'occurredAt'])
const BOOL_FIELDS = new Set(['isBinary', 'truncated'])
/** §2.5 field dictionary: the fingerprint provenance enum (U69). */
const SHA256_SOURCES = new Set(['client', 'host'])
/** A client cannot claim the host wrote its attribution or confidence (§2.5). */
const FORBIDDEN_FIELDS = new Set(['actorSource', 'subject', 'deviceId'])

/** Project-relative, forward-slash, no `..`; mirrors the platform's path rule (OQ-8). */
function safeEventPath(value: string): string | null {
  const normalized = value.replaceAll('\\', '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    return null
  }
  if (normalized.split('/').includes('..')) {
    return null
  }
  return normalized.slice(0, 1024)
}

/** Returns the cleaned metadata, or the name of the first rejected field. */
export function validateFileEventMetadata(
  input: Record<string, unknown>
): { ok: true; metadata: Record<string, unknown> } | { ok: false; field: string; reason: string } {
  const metadata: Record<string, unknown> = {}
  let declaredSha256Source: string | undefined
  for (const [key, value] of Object.entries(input)) {
    if (FORBIDDEN_FIELDS.has(key)) {
      return { ok: false, field: key, reason: 'platform-written' }
    }
    if (key === 'excerpt' || key === 'excerptBytes' || key === 'excerptTruncated') {
      // §2.6: the host is authoritative and strips excerpts before the queue.
      continue
    }
    if (TEXT_FIELDS[key] !== undefined) {
      if (typeof value !== 'string' || value.length === 0) {
        return { ok: false, field: key, reason: 'not-a-string' }
      }
      if (key === 'path') {
        const path = safeEventPath(value)
        if (path === null) {
          return { ok: false, field: key, reason: 'absolute-or-parent-traversal' }
        }
        metadata.path = path
        continue
      }
      if ((key === 'fileName' || key === 'savedName') && /[\\/]/.test(value)) {
        return { ok: false, field: key, reason: 'must-be-basename' }
      }
      metadata[key] = value.slice(0, TEXT_FIELDS[key])
      continue
    }
    if (INT_FIELDS.has(key)) {
      if (
        typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value < 0 ||
        value > Number.MAX_SAFE_INTEGER
      ) {
        return { ok: false, field: key, reason: 'not-a-non-negative-integer' }
      }
      metadata[key] = value
      continue
    }
    if (BOOL_FIELDS.has(key)) {
      if (typeof value !== 'boolean') {
        return { ok: false, field: key, reason: 'not-a-boolean' }
      }
      metadata[key] = value
      continue
    }
    if (key === 'sha256Source') {
      // U69: the provenance tag production reporters send with sha256; outside
      // the dictionary enum the event is refused, not silently fixed.
      if (typeof value !== 'string' || !SHA256_SOURCES.has(value)) {
        return { ok: false, field: key, reason: 'not-allowed' }
      }
      declaredSha256Source = value
      continue
    }
    if (key === 'sha256') {
      // Invalid fingerprints are dropped, not fatal (§2.5).
      if (typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)) {
        metadata.sha256 = value
        metadata.sha256Source = declaredSha256Source ?? 'client'
      }
      continue
    }
    return { ok: false, field: key, reason: 'unknown' }
  }
  // The reporter may declare the source before or after the fingerprint.
  if (metadata.sha256 !== undefined && declaredSha256Source !== undefined) {
    metadata.sha256Source = declaredSha256Source
  }
  return { ok: true, metadata }
}

export const CLOUD_AUDIT_METHODS = [
  defineMethod({
    name: 'audit.recordFileEvent',
    permission: 'workspace',
    params: FILE_EVENT_PARAMS,
    handler: (params, ctx: RpcContext) => {
      if (params.eventType === 'download_blocked' && params.result !== 'denied') {
        throw new InvalidArgumentError('download_blocked requires result denied')
      }
      if (!ctx.cloud || !ctx.cloudFileEvent) {
        return { queued: false, reason: 'non-cloud-session' as const }
      }
      let metadata: Record<string, unknown> = {}
      let excerptDropped = false
      if (params.metadata !== undefined) {
        const verdict = validateFileEventMetadata(params.metadata)
        if (!verdict.ok) {
          throw new InvalidArgumentError(
            `Invalid file event metadata: ${verdict.field} (${verdict.reason})`
          )
        }
        metadata = verdict.metadata
        excerptDropped =
          params.metadata.excerpt !== undefined ||
          params.metadata.excerptBytes !== undefined ||
          params.metadata.excerptTruncated !== undefined
      }
      const reply = ctx.cloudFileEvent({
        eventType: params.eventType,
        result: params.result,
        traceId: params.traceId,
        metadata
      })
      return excerptDropped && reply.queued ? { ...reply, excerptDropped: true } : reply
    }
  })
]
