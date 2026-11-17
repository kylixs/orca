/**
 * Pure audit-export serialization (CSV / JSONL). No store, clock, or HTTP.
 * CSV follows RFC 4180; JSONL is one compact event per line so the hash chain
 * can be verified offline.
 */
import type { AuditEvent } from './store.ts'

/** Fixed columns in wire order; extra fields on an event are dropped from CSV. */
export const AUDIT_EXPORT_CSV_COLUMNS = [
  'seq',
  'ts',
  'eventType',
  'actor',
  'targetType',
  'targetId',
  'result',
  'traceId',
  'metadata',
  'prevHash',
  'hash'
] as const

export type AuditExportCsvColumn = (typeof AUDIT_EXPORT_CSV_COLUMNS)[number]

export const AUDIT_EXPORT_CSV_HEADER = AUDIT_EXPORT_CSV_COLUMNS.join(',')
export const AUDIT_EXPORT_CSV_EOL = '\r\n'

// Tab and CR are spreadsheet formula prefixes too (design §4.5).
const FORMULA_PREFIX = /^[=+\-@\t\r]/
const NEEDS_QUOTING = /[",\r\n]/

function text(value: unknown): string {
  if (value === null || value === undefined) {
    return ''
  }
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'object') {
    return JSON.stringify(value)
  }
  return String(value)
}

function csvField(value: string): string {
  // Prefixing changes the value; the export notice documents it (design D9).
  const neutralized = FORMULA_PREFIX.test(value) ? `'${value}` : value
  return NEEDS_QUOTING.test(neutralized) ? `"${neutralized.replace(/"/g, '""')}"` : neutralized
}

/** One CSV record, without a line terminator. Null/undefined cells are empty. */
export function toAuditCsvRow(event: AuditEvent): string {
  return AUDIT_EXPORT_CSV_COLUMNS.map((column) => csvField(text(event[column]))).join(',')
}

/** Header plus one CRLF-terminated record per event. */
export function serializeAuditCsv(events: readonly AuditEvent[]): string {
  const rows = [AUDIT_EXPORT_CSV_HEADER, ...events.map(toAuditCsvRow)]
  return rows.join(AUDIT_EXPORT_CSV_EOL) + AUDIT_EXPORT_CSV_EOL
}

/** One JSONL record including its trailing newline; JSON.stringify escapes CR/LF. */
export function toAuditJsonlLine(event: AuditEvent): string {
  return `${JSON.stringify(event)}\n`
}

/** Concatenates lines, keeping input order. Extra fields are preserved here. */
export function serializeAuditJsonl(events: readonly AuditEvent[]): string {
  return events.map(toAuditJsonlLine).join('')
}
