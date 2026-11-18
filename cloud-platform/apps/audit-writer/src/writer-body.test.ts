import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnService, type Service } from '../../../test/e2e/harness.ts'

/**
 * U250: the audit writer bounds its append body while still accepting a full
 * legal batch (MAX_BATCH events). A body over the cap is dropped whole (no 413)
 * and non-object JSON is an absent body.
 */

const TOKEN = 'u250-writer-token'
/** Mirrors writer.ts: MAX_BATCH (1000) events x 1 KiB each. */
const APPEND_BODY_MAX_BYTES = 1000 * 1024
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
