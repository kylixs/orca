import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp, type ApiHandle } from '../../apps/api/src/server.ts'

/**
 * U197 S1: the refresh Cookie is issued only for the platform's configured
 * origin; an unconfigured app (auto without ORCA_CLOUD_PUBLIC_ORIGIN) stays
 * byte-for-byte on the old body-token contract.
 */

const ORIGIN = 'https://console.example.com'
const apps: ApiHandle[] = []

type Started = { app: ApiHandle; base: string }

async function start(options: {
  cookieMode?: string
  publicOrigin?: string
  refreshTtlMs?: number
}): Promise<Started> {
  const app = createApp({
    port: 0,
    accessTtlMs: 60_000,
    refreshTtlMs: options.refreshTtlMs ?? 60_000,
    internalToken: 'cookie-token',
    cookieMode: options.cookieMode ?? 'auto',
    // Empty string pins "unconfigured" even if the developer shell exports one.
    publicOrigin: options.publicOrigin ?? ''
  })
  apps.push(app)
  const port = await app.listen()
  return { app, base: `http://127.0.0.1:${port}` }
}

function login(
  base: string,
  headers: Record<string, string> = {},
  username = 'admin',
  password = 'Adm1n!'
): Promise<Response> {
  return fetch(`${base}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ username, password, deviceName: 'cookie-e2e' })
  })
}

function refresh(base: string, refreshToken: string, headers: Record<string, string> = {}) {
  return fetch(`${base}/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ refreshToken })
  })
}

function cookieOf(res: Response): string {
  return res.headers.getSetCookie()[0] ?? ''
}

function assertRefreshCookieAttributes(cookie: string, maxAge: number): void {
  assert.match(cookie, /^orca_refresh=[A-Za-z0-9_-]+;/)
  assert.match(cookie, /Path=\/v1\/auth/)
  assert.match(cookie, new RegExp(`Max-Age=${maxAge}(;|$)`))
  assert.match(cookie, /HttpOnly/)
  assert.match(cookie, /SameSite=Lax/)
  assert.match(cookie, /Secure/)
}

after(async () => {
  await Promise.all(apps.map((app) => app.close()))
})

