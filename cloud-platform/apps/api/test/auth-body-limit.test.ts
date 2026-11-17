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

async function start(): Promise<string> {
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
  return `http://127.0.0.1:${port}`
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

describe('U249 未认证 login/refresh body 上限', () => {
  after(async () => {
    await Promise.all(apps.map((app) => app.close()))
  })

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
