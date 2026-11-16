import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AuditEvent } from './store.ts'

/**
 * Durable, append-only audit log.
 *
 * The chain only detects tampering if the events survive the process: an
 * in-memory log is rebuilt on every restart, so nothing can be altered and
 * nothing needs checking. Each append is a line so a torn write can be spotted
 * (an unparsable line is corruption, not an event), and the chain is reloaded on
 * boot so `prevHash` continues across restarts instead of forking.
 */

export type AuditLogFile = {
  /** Appends one event as a JSON line. Throws so a failed write cannot be silently ignored. */
  append: (event: AuditEvent) => void
  /** Events in chain order. */
  load: () => AuditEvent[]
}

export type AuditLoadResult =
  | { ok: true; events: AuditEvent[] }
  | { ok: false; reason: 'unparsable'; line: number }

/** Parses the log without trusting it: a bad line is reported, never skipped. */
export function parseAuditLog(text: string): AuditLoadResult {
  const events: AuditEvent[] = []
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line.trim() === '') {
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return { ok: false, reason: 'unparsable', line: index + 1 }
    }
    if (!isAuditEvent(parsed)) {
      return { ok: false, reason: 'unparsable', line: index + 1 }
    }
    events.push(parsed)
  }
  return { ok: true, events }
}

function isAuditEvent(value: unknown): value is AuditEvent {
  if (value === null || typeof value !== 'object') {
    return false
  }
  const event = value as Record<string, unknown>
  return (
    typeof event.seq === 'number' &&
    typeof event.ts === 'number' &&
    typeof event.eventType === 'string' &&
    // Nullable in AuditEvent: system/host events carry no actor or target type.
    (typeof event.actor === 'string' || event.actor === null) &&
    (typeof event.targetType === 'string' || event.targetType === null) &&
    typeof event.result === 'string' &&
    typeof event.prevHash === 'string' &&
    typeof event.hash === 'string'
  )
}

export function openAuditLogFile(path: string): AuditLogFile {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true })
  }
  return {
    append: (event) => {
      appendFileSync(path, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 })
    },
    load: () => {
      if (!existsSync(path)) {
        return []
      }
      const result = parseAuditLog(readFileSync(path, 'utf8'))
      // Why throw: continuing with a partial chain would make `verify()` pass on a
      // truncated log, which is the exact failure the chain exists to expose.
      if (!result.ok) {
        throw Object.assign(new Error(`audit log corrupt at line ${result.line}`), {
          code: 'AUDIT_LOG_CORRUPT'
        })
      }
      return result.events
    }
  }
}
