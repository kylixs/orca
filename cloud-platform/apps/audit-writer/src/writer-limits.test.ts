import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { MAX_BATCH, MAX_EVENT_BYTES, APPEND_BODY_MAX_BYTES } from './writer-limits.ts'

/**
 * U257: the writer must admit every event the API can legally produce. The
 * API-side budgets live in apps/api; restating them here keeps the relation
 * visible so either side changing turns this test red before a legal event
 * is refused with 400 at the writer.
 */
const API_EVENT_MAX_BYTES = 12 * 1024
const API_METADATA_MAX_BYTES = 8 * 1024
const ENVELOPE_HEADROOM_BYTES = 4 * 1024
const MIN_EVENT_HEADROOM_BYTES = 256

const readSource = (file: string): string => readFileSync(new URL(file, import.meta.url), 'utf8')
const LOCAL_DECLARATION = /\bconst\s+(MAX_BATCH|MAX_EVENT_BYTES|APPEND_BODY_MAX_BYTES)\s*=/

test('writer event cap covers the API event budget plus 4 KiB headroom', () => {
  assert.ok(
    MAX_EVENT_BYTES >= API_EVENT_MAX_BYTES + ENVELOPE_HEADROOM_BYTES,
    `MAX_EVENT_BYTES=${MAX_EVENT_BYTES} must be >= API event budget ${API_EVENT_MAX_BYTES} + ${ENVELOPE_HEADROOM_BYTES}`
  )
  assert.ok(
    API_EVENT_MAX_BYTES + MIN_EVENT_HEADROOM_BYTES <= MAX_EVENT_BYTES,
    `API event budget ${API_EVENT_MAX_BYTES} + ${MIN_EVENT_HEADROOM_BYTES} must fit MAX_EVENT_BYTES=${MAX_EVENT_BYTES}`
  )
})

test('API metadata budget leaves 4 KiB for top-level fields inside the event budget', () => {
  assert.equal(API_EVENT_MAX_BYTES, API_METADATA_MAX_BYTES + ENVELOPE_HEADROOM_BYTES)
  assert.ok(API_METADATA_MAX_BYTES < MAX_EVENT_BYTES)
})

test('append body cap is derived from the batch and event caps', () => {
  assert.equal(APPEND_BODY_MAX_BYTES, MAX_BATCH * MAX_EVENT_BYTES)
  assert.ok(Number.isSafeInteger(APPEND_BODY_MAX_BYTES))
  assert.ok(MAX_BATCH > 0 && MAX_EVENT_BYTES > 0)
})

test('writer and its body test import the limits instead of restating them', () => {
  for (const file of ['./writer.ts', './writer-body.test.ts']) {
    const source = readSource(file)
    assert.match(source, /from '\.\/writer-limits\.ts'/, `${file} must import writer-limits.ts`)
    assert.doesNotMatch(source, LOCAL_DECLARATION, `${file} must not redeclare a limit`)
  }
})
