import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp, type ApiHandle } from '../src/server.ts'

/**
 * U58 U13 (exploratory r2 `api.json`): `GET /v1/audit/events?cursor=abc` used
 * to answer 200 and silently drop the cursor, because `Number()` produced NaN
 * and the chain treats a falsy cursor as «no cursor». A cursor is an event seq,
 * so anything but a decimal non-negative safe integer is a caller error.
 */

const ORIGIN = 'https://console.u58-cursor.example'
const INTERNAL_TOKEN = 'u58-cursor-token'

const apps: ApiHandle[] = []

type Json = Record<string, unknown>

type QueryResult = { status: number; body: Json; text: string }

let base = ''
let adminToken = ''

async function startApp(): Promise<string> {
  const app = createApp({
    port: 0,
    accessTtlMs: 60_000,
    refreshTtlMs: 60_000,
    internalToken: INTERNAL_TOKEN,
    cookieMode: 'auto',
    publicOrigin: ORIGIN
  })
  apps.push(app)
  const port = await app.listen()
  return `http://127.0.0.1:${port}`
}

async function loginAdmin(): Promise<string> {
  const res = await fetch(`${base}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'u58-cursor' })
  })
  assert.equal(res.status, 200, 'admin must log in')
  const body = (await res.json()) as Json
  return String(body.accessToken ?? '')
}

async function queryCursor(cursor: string): Promise<QueryResult> {
  const params = new URLSearchParams({ limit: '50', cursor })
  const res = await fetch(`${base}/v1/audit/events?${params}`, {
    headers: { authorization: `Bearer ${adminToken}` }
  })
  const text = await res.text()
  return { status: res.status, body: text ? (JSON.parse(text) as Json) : {}, text }
}

function errorCode(body: Json): string | undefined {
  const error = body.error
  return error && typeof error === 'object'
    ? String((error as Record<string, unknown>).code ?? '')
    : undefined
}

before(async () => {
  base = await startApp()
  adminToken = await loginAdmin()
})

after(async () => {
  await Promise.all(apps.map((app) => app.close()))
})

test('U58 U13 cursor accepts decimal non-negative integers', async () => {
  for (const cursor of ['0', '1', '999999']) {
    const result = await queryCursor(cursor)
    assert.equal(result.status, 200, `cursor=${cursor} must be accepted: ${result.text}`)
    assert.equal(errorCode(result.body), undefined, `cursor=${cursor} must not be an error`)
    assert.ok(Array.isArray(result.body.events), `cursor=${cursor} returns a page`)
  }
})

test('U58 U13 cursor rejects every non-decimal or unsafe value', async () => {
  const invalid = ['abc', '-1', '1.5', ' 1', '1e3', '']
  for (const cursor of invalid) {
    const result = await queryCursor(cursor)
    assert.equal(
      result.status,
      400,
      `cursor=${JSON.stringify(cursor)} must be rejected, got ${result.status}: ${result.text}`
    )
    assert.equal(
      errorCode(result.body),
      'INVALID_QUERY',
      `cursor=${JSON.stringify(cursor)} must name the error code, not be ignored`
    )
    assert.equal('events' in result.body, false, 'a rejected cursor returns no business data')
    assert.equal('nextCursor' in result.body, false, 'a rejected cursor returns no cursor')
  }
})

test('U58 U13 invalid cursor is an explicit error, not a silently ignored filter', async () => {
  // Control: the same request without a cursor succeeds and returns a page, so
  // the 400 above is caused by the cursor value — not by the endpoint being off.
  const withoutCursor = await fetch(`${base}/v1/audit/events?limit=50`, {
    headers: { authorization: `Bearer ${adminToken}` }
  })
  assert.equal(withoutCursor.status, 200)
  const withoutBody = (await withoutCursor.json()) as Json
  assert.equal(errorCode(withoutBody), undefined)

  const invalid = await queryCursor('abc')
  assert.equal(invalid.status, 400)
  assert.match(invalid.text, /"code":"INVALID_QUERY"/, 'the body carries the error code')
  assert.match(invalid.text, /cursor/, 'the error names the offending parameter')
})