describe('U197 S1 refresh cookie（真实 createApp + HTTP）', () => {
  test('auto + PUBLIC_ORIGIN：同源登录下发 Cookie，body 不含 refreshToken', async () => {
    const { base } = await start({
      cookieMode: 'auto',
      publicOrigin: ORIGIN,
      refreshTtlMs: 60_000
    })
    // A forged X-Forwarded-Proto must not change the same-origin decision.
    const res = await login(base, { origin: ORIGIN, 'x-forwarded-proto': 'http' })
    assert.equal(res.status, 200)
    const body = (await res.json()) as Record<string, unknown>
    assert.equal('refreshToken' in body, false)
    assert.equal(typeof body.accessToken, 'string')
    assert.equal(body.expiresIn, 60)
    assert.equal(typeof body.user, 'object')
    assert.equal(typeof body.device, 'object')
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assertRefreshCookieAttributes(cookieOf(res), 60)
  })

  test('无 Origin（非浏览器）：不下发 Cookie，保留 body refresh', async () => {
    const { base } = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const res = await login(base)
    assert.equal(res.status, 200)
    assert.deepEqual(res.headers.getSetCookie(), [])
    const body = (await res.json()) as Record<string, unknown>
    assert.equal(typeof body.refreshToken, 'string')
  })

  test('宿主跨源（不同 Origin）：不下发 Cookie，保留 body refresh', async () => {
    const { base } = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const res = await login(base, { origin: 'https://evil.example' })
    assert.equal(res.status, 200)
    assert.deepEqual(res.headers.getSetCookie(), [])
    const body = (await res.json()) as Record<string, unknown>
    assert.equal(typeof body.refreshToken, 'string')
  })

  test('COOKIE_MODE=never：与旧行为一致（无 Cookie、body 有 refresh）', async () => {
    const { base } = await start({ cookieMode: 'never', publicOrigin: ORIGIN })
    const res = await login(base, { origin: ORIGIN })
    assert.equal(res.status, 200)
    assert.deepEqual(res.headers.getSetCookie(), [])
    const body = (await res.json()) as Record<string, unknown>
    assert.equal(typeof body.refreshToken, 'string')
  })

  test('auto 未配置 PUBLIC_ORIGIN：降级 never，响应与旧行为一致', async () => {
    const { base } = await start({ cookieMode: 'auto', publicOrigin: '' })
    const res = await login(base, { origin: ORIGIN })
    assert.equal(res.status, 200)
    assert.deepEqual(res.headers.getSetCookie(), [])
    const body = (await res.json()) as Record<string, unknown>
    assert.equal(typeof body.refreshToken, 'string')
  })

  test('平台同源交接：下发 Cookie，body 不含 refreshToken；无 Origin 仍返回 body', async () => {
    const { app, base } = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const dev = app.store.usersByName.get('zhangsan')
    assert.ok(dev)
    const mint = (code: string) => {
      app.store.webHandoffs.set(code, {
        userId: dev.id,
        projectId: 'proj_payment',
        expiresAt: Date.now() + 60_000
      })
    }
    const redeem = (code: string, headers: Record<string, string>) =>
      fetch(`${base}/v1/web/handoff`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ code })
      })

    mint('same-origin-code')
    const same = await redeem('same-origin-code', { origin: ORIGIN })
    assert.equal(same.status, 200)
    const sameBody = (await same.json()) as Record<string, unknown>
    assert.equal('refreshToken' in sameBody, false)
    assert.equal(typeof sameBody.accessToken, 'string')
    assertRefreshCookieAttributes(cookieOf(same), 60)

    mint('script-code')
    const script = await redeem('script-code', {})
    assert.equal(script.status, 200)
    assert.deepEqual(script.headers.getSetCookie(), [])
    const scriptBody = (await script.json()) as Record<string, unknown>
    assert.equal(typeof scriptBody.refreshToken, 'string')
  })

  test('登出：Bearer 缺失也清 Cookie（Max-Age=0、同属性）', async () => {
    const { base } = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const res = await fetch(`${base}/v1/auth/logout`, {
      method: 'POST',
      headers: { origin: ORIGIN }
    })
    assert.equal(res.status, 200)
    const cookie = cookieOf(res)
    assert.match(cookie, /^orca_refresh=;/)
    assert.match(cookie, /Path=\/v1\/auth/)
    assert.match(cookie, /Max-Age=0/)
    assert.match(cookie, /HttpOnly/)
    assert.match(cookie, /SameSite=Lax/)
    assert.match(cookie, /Secure/)
    assert.equal(res.headers.get('cache-control'), 'no-store')
  })

  test('重复 orca_refresh：刷新硬 401，且不轮换、不撤销 session', async () => {
    const { base } = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const first = (await (await login(base)).json()) as Record<string, unknown>
    const refreshToken = String(first.refreshToken)

    const ambiguous = await refresh(base, refreshToken, {
      cookie: 'orca_refresh=a; orca_refresh=b'
    })
    assert.equal(ambiguous.status, 401)
    const duplicateBody = (await ambiguous.json()) as { error?: { code?: string } }
    assert.equal(duplicateBody.error?.code, 'SESSION_EXPIRED')

    // The same body token still rotates: the duplicate path had no side effect.
    const afterDuplicate = await refresh(base, refreshToken)
    assert.equal(afterDuplicate.status, 200)
    const renewed = (await afterDuplicate.json()) as Record<string, unknown>
    assert.notEqual(renewed.refreshToken, refreshToken)
  })

  test('重复 Cookie 在登录/交接同样硬 401 且不下发 Cookie', async () => {
    const { app, base } = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const ambiguous = { origin: ORIGIN, cookie: 'orca_refresh=a; orca_refresh=b' }
    const loginRes = await login(base, ambiguous)
    assert.equal(loginRes.status, 401)
    assert.deepEqual(loginRes.headers.getSetCookie(), [])

    const dev = app.store.usersByName.get('zhangsan')
    assert.ok(dev)
    app.store.webHandoffs.set('dup-code', {
      userId: dev.id,
      projectId: 'proj_payment',
      expiresAt: Date.now() + 60_000
    })
    const handoffRes = await fetch(`${base}/v1/web/handoff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ambiguous },
      body: JSON.stringify({ code: 'dup-code' })
    })
    assert.equal(handoffRes.status, 401)
    assert.deepEqual(handoffRes.headers.getSetCookie(), [])
  })

  test('COOKIE_MODE=never：重复 Cookie 不影响旧刷新路径', async () => {
    const { base } = await start({ cookieMode: 'never', publicOrigin: ORIGIN })
    const first = (await (await login(base)).json()) as Record<string, unknown>
    const res = await refresh(base, String(first.refreshToken), {
      cookie: 'orca_refresh=a; orca_refresh=b'
    })
    assert.equal(res.status, 200)
  })
})
