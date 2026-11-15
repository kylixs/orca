import type { AuditChain } from './audit.ts'

/**
 * A host's own refusals, delivered on its heartbeat (design §5.1). The host is
 * the only thing that can see a pre-handshake rejection, so without this the
 * platform audit chain records nothing about forged or stolen tickets.
 *
 * U66 file events (`file_download`/`file_copy`/`download_blocked`) ride the same
 * channel (§2.10): they land under their bare event names (no `host.` prefix,
 * §2.8) with user attribution via the subject tier — the host reports
 * `user:<username>` from the ticket, and an optional resolver upgrades that to
 * the device tier when the caller wires one in.
 *
 * Everything here is best effort: one malformed report or a broken audit chain
 * must not fail the heartbeat the host depends on for revocation and policy.
 */

const MAX_REPORTS_PER_BEAT = 100
const MAX_TEXT_LENGTH = 512
const MAX_METADATA_BYTES = 4096

export type HostAuditReport = {
  eventType:
    | 'connection_rejected'
    | 'path_denied'
    | 'method_denied'
    | 'file_download'
    | 'file_copy'
    | 'download_blocked'
  result: 'success' | 'failure' | 'denied'
  deviceId?: string
  subject?: string
  projectId?: string
  method?: string
  denial?: string
  reason?: string
  traceId?: string
  metadata?: Record<string, unknown>
}

const FILE_EVENT_TYPES = new Set(['file_download', 'file_copy', 'download_blocked'])

/** §2.5 metadata whitelist: string fields and their caps. */
const FILE_METADATA_TEXT_FIELDS: Readonly<Record<string, number>> = {
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
const FILE_METADATA_INT_FIELDS = new Set([
  'sizeBytes',
  'copiedChars',
  'copiedBytes',
  'itemCount',
  'occurredAt'
])
const FILE_METADATA_BOOL_FIELDS = new Set(['isBinary', 'truncated', 'excerptTruncated'])
/** §2.5 field dictionary: the fingerprint provenance enum (U69). */
const SHA256_SOURCES = new Set(['client', 'host'])

function isEventType(value: string): value is HostAuditReport['eventType'] {
  return (
    value === 'connection_rejected' ||
    value === 'path_denied' ||
    value === 'method_denied' ||
    FILE_EVENT_TYPES.has(value)
  )
}

function isResult(value: string): value is HostAuditReport['result'] {
  return value === 'success' || value === 'failure' || value === 'denied'
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined
  }
  return value.slice(0, MAX_TEXT_LENGTH)
}

/** Relative, forward-slash project path; absolute paths and `..` are refused (OQ-8). */
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

/**
 * One file-event entry is all-or-nothing: a metadata object that carries an
 * unknown field or a bad value is dropped whole — a partially understood
 * client-declared report is not an audit record.
 */
function parseFileEventMetadata(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const metadata: Record<string, unknown> = {}
  let sha256Source: string | undefined
  for (const [key, raw] of Object.entries(value)) {
    // Excerpts stay off for the first release (AC-53): silently dropped.
    if (key === 'excerpt' || key === 'excerptBytes') {
      continue
    }
    if (FILE_METADATA_TEXT_FIELDS[key] !== undefined) {
      if (typeof raw !== 'string' || raw.length === 0) {
        return null
      }
      if (key === 'path') {
        const path = safeEventPath(raw)
        if (path === null) {
          return null
        }
        metadata.path = path
        continue
      }
      if ((key === 'fileName' || key === 'savedName') && /[\\/]/.test(raw)) {
        return null
      }
      metadata[key] = raw.slice(0, FILE_METADATA_TEXT_FIELDS[key])
      continue
    }
    if (FILE_METADATA_INT_FIELDS.has(key)) {
      if (
        typeof raw !== 'number' ||
        !Number.isInteger(raw) ||
        raw < 0 ||
        raw > Number.MAX_SAFE_INTEGER
      ) {
        return null
      }
      metadata[key] = raw
      continue
    }
    if (FILE_METADATA_BOOL_FIELDS.has(key)) {
      if (typeof raw !== 'boolean') {
        return null
      }
      metadata[key] = raw
      continue
    }
    if (key === 'sha256Source') {
      // U69: provenance from the host's reporter; outside the enum the entry
      // is dropped whole, like any other bad value.
      if (typeof raw !== 'string' || !SHA256_SOURCES.has(raw)) {
        return null
      }
      sha256Source = raw
      continue
    }
    if (key === 'sha256') {
      // Invalid fingerprints are dropped, not fatal (§2.5).
      if (typeof raw === 'string' && /^[0-9a-f]{64}$/.test(raw)) {
        metadata.sha256 = raw
      }
      continue
    }
    return null
  }
  // The source only co-occurs with a fingerprint that survived (§2.5).
  if (metadata.sha256 !== undefined && sha256Source !== undefined) {
    metadata.sha256Source = sha256Source
  }
  if (Buffer.byteLength(JSON.stringify(metadata)) > MAX_METADATA_BYTES) {
    return null
  }
  return metadata
}

