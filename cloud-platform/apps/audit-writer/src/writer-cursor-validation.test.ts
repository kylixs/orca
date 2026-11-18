import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnService, type Service } from '../../../test/e2e/harness.ts'

/**
 * U58 (exploratory r2 `api.json`): the internal `/v1/events` cursor is an event
 * seq. `Number()` accepted "1e3"/"1.5" and produced NaN for anything else,
 * which the chain treated as "no cursor" — a malformed cursor silently returned
 * the newest page instead of 400. The same defect class was fixed in the API.
 */

const TOKEN = 'u58-writer-cursor-token'
const EVENT_COUNT = 3
let service: Service

before(async () => {
  service = await spawnService(
    'apps/audit-writer/src/writer.ts',
    { PORT: '0', INTERNAL_TOKEN: TOKEN },
    /\[audit-writer\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'audit-writer'
  )
  const res = await fetch(`${service.url}/v1/append`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-token': TOKEN },
    body: JSON.stringify({
      events: Array.from({ length: EVENT_COUNT }, (_, index) => ({
        eventType: `u58_cursor_${index + 1}`,
        actor: 'tester',
        targetType: null,
        targetId: null,
        traceId: null,
        result: 'success'
      }))
    })
  })
  assert.equal(res.status, 200)
})

after(async () => {
  await service.stop()
})

type QueryResult = {
  status: number
  body: { events?: { seq: number }[]; nextCursor?: number | null; error?: { code?: string } }
}

/** Omitting `cursor` leaves the parameter out entirely; `null` sends `cursor=`. */
async function query(cursor: string | null): Promise<QueryResult> {
  const params = new URLSearchParams({ limit: '50' })
  if (cursor !== null) params.set('cursor', cursor)
  const res = await fetch(`${service.url}/v1/events?${params.toString()}`, {
    headers: { 'x-internal-token': TOKEN }
  })
  return { status: res.status, body: (await res.json()) as QueryResult['body'] }
}

test('U58 writer cursor accepts decimal non-negative integers', async () => {
  for (const cursor of ['0', '1', '999999']) {
    const result = await query(cursor)
    assert.equal(result.status, 200, `cursor=${cursor} must be accepted: ${JSON.stringify(result.body)}`)
    assert.equal(result.body.error, undefined, `cursor=${cursor} must not be an error`)
    assert.ok(Array.isArray(result.body.events), `cursor=${cursor} returns a page`)
  }
})

test('U58 writer cursor rejects every non-decimal value with INVALID_QUERY', async () => {
  for (const cursor of ['abc', '-1', '1.5', '1e3', '', ' 1']) {
    const result = await query(cursor)
    assert.equal(
      result.status,
      400,
      `cursor=${JSON.stringify(cursor)} must be rejected, got ${result.status}: ${JSON.stringify(result.body)}`
    )
    assert.equal(result.body.error?.code, 'INVALID_QUERY')
    assert.equal('events' in result.body, false, 'a rejected cursor returns no events')
    assert.equal('nextCursor' in result.body, false, 'a rejected cursor returns no cursor')
  }
})

test('U58 writer cursor=0 is an explicit filter, not dropped as a missing cursor', async () => {
  const withoutCursor = await query(null)
  assert.equal(withoutCursor.status, 200)
  assert.equal(withoutCursor.body.events?.length, EVENT_COUNT)

  const zero = await query('0')
  assert.equal(zero.status, 200, 'cursor=0 must not be a 400')
  assert.equal(zero.body.error, undefined, 'cursor=0 is an accepted value')
  assert.ok(Array.isArray(zero.body.events), 'cursor=0 returns a page')
  // Seqs start at 1 and cursor is an exclusive upper bound, so 0 is a real
  // empty page. Differing from an omitted cursor is the proof that the value
  // went through the filter instead of being swallowed by a falsy check.
  assert.deepEqual(zero.body.events, [])
  // Control: a boundary inside the chain still filters, so the endpoint is live.
  assert.deepEqual(
    (await query('2')).body.events?.map((event) => event.seq),
    [1]
  )
})

test('U58 writer cursor rejects unsafe integers and overlong decimal strings', async () => {
  for (const cursor of ['9007199254740993', '9'.repeat(400)]) {
    const result = await query(cursor)
    assert.equal(result.status, 400, `cursor=${cursor.slice(0, 24)} must be rejected`)
    assert.equal(result.body.error?.code, 'INVALID_QUERY')
  }
})
