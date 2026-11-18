import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnService, type Service } from '../../../test/e2e/harness.ts'
import { MAX_BATCH, MAX_EVENT_BYTES, APPEND_BODY_MAX_BYTES } from './writer-limits.ts'

/**
 * U250: the audit writer bounds its append body while still accepting a full
 * legal batch (MAX_BATCH events). A body over the cap is dropped whole (no 413)
 * and non-object JSON is an absent body.
 */

const TOKEN = 'u250-writer-token'
let service: Service

before(async () => {
  service = await spawnService(
    'apps/audit-writer/src/writer.ts',
    { PORT: '0', INTERNAL_TOKEN: TOKEN },
    /\[audit-writer\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'audit-writer'
  )
})

after(async () => {
  await service.stop()
})

function post(path: string, body: string): Promise<Response> {
  return fetch(`${service.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-token': TOKEN },
    body
  })
}

async function eventCount(): Promise<number> {
  const res = await fetch(`${service.url}/health`)
  return ((await res.json()) as { events: number }).events
}

function validEvent(traceId: string | null = null): Record<string, unknown> {
  return {
    eventType: 'u250_test',
    actor: 'tester',
    targetType: null,
    targetId: null,
    traceId,
    result: 'success'
  }
}

test('body over the append cap is discarded whole', async () => {
  const body = JSON.stringify({ events: [validEvent('x'.repeat(APPEND_BODY_MAX_BYTES))] })
  assert.ok(Buffer.byteLength(body) > APPEND_BODY_MAX_BYTES)
  const res = await post('/v1/append', body)
  assert.equal(res.status, 400)
  assert.deepEqual(await res.json(), { error: { code: 'BATCH_INVALID', max: 1000 } })
  assert.equal(await eventCount(), 0)
})

test('JSON null is treated as an absent body', async () => {
  const res = await post('/v1/append', 'null')
  assert.equal(res.status, 400)
  assert.deepEqual(await res.json(), { error: { code: 'BATCH_INVALID', max: 1000 } })
})

test('JSON scalar is treated as an absent body', async () => {
  const res = await post('/v1/append', '"events"')
  assert.equal(res.status, 400)
  assert.deepEqual(await res.json(), { error: { code: 'BATCH_INVALID', max: 1000 } })
})

test('a valid object body still appends', async () => {
  const res = await post('/v1/append', JSON.stringify({ events: [validEvent()] }))
  assert.equal(res.status, 200)
  const payload = (await res.json()) as { events: { seq: number }[] }
  assert.equal(payload.events.length, 1)
  assert.equal(payload.events[0].seq, 1)
  assert.equal(await eventCount(), 1)
})

test('a full 500-event batch (~60 KiB) still appends', async () => {
  const events = Array.from({ length: 500 }, (_, index) => ({
    ...validEvent(),
    targetId: `seq-${index}`
  }))
  const body = JSON.stringify({ events })
  assert.ok(Buffer.byteLength(body) > 4 * 1024)
  const res = await post('/v1/append', body)
  assert.equal(res.status, 200)
  const payload = (await res.json()) as { events: { seq: number }[] }
  assert.equal(payload.events.length, 500)
  assert.equal(await eventCount(), 501)
})

test('a full 1000-event batch with 4096-byte metadata still appends', async () => {
  const metadata = { fileName: `f-${'x'.repeat(4090)}`, path: '/tmp' }
  const events = Array.from({ length: MAX_BATCH }, (_, index) => ({
    ...validEvent(),
    targetId: `big-${index}`,
    metadata
  }))
  const body = JSON.stringify({ events })
  const size = Buffer.byteLength(body)
  assert.ok(size > 4 * 1024 * 1024, `legal batch is only ${size} bytes`)
  assert.ok(size < APPEND_BODY_MAX_BYTES, `legal batch is ${size} bytes`)
  const res = await post('/v1/append', body)
  assert.equal(res.status, 200)
  const payload = (await res.json()) as { events: { seq: number }[] }
  assert.equal(payload.events.length, MAX_BATCH)
  assert.equal(await eventCount(), 501 + MAX_BATCH)
})

test('a single event over 16 KiB is rejected as BATCH_INVALID', async () => {
  const event = { ...validEvent(), metadata: { blob: 'x'.repeat(MAX_EVENT_BYTES) } }
  assert.ok(Buffer.byteLength(JSON.stringify(event)) > MAX_EVENT_BYTES)
  const res = await post('/v1/append', JSON.stringify({ events: [event] }))
  assert.equal(res.status, 400)
  assert.deepEqual(await res.json(), {
    error: { code: 'BATCH_INVALID', max: MAX_BATCH, maxEventBytes: MAX_EVENT_BYTES }
  })
  assert.equal(await eventCount(), 501 + MAX_BATCH)
})
