import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp, type ApiHandle } from '../src/server.ts'

/**
 * U249 P3-7: the unauthenticated login/refresh bodies were read without a cap.
 * They now share the logout limit and answer 413 before parsing, while a normal
 * (or long-token) request keeps working.
 */

const ORIGIN = 'https://console.u249.example'
const AUTH_BODY_MAX_BYTES = 16 * 1024
const apps: ApiHandle[] = []

async function startApp(): Promise<{ app: ApiHandle; base: string }> {
  const app = createApp({
    port: 0,
    accessTtlMs: 60_000,
    refreshTtlMs: 60_000,
    internalToken: 'u249-token',
    cookieMode: 'auto',
    publicOrigin: ORIGIN
  })
  apps.push(app)
  const port = await app.listen()
  return { app, base: `http://127.0.0.1:${port}` }
}

async function start(): Promise<string> {
  return (await startApp()).base
}

type Json = Record<string, unknown>

function login(base: string, body: string, headers: Record<string, string> = {}) {
  return fetch(`${base}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body
  })
}

function refresh(base: string, body: string, headers: Record<string, string> = {}) {
  return fetch(`${base}/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body
  })
}

function oversized(fields: Record<string, unknown>): string {
  // Comfortably above the cap; the old code buffered all of it before parsing.
  return JSON.stringify({ ...fields, pad: 'x'.repeat(AUTH_BODY_MAX_BYTES * 4) })
}

function errorCode(body: Json): unknown {
  const error = body.error
  return error !== null && typeof error === 'object' ? (error as Json).code : undefined
}

function redeemHandoff(
  base: string,
  body: string,
  headers: Record<string, string> = {}
): Promise<Response> {
  return fetch(`${base}/v1/web/handoff`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body
  })
}

function seedHandoff(app: ApiHandle, code: string): void {
  const user = app.store.usersByName.get('zhangsan')
  assert.ok(user)
  app.store.webHandoffs.set(code, {
    userId: user.id,
    projectId: 'proj_payment',
    expiresAt: Date.now() + 60_000
  })
}

after(async () => {
  await Promise.all(apps.map((app) => app.close()))
})

describe('U250 /v1/web/handoff body 上限（未认证）', () => {
  test('合法交接码 2xx（回归）', async () => {
    const { app, base } = await startApp()
    seedHandoff(app, 'u250-valid')

    const res = await redeemHandoff(
      base,
      JSON.stringify({ code: 'u250-valid', deviceName: 'u250' })
    )

    assert.equal(res.status, 200)
    const body = (await res.json()) as Json
    assert.equal((body.user as Json).username, 'zhangsan')
    assert.equal(app.store.webHandoffs.has('u250-valid'), false, 'a redeemed code is consumed')
  })

  test('超大 body → 413 PAYLOAD_TOO_LARGE，且不消耗交接码', async () => {
    const { app, base } = await startApp()
    seedHandoff(app, 'u250-keep')

    const res = await redeemHandoff(base, oversized({ code: 'u250-keep', deviceName: 'u250' }))

    assert.equal(res.status, 413)
    assert.equal(errorCode((await res.json()) as Json), 'PAYLOAD_TOO_LARGE')
    assert.ok(app.store.webHandoffs.has('u250-keep'), 'the code must survive an oversized request')

    const again = await redeemHandoff(base, JSON.stringify({ code: 'u250-keep' }))
    assert.equal(again.status, 200, 'the untouched code still redeems')
  })

  test('有无有效凭据行为一致：未知码、重复 Cookie 同样 413，不泄露凭据状态', async () => {
    const { app, base } = await startApp()
    seedHandoff(app, 'u250-known')

    const known = await redeemHandoff(base, oversized({ code: 'u250-known' }))
    const unknown = await redeemHandoff(base, oversized({ code: 'u250-unknown' }))
    // The cap runs before the Cookie-state checks, so a request that would
    // otherwise be a Cookie 401 is still a content-size 413.
    const ambiguousCookie = await redeemHandoff(base, oversized({ code: 'u250-known' }), {
      cookie: 'orca_refresh=a; orca_refresh=b'
    })

    assert.equal(known.status, 413)
    assert.equal(unknown.status, 413)
    assert.equal(ambiguousCookie.status, 413)
    assert.equal(errorCode((await known.json()) as Json), 'PAYLOAD_TOO_LARGE')
    assert.equal(errorCode((await unknown.json()) as Json), 'PAYLOAD_TOO_LARGE')
    assert.ok(app.store.webHandoffs.has('u250-known'), 'neither request may consume the code')
  })
})

describe('U249 未认证 login/refresh body 上限', () => {
  test('login 超大 body → 413 PAYLOAD_TOO_LARGE，且不建立会话', async () => {
    const base = await start()
    const res = await login(base, oversized({ username: 'admin', password: 'Adm1n!' }))
    assert.equal(res.status, 413)
    assert.equal(errorCode((await res.json()) as Json), 'PAYLOAD_TOO_LARGE')
  })

  test('login 正常 body 仍 200（回归）', async () => {
    const base = await start()
    const res = await login(
      base,
      JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'u249' })
    )
    assert.equal(res.status, 200)
  })

  test('refresh body 分支超大 body → 413，且不消耗原 token', async () => {
    const base = await start()
    const first = (await (
      await login(base, JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'u249' }))
    ).json()) as Json
    const token = first.refreshToken
    assert.equal(typeof token, 'string')

    const huge = await refresh(base, oversized({ refreshToken: token }))
    assert.equal(huge.status, 413)
    assert.equal(errorCode((await huge.json()) as Json), 'PAYLOAD_TOO_LARGE')

    const again = await refresh(base, JSON.stringify({ refreshToken: token }))
    assert.equal(again.status, 200)
  })

  test('refresh Cookie 分支超大 body → 413，Cookie 会话仍可用', async () => {
    const base = await start()
    const loginRes = await login(
      base,
      JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'u249' }),
      { origin: ORIGIN }
    )
    assert.equal(loginRes.status, 200)
    const cookie = loginRes.headers.getSetCookie()[0]?.split(';')[0] ?? ''
    assert.match(cookie, /^orca_refresh=/)

    const huge = await refresh(base, oversized({}), { cookie, origin: ORIGIN })
    assert.equal(huge.status, 413)
    assert.equal(errorCode((await huge.json()) as Json), 'PAYLOAD_TOO_LARGE')

    const small = await refresh(base, '{}', { cookie, origin: ORIGIN })
    assert.equal(small.status, 200)
  })
})
