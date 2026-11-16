import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openAuditLogFile, parseAuditLog } from '../src/audit-log-file.ts'
import type { AuditEvent } from '../src/store.ts'

/**
 * U133: the durable log used to reject events whose actor/targetType is null,
 * which is legal in AuditEvent (system and host-reported events). Enabling the
 * log for the first time turned the next restart into AUDIT_LOG_CORRUPT.
 */

const tempFile = () => path.join(mkdtempSync(path.join(tmpdir(), 'orca-audit-log-')), 'audit.log')

const event = (over: Partial<AuditEvent> = {}): AuditEvent => ({
  seq: 1,
  ts: 1_700_000_000_000,
  eventType: 'host_e2ee_key_changed',
  actor: null,
  targetType: null,
  targetId: 'host_1',
  result: 'success',
  traceId: null,
  prevHash: 'GENESIS',
  hash: 'h1',
  ...over
})

describe('audit log file', () => {
  test('round-trips events with null actor and targetType', () => {
    const file = tempFile()
    try {
      const log = openAuditLogFile(file)
      log.append(event())
      log.append(event({ seq: 2, eventType: 'host_register', actor: 'agent', targetType: 'host' }))
      const events = log.load()
      assert.equal(events.length, 2)
      assert.equal(events[0]?.actor, null)
      assert.equal(events[0]?.targetType, null)
      assert.equal(events[1]?.seq, 2)
    } finally {
      rmSync(path.dirname(file), { recursive: true, force: true })
    }
  })

  test('reports the corrupt line for invalid JSON', () => {
    const file = tempFile()
    try {
      writeFileSync(file, `${JSON.stringify(event())}\n{not json\n`)
      const result = parseAuditLog(readFileSync(file, 'utf8'))
      assert.equal(result.ok, false)
      assert.equal(result.ok ? null : result.line, 2)
    } finally {
      rmSync(path.dirname(file), { recursive: true, force: true })
    }
  })

  test('rejects structurally invalid events instead of skipping them', () => {
    const file = tempFile()
    try {
      writeFileSync(file, `${JSON.stringify({ eventType: 'x', seq: 1 })}\n`)
      const result = parseAuditLog(readFileSync(file, 'utf8'))
      assert.equal(result.ok, false)
    } finally {
      rmSync(path.dirname(file), { recursive: true, force: true })
    }
  })
})
