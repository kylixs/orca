import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnService, type Service } from '../../../test/e2e/harness.ts'

/**
 * U250: the lockout counter only receives small control messages. A body over
 * 4 KiB is dropped whole (no 413) and non-object JSON is an absent body.
 */

const TOKEN = 'u250-lockout-token'
let service: Service

before(async () => {
  service = await spawnService(
    'apps/login-lockout/src/lockout.ts',
    { PORT: '0', INTERNAL_TOKEN: TOKEN },
    /\[login-lockout\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'login-lockout'
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

async function remaining(username: string): Promise<number> {
  const res = await fetch(`${service.url}/v1/state?username=${username}`, {
    headers: { 'x-internal-token': TOKEN }
  })
  return ((await res.json()) as { remaining: number }).remaining
}

test('body over 4 KiB is discarded whole', async () => {
  const body = JSON.stringify({ username: 'u250-oversized', pad: 'x'.repeat(5000) })
  assert.ok(Buffer.byteLength(body) > 4 * 1024)
  const res = await post('/v1/failure', body)
  assert.equal(res.status, 400)
  assert.deepEqual(await res.json(), { error: { code: 'USERNAME_REQUIRED' } })
  assert.equal(await remaining('u250-oversized'), 5)
})

test('body of exactly 4 KiB is still parsed', async () => {
  const prefix = JSON.stringify({ username: 'u250-boundary', pad: '' })
  const body = JSON.stringify({
    username: 'u250-boundary',
    pad: 'x'.repeat(4 * 1024 - prefix.length)
  })
  assert.equal(Buffer.byteLength(body), 4 * 1024)
  const res = await post('/v1/failure', body)
  assert.equal(res.status, 200)
  assert.equal(await remaining('u250-boundary'), 4)
})

test('JSON null is treated as an absent body', async () => {
  const res = await post('/v1/failure', 'null')
  assert.equal(res.status, 400)
  assert.deepEqual(await res.json(), { error: { code: 'USERNAME_REQUIRED' } })
})

test('JSON scalar is treated as an absent body', async () => {
  const res = await post('/v1/failure', '42')
  assert.equal(res.status, 400)
  assert.deepEqual(await res.json(), { error: { code: 'USERNAME_REQUIRED' } })
})

test('a valid object body still records a failure', async () => {
  const res = await post('/v1/failure', JSON.stringify({ username: 'u250-valid' }))
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { locked: false, remaining: 4, lockedUntil: 0 })
})
