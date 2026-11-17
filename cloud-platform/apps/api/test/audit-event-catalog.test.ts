import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AUDIT_EVENT_TYPES } from '../src/audit-event-catalog.ts'

test('U201 E2: export events are part of the audit catalog', () => {
  assert.ok(AUDIT_EVENT_TYPES.includes('audit_export'))
  assert.ok(AUDIT_EVENT_TYPES.includes('audit_export_download'))
})

test('U201 E2: the catalog has no duplicate event types', () => {
  assert.equal(new Set(AUDIT_EVENT_TYPES).size, AUDIT_EVENT_TYPES.length)
})