/** An entry is all-or-nothing: a partially understood refusal is not an audit record. */
function parseReport(value: unknown): HostAuditReport | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const field = (key: string): unknown => Reflect.get(value, key)
  const eventType = text(field('eventType'))
  const result = text(field('result'))
  if (!eventType || !isEventType(eventType) || !result || !isResult(result)) {
    return null
  }
  const traceId = text(field('traceId'))
  let metadata: Record<string, unknown> | undefined
  if (FILE_EVENT_TYPES.has(eventType) && field('metadata') !== undefined) {
    metadata = parseFileEventMetadata(field('metadata')) ?? undefined
    if (metadata === undefined) {
      return null
    }
  }
  return {
    eventType,
    result,
    deviceId: text(field('deviceId')),
    subject: text(field('subject')),
    projectId: text(field('projectId')),
    method: text(field('method')),
    denial: text(field('denial')),
    reason: text(field('reason')),
    ...(FILE_EVENT_TYPES.has(eventType) && traceId !== undefined ? { traceId } : {}),
    ...(metadata !== undefined ? { metadata } : {})
  }
}

export function parseHostAuditReports(value: unknown): HostAuditReport[] {
  if (!Array.isArray(value)) {
    return []
  }
  const reports: HostAuditReport[] = []
  for (const entry of value.slice(0, MAX_REPORTS_PER_BEAT)) {
    const parsed = parseReport(entry)
    if (parsed) {
      reports.push(parsed)
    }
  }
  return reports
}

/** §2.10.4: the heartbeat's optional gap counters; unknown shapes are ignored. */
export type HostAuditGap = {
  bootId: string
  pending: number
  dropped: number
  suppressed: number
  rateLimited: number
}

export function parseHostAuditGap(value: unknown): HostAuditGap | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const counter = (key: string): number => {
    const raw = Reflect.get(value, key)
    return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : 0
  }
  const bootId = text(Reflect.get(value, 'bootId'))
  if (bootId === undefined) {
    return null
  }
  return {
    bootId,
    pending: counter('pending'),
    dropped: counter('dropped'),
    suppressed: counter('suppressed'),
    rateLimited: counter('rateLimited')
  }
}

/**
 * Optional device-tier actor resolution (§2.1): platform device id → user.
 * The heartbeat route can wire this from its store; without it attribution
 * falls back to the `user:`-prefixed subject the host reports.
 */
export type HostAuditActorResolver = (deviceId: string) => { username: string } | null

/** Returns how many reports reached the chain; the host clears the whole batch either way. */
export function appendHostAuditReports(
  audit: AuditChain,
  host: { id: string; name: string },
  reports: readonly HostAuditReport[],
  traceId: string,
  resolveActor?: HostAuditActorResolver
): number {
  let appended = 0
  for (const report of reports) {
    const ok = FILE_EVENT_TYPES.has(report.eventType)
      ? appendFileEvent(audit, host, report, traceId, resolveActor)
      : appendSecurityRefusal(audit, host, report, traceId)
    appended += ok ? 1 : 0
  }
  return appended
}

/** Legacy shape, byte-for-byte: `host.` prefix, host actor, subject in metadata. */
function appendSecurityRefusal(
  audit: AuditChain,
  host: { id: string; name: string },
  report: HostAuditReport,
  traceId: string
): boolean {
  return audit.appendBestEffort({
    eventType: `host.${report.eventType}`,
    actor: `host:${host.name}`,
    targetType: report.deviceId ? 'device' : 'host',
    targetId: report.deviceId ?? host.id,
    result: report.result,
    traceId,
    metadata: {
      ...(report.subject ? { subject: report.subject } : {}),
      ...(report.projectId ? { projectId: report.projectId } : {}),
      ...(report.method ? { method: report.method } : {}),
      ...(report.denial ? { denial: report.denial } : {}),
      ...(report.reason ? { reason: report.reason } : {})
    }
  })
}

/** §2.8: file events land under their bare names with user attribution (§2.1). */
function appendFileEvent(
  audit: AuditChain,
  host: { id: string; name: string },
  report: HostAuditReport,
  traceId: string,
  resolveActor?: HostAuditActorResolver
): boolean {
  const fromSubject = report.subject ? stripUserPrefix(report.subject) : null
  const resolved = report.deviceId && resolveActor ? resolveActor(report.deviceId) : null
  const actor = resolved !== null ? resolved.username : (fromSubject ?? `host:${host.name}`)
  const actorSource = resolved !== null ? 'device' : fromSubject !== null ? 'subject' : 'host'
  return audit.appendBestEffort({
    eventType: report.eventType,
    actor,
    targetType: 'project',
    targetId: report.projectId ?? host.id,
    result: report.result,
    traceId: report.traceId ?? traceId,
    metadata: {
      hostId: host.id,
      hostName: host.name,
      actorSource,
      ...(report.subject ? { subject: report.subject } : {}),
      ...(report.deviceId ? { deviceId: report.deviceId } : {}),
      ...(report.method ? { method: report.method } : {}),
      ...(report.denial ? { denial: report.denial } : {}),
      ...(report.reason ? { reason: report.reason } : {}),
      ...report.metadata
    }
  })
}

function stripUserPrefix(value: string): string | null {
  return /^user:/i.test(value) ? value.slice(5) : null
}
