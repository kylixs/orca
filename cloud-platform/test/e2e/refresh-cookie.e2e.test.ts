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
  refreshGraceMs?: number
  accessTtlMs?: number
}): Promise<Started> {
  const app = createApp({
    port: 0,
    accessTtlMs: options.accessTtlMs ?? 60_000,
    refreshTtlMs: options.refreshTtlMs ?? 60_000,
    refreshGraceMs: options.refreshGraceMs,
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

function cookieValueOf(res: Response): string {
  const match = /^orca_refresh=([A-Za-z0-9_-]*);/.exec(cookieOf(res))
  assert.ok(match, `expected a refresh cookie, got: ${cookieOf(res)}`)
  return match[1] ?? ''
}

function refreshWithCookie(
  base: string,
  token: string,
  headers: Record<string, string> = {},
  body: Record<string, unknown> = {}
): Promise<Response> {
  return fetch(`${base}/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `orca_refresh=${token}`, ...headers },
    body: JSON.stringify(body)
  })
}

function tokensForSession(app: ApiHandle, sessionId: string): number {
  let count = 0
  for (const mapped of app.store.refreshTokens.values()) {
    if (mapped === sessionId) count += 1
  }
  return count
}

function onlySession(app: ApiHandle) {
  assert.equal(app.store.sessions.size, 1)
  const [session] = app.store.sessions.values()
  assert.ok(session)
  return session
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

  test('登录带非平台 Origin：403 且不返回 body refresh（宿主跨源 handoff 除外）', async () => {
    const { base } = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const res = await login(base, { origin: 'https://evil.example' })
    assert.equal(res.status, 403)
    assert.deepEqual(res.headers.getSetCookie(), [])
    const body = (await res.json()) as Record<string, unknown>
    assert.equal('refreshToken' in body, false)
    assert.equal(body.error && (body.error as Record<string, unknown>).code, 'CSRF_REJECTED')
  })

  test('登录/交接带 Cookie 但无 Origin：401，不按 Cookie 源解析', async () => {
    const { app, base } = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const cookie = { cookie: 'orca_refresh=some-stale-value' }
    const loginRes = await login(base, cookie)
    assert.equal(loginRes.status, 401)
    assert.equal(
      ((await loginRes.json()) as { error: { code: string } }).error.code,
      'SESSION_EXPIRED'
    )

    const dev = app.store.usersByName.get('zhangsan')
    assert.ok(dev)
    app.store.webHandoffs.set('cookie-no-origin-code', {
      userId: dev.id,
      projectId: 'proj_payment',
      expiresAt: Date.now() + 60_000
    })
    const handoffRes = await fetch(`${base}/v1/web/handoff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...cookie },
      body: JSON.stringify({ code: 'cookie-no-origin-code' })
    })
    assert.equal(handoffRes.status, 401)
    // The code must not have been consumed by the refused call.
    assert.equal(app.store.webHandoffs.has('cookie-no-origin-code'), true)
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
    const { app, base } = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const first = (await (await login(base)).json()) as Record<string, unknown>
    const refreshToken = String(first.refreshToken)

    const session = onlySession(app)
    const expiresBefore = session.refreshExpiresAt
    const ambiguous = await refresh(base, refreshToken, {
      cookie: 'orca_refresh=a; orca_refresh=b'
    })
    assert.equal(ambiguous.status, 401)
    const duplicateBody = (await ambiguous.json()) as { error?: { code?: string } }
    assert.equal(duplicateBody.error?.code, 'SESSION_EXPIRED')
    assert.equal(session.refreshExpiresAt, expiresBefore, 'a duplicate Cookie must not renew')

    // The same body token still rotates: the duplicate path had no side effect.
    const afterDuplicate = await refresh(base, refreshToken)
    assert.equal(afterDuplicate.status, 200)
    const renewed = (await afterDuplicate.json()) as Record<string, unknown>
    assert.notEqual(renewed.refreshToken, refreshToken)
  })

  test('重复 Cookie 在登录/交接/刷新/登出：硬 401 并清理三种作用域', async () => {
    const { app, base } = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const ambiguous = { origin: ORIGIN, cookie: 'orca_refresh=a; orca_refresh=b' }
    const assertClears = (res: Response) => {
      const headers = res.headers.getSetCookie()
      assert.equal(headers.length, 3)
      assert.ok(headers.some((h) => /^orca_refresh=; Path=\/v1\/auth;/.test(h)))
      assert.ok(headers.some((h) => /Domain=console\.example\.com/.test(h)))
      assert.ok(headers.some((h) => /^orca_refresh=; Path=\/;/.test(h)))
      for (const header of headers) assert.match(header, /Max-Age=0/)
    }
    const loginRes = await login(base, ambiguous)
    assert.equal(loginRes.status, 401)
    assertClears(loginRes)

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
    assertClears(handoffRes)

    const first = (await (await login(base)).json()) as Record<string, unknown>
    const refreshRes = await refresh(base, String(first.refreshToken), {
      cookie: 'orca_refresh=a; orca_refresh=b'
    })
    assert.equal(refreshRes.status, 401)
    assertClears(refreshRes)

    const logoutRes = await fetch(`${base}/v1/auth/logout`, {
      method: 'POST',
      headers: ambiguous
    })
    assert.equal(logoutRes.status, 401)
    assertClears(logoutRes)
  })

  test('COOKIE_MODE=never：重复 Cookie 不影响旧刷新路径', async () => {
    const { base } = await start({ cookieMode: 'never', publicOrigin: ORIGIN })
    const first = (await (await login(base)).json()) as Record<string, unknown>
    const res = await refresh(base, String(first.refreshToken), {
      cookie: 'orca_refresh=a; orca_refresh=b'
    })
    assert.equal(res.status, 200)
  })

  test('COOKIE_MODE=never：body 刷新不下发 Cookie、无能力标记、返回新 refresh (AC15d)', async () => {
    const { base } = await start({ cookieMode: 'never', publicOrigin: ORIGIN })
    const first = (await (await login(base)).json()) as Record<string, unknown>
    const res = await refresh(base, String(first.refreshToken))
    assert.equal(res.status, 200)
    assert.deepEqual(res.headers.getSetCookie(), [], 'never mode must not set a cookie')
    const body = (await res.json()) as Record<string, unknown>
    assert.equal('refreshCookie' in body, false, 'no capability flag without a cookie')
    assert.equal(typeof body.refreshToken, 'string', 'never mode keeps the body contract')
    assert.notEqual(body.refreshToken, first.refreshToken, 'body current rotates in never mode')
  })
})

describe('U197 S2 刷新双读 / grace / CSRF（真实 createApp + HTTP）', () => {
  async function loginWithCookie(options: { refreshGraceMs?: number } = {}) {
    const started = await start({
      cookieMode: 'auto',
      publicOrigin: ORIGIN,
      refreshGraceMs: options.refreshGraceMs
    })
    const res = await login(started.base, { origin: ORIGIN })
    assert.equal(res.status, 200)
    const body = (await res.json()) as Record<string, unknown>
    assert.equal('refreshToken' in body, false)
    assert.equal(body.refreshCookie, true)
    return { ...started, cookie: cookieValueOf(res), body }
  }

  async function seedPrevious(options: { refreshGraceMs?: number } = {}) {
    const started = await start({
      cookieMode: 'auto',
      publicOrigin: ORIGIN,
      refreshGraceMs: options.refreshGraceMs
    })
    // Script-style login (no Origin) returns body refresh; the same-origin
    // body-source rotation then makes it `previous` and sets the current Cookie.
    const first = (await (await login(started.base)).json()) as Record<string, unknown>
    const previous = String(first.refreshToken)
    const rotated = await refresh(started.base, previous, { origin: ORIGIN })
    assert.equal(rotated.status, 200)
    const rotatedBody = (await rotated.json()) as Record<string, unknown>
    return {
      ...started,
      previous,
      current: String(rotatedBody.refreshToken),
      cookie: cookieValueOf(rotated)
    }
  }

  test('空 body + Cookie current：不轮换，同值重发 Cookie 并滑动 TTL', async () => {
    const { app, base, cookie } = await loginWithCookie()
    const before = onlySession(app)
    const hashBefore = before.refreshHash
    const expiresBefore = before.refreshExpiresAt
    await new Promise((resolve) => setTimeout(resolve, 5))

    const res = await refreshWithCookie(base, cookie, { origin: ORIGIN })
    assert.equal(res.status, 200)
    const body = (await res.json()) as Record<string, unknown>
    assert.equal('refreshToken' in body, false, 'Cookie source never returns a refresh')
    assert.equal(typeof body.accessToken, 'string')
    assert.equal(body.refreshCookie, true)
    assert.equal(cookieValueOf(res), cookie, 'the identical current value is re-sent')
    assertRefreshCookieAttributes(cookieOf(res), 60)

    const session = onlySession(app)
    assert.equal(session.refreshHash, hashBefore, 'Cookie refresh must not rotate')
    assert.equal(session.previousRefreshHash, undefined, 'no previous is recorded')
    assert.equal(session.graceUntil, undefined, 'no grace window is advanced')
    assert.ok(session.refreshExpiresAt > expiresBefore, 'refreshExpiresAt slides')
    assert.equal(tokensForSession(app, session.id), 1, 'no token was minted')
    assert.equal(session.revokedAt, null)
  })

  test('body=current + Cookie：原样回显、不轮换、同值重发并续期', async () => {
    const { app, base, cookie } = await loginWithCookie()
    const before = onlySession(app)
    const hashBefore = before.refreshHash
    const expiresBefore = before.refreshExpiresAt
    await new Promise((resolve) => setTimeout(resolve, 5))

    const res = await refreshWithCookie(base, cookie, { origin: ORIGIN }, { refreshToken: cookie })
    assert.equal(res.status, 200)
    const body = (await res.json()) as Record<string, unknown>
    assert.equal(body.refreshToken, cookie, 'the request value is echoed byte-for-byte')
    assert.equal(body.refreshCookie, true)
    assert.equal(cookieValueOf(res), cookie)

    const session = onlySession(app)
    assert.equal(session.refreshHash, hashBefore)
    assert.equal(session.previousRefreshHash, undefined)
    assert.equal(session.graceUntil, undefined)
    assert.ok(session.refreshExpiresAt > expiresBefore)
    assert.equal(tokensForSession(app, session.id), 1)
  })

  test('假 body + Cookie current：按空 body 处理，不返回 refresh', async () => {
    const { app, base, cookie } = await loginWithCookie()
    const before = onlySession(app)
    const hashBefore = before.refreshHash

    const res = await refreshWithCookie(
      base,
      cookie,
      { origin: ORIGIN },
      { refreshToken: 'forged-not-owned-by-this-session' }
    )
    assert.equal(res.status, 200)
    const body = (await res.json()) as Record<string, unknown>
    assert.equal('refreshToken' in body, false, 'a foreign body value is never echoed')
    assert.equal(body.refreshCookie, true)
    assert.equal(cookieValueOf(res), cookie)
    assert.equal(onlySession(app).refreshHash, hashBefore)
    assert.equal(onlySession(app).previousRefreshHash, undefined)
  })

  test('Cookie=previous（宽限内）：只发 access，不续期，不重发 Cookie', async () => {
    const { app, base, previous } = await seedPrevious()
    const session = onlySession(app)
    const expiresAfterRotation = session.refreshExpiresAt
    const hashAfterRotation = session.refreshHash

    const res = await refreshWithCookie(base, previous, { origin: ORIGIN })
    assert.equal(res.status, 200)
    const body = (await res.json()) as Record<string, unknown>
    assert.equal('refreshToken' in body, false)
    assert.equal(typeof body.accessToken, 'string')
    assert.equal(body.refreshCookie, undefined)
    assert.deepEqual(res.headers.getSetCookie(), [], 'grace must not re-send the Cookie')
    assert.equal(session.refreshHash, hashAfterRotation)
    assert.equal(session.refreshExpiresAt, expiresAfterRotation, 'grace must not renew')
    assert.equal(session.revokedAt, null)
  })

  test('body=previous（宽限内）+ Cookie current：原样回显、不续期', async () => {
    const { app, base, previous, cookie } = await seedPrevious()
    const session = onlySession(app)
    const expiresAfterRotation = session.refreshExpiresAt
    const hashAfterRotation = session.refreshHash

    const res = await refreshWithCookie(
      base,
      cookie,
      { origin: ORIGIN },
      { refreshToken: previous }
    )
    assert.equal(res.status, 200)
    const body = (await res.json()) as Record<string, unknown>
    assert.equal(body.refreshToken, previous, 'the previous value is echoed as sent')
    assert.equal(body.refreshCookie, undefined)
    assert.deepEqual(res.headers.getSetCookie(), [], 'previous must not re-send the Cookie')
    assert.equal(session.refreshHash, hashAfterRotation)
    assert.equal(session.refreshExpiresAt, expiresAfterRotation, 'previous must not renew')
    assert.equal(session.revokedAt, null)
  })

  test('graceMs=0：body=previous 在窗口外，401 并撤销 session', async () => {
    const { app, base, previous, cookie } = await seedPrevious({ refreshGraceMs: 0 })

    const reused = await refreshWithCookie(
      base,
      cookie,
      { origin: ORIGIN },
      { refreshToken: previous }
    )
    assert.equal(reused.status, 401)
    assert.equal(
      ((await reused.json()) as { error: { code: string } }).error.code,
      'SESSION_EXPIRED'
    )
    assert.match(cookieOf(reused), /Max-Age=0/)
    assert.ok(onlySession(app).revokedAt !== null)
  })

  test('3 个并发 Cookie 刷新：零轮换，无 session 撤销，同值 Cookie', async () => {
    const { app, base, cookie } = await loginWithCookie()
    const before = onlySession(app)
    const hashBefore = before.refreshHash
    const results = await Promise.all([
      refreshWithCookie(base, cookie, { origin: ORIGIN }),
      refreshWithCookie(base, cookie, { origin: ORIGIN }),
      refreshWithCookie(base, cookie, { origin: ORIGIN })
    ])
    for (const res of results) {
      assert.equal(res.status, 200)
      const body = (await res.json()) as Record<string, unknown>
      assert.equal('refreshToken' in body, false, 'all three return access only')
      assert.equal(body.refreshCookie, true)
      assert.equal(cookieValueOf(res), cookie, 'every response re-sends the same value')
    }

    const session = onlySession(app)
    assert.equal(session.revokedAt, null)
    assert.equal(tokensForSession(app, session.id), 1, 'no rotation happened')
    assert.equal(session.refreshHash, hashBefore)
    assert.equal(session.previousRefreshHash, undefined)
    assert.equal(session.graceUntil, undefined)
  })

  test('body 源 current（无 Cookie、同源）：唯一的新签 body refresh + Set-Cookie 例外', async () => {
    const { app, base } = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const first = (await (await login(base)).json()) as Record<string, unknown>
    const current = String(first.refreshToken)
    const session = onlySession(app)
    const beforeHash = session.refreshHash

    const res = await refresh(base, current, { origin: ORIGIN })
    assert.equal(res.status, 200)
    const body = (await res.json()) as Record<string, unknown>
    assert.equal(typeof body.refreshToken, 'string')
    assert.notEqual(body.refreshToken, current)
    assert.equal(body.refreshCookie, true)
    assert.notEqual(cookieValueOf(res), current)
    assert.notEqual(session.refreshHash, beforeHash)

    // The old value is now previous: inside grace it is echoed, never renewed.
    const expiresAfterRotation = session.refreshExpiresAt
    const hashAfterRotation = session.refreshHash
    const previous = await refresh(base, current, { origin: ORIGIN })
    assert.equal(previous.status, 200)
    const previousBody = (await previous.json()) as Record<string, unknown>
    assert.equal(previousBody.refreshToken, current)
    assert.equal(previousBody.refreshCookie, undefined)
    assert.equal(session.refreshHash, hashAfterRotation, 'previous must not rotate')
    assert.equal(session.refreshExpiresAt, expiresAfterRotation, 'previous must not renew')

    const fake = await refresh(base, 'fake-not-a-session-token', { origin: ORIGIN })
    assert.equal(fake.status, 401)
    assert.equal(((await fake.json()) as { error: { code: string } }).error.code, 'SESSION_EXPIRED')
  })

  test('CSRF：Cookie 认证下缺失/ null / 跨源 Origin 均 403 且无副作用', async () => {
    const { app, base, cookie } = await loginWithCookie()
    const session = onlySession(app)
    const hashBefore = session.refreshHash
    const expiresBefore = session.refreshExpiresAt

    const cases: Record<string, string>[] = [
      {},
      { origin: 'null' },
      { origin: 'https://evil.example' }
    ]
    for (const headers of cases) {
      const res = await refreshWithCookie(base, cookie, headers)
      assert.equal(res.status, 403, `expected 403 for ${JSON.stringify(headers)}`)
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'CSRF_REJECTED')
      assert.deepEqual(res.headers.getSetCookie(), [], 'CSRF must not clear the Cookie')
    }
    assert.equal(session.refreshHash, hashBefore, 'CSRF must not rotate')
    assert.equal(session.refreshExpiresAt, expiresBefore, 'CSRF must not renew')
    assert.equal(session.revokedAt, null, 'CSRF must not revoke')

    const wrongType = await fetch(`${base}/v1/auth/refresh`, {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        cookie: `orca_refresh=${cookie}`,
        'content-type': 'text/plain'
      },
      body: '{}'
    })
    assert.equal(wrongType.status, 403, 'a non-JSON body must be rejected too')
    assert.equal(session.refreshHash, hashBefore)

    // body-only refresh is not a Cookie-authenticated request: unchanged.
    const first = (await (await login(base)).json()) as Record<string, unknown>
    const bodyOnly = await refresh(base, String(first.refreshToken), {})
    assert.equal(bodyOnly.status, 200)
    const body = (await bodyOnly.json()) as Record<string, unknown>
    assert.equal(typeof body.refreshToken, 'string')
    assert.equal(body.refreshCookie, undefined)
  })

  test('Cookie 源 session 已撤销：401 SESSION_EXPIRED 并清 Cookie', async () => {
    const { app, base, cookie } = await loginWithCookie()
    const session = onlySession(app)
    session.revokedAt = Date.now()
    const res = await refreshWithCookie(base, cookie, { origin: ORIGIN })
    assert.equal(res.status, 401)
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'SESSION_EXPIRED')
    assert.match(cookieOf(res), /Max-Age=0/)
  })

  test('能力标记：登录/交接/刷新同源为 true，非浏览器与 never 省略', async () => {
    const { app, base } = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const loginSame = await login(base, { origin: ORIGIN })
    const loginBody = (await loginSame.json()) as Record<string, unknown>
    assert.equal(loginBody.refreshCookie, true)
    assert.equal('refreshToken' in loginBody, false)

    const loginScript = await login(base)
    const scriptBody = (await loginScript.json()) as Record<string, unknown>
    assert.equal(scriptBody.refreshCookie, undefined)

    const dev = app.store.usersByName.get('zhangsan')
    assert.ok(dev)
    app.store.webHandoffs.set('marker-code', {
      userId: dev.id,
      projectId: 'proj_payment',
      expiresAt: Date.now() + 60_000
    })
    const handoff = await fetch(`${base}/v1/web/handoff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ code: 'marker-code' })
    })
    const handoffBody = (await handoff.json()) as Record<string, unknown>
    assert.equal(handoffBody.refreshCookie, true)
    assert.equal('refreshToken' in handoffBody, false)

    const cookie = cookieValueOf(loginSame)
    const refreshed = await refreshWithCookie(base, cookie, { origin: ORIGIN })
    assert.equal(refreshed.status, 200)
    assert.equal(((await refreshed.json()) as Record<string, unknown>).refreshCookie, true)

    const never = await start({ cookieMode: 'never', publicOrigin: ORIGIN })
    const neverLogin = await login(never.base, { origin: ORIGIN })
    const neverBody = (await neverLogin.json()) as Record<string, unknown>
    assert.equal(neverBody.refreshCookie, undefined)
    assert.deepEqual(neverLogin.headers.getSetCookie(), [])
  })
})

describe('U218 登出撤销 / 多作用域清理 / Origin / 审计（真实 createApp + HTTP）', () => {
  async function cookieLogin(base: string, options: { headers?: Record<string, string> } = {}) {
    const res = await login(base, { origin: ORIGIN, ...options.headers })
    assert.equal(res.status, 200)
    return { res, cookie: cookieValueOf(res), body: (await res.json()) as Record<string, unknown> }
  }

  function allSessions(app: ApiHandle) {
    return [...app.store.sessions.values()]
  }

  function assertCleared(response: Response, expected: number): string[] {
    const headers = response.headers.getSetCookie()
    assert.equal(headers.length, expected, JSON.stringify(headers))
    for (const header of headers) {
      assert.match(header, /^orca_refresh=;/)
      assert.match(header, /Max-Age=0/)
      assert.match(header, /HttpOnly/)
      assert.match(header, /SameSite=Lax/)
    }
    return headers
  }

  test('AC7(a) Bearer 有效登出：撤销 Cookie session 并清三种作用域，重放刷新 401', async () => {
    const { app, base } = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const { cookie, body } = await cookieLogin(base)
    const session = onlySession(app)

    const logout = await fetch(`${base}/v1/auth/logout`, {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        authorization: `Bearer ${String(body.accessToken)}`,
        cookie: `orca_refresh=${cookie}`
      }
    })
    assert.equal(logout.status, 200)
    const headers = assertCleared(logout, 3)
    assert.ok(headers.some((header) => /^orca_refresh=; Path=\/v1\/auth;/.test(header)))
    assert.ok(headers.some((header) => /Domain=console\.example\.com/.test(header)))
    assert.ok(headers.some((header) => /^orca_refresh=; Path=\/;/.test(header)))
    assert.ok(session.revokedAt !== null, 'the Cookie session must be revoked')

    const replay = await refreshWithCookie(base, cookie, { origin: ORIGIN })
    assert.equal(replay.status, 401)
    assert.equal(
      ((await replay.json()) as { error: { code: string } }).error.code,
      'SESSION_EXPIRED'
    )
  })

  test('AC7(b) access 已过期 + Cookie 有效：登出仍清 Cookie 并撤销 session', async () => {
    const { app, base } = await start({
      cookieMode: 'auto',
      publicOrigin: ORIGIN,
      accessTtlMs: 200
    })
    const { cookie, body } = await cookieLogin(base)
    await new Promise((resolve) => setTimeout(resolve, 350))

    const logout = await fetch(`${base}/v1/auth/logout`, {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        authorization: `Bearer ${String(body.accessToken)}`,
        cookie: `orca_refresh=${cookie}`
      }
    })
    assert.equal(logout.status, 200)
    assertCleared(logout, 3)
    assert.ok(onlySession(app).revokedAt !== null)
    assert.equal((await refreshWithCookie(base, cookie, { origin: ORIGIN })).status, 401)
  })

  test('Bearer=A、Cookie=B 两个 session：登出两者均撤销', async () => {
    const { app, base } = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const a = await cookieLogin(base)
    const bRes = await login(base)
    assert.equal(bRes.status, 200)
    const b = (await bRes.json()) as Record<string, unknown>
    assert.equal(allSessions(app).length, 2)

    const logout = await fetch(`${base}/v1/auth/logout`, {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        authorization: `Bearer ${String(a.body.accessToken)}`,
        cookie: `orca_refresh=${String(b.refreshToken)}`
      }
    })
    assert.equal(logout.status, 200)
    for (const session of allSessions(app)) {
      assert.ok(session.revokedAt !== null, 'both the Bearer and Cookie sessions must be revoked')
    }
    const cookieB = String(b.refreshToken)
    assert.equal((await refreshWithCookie(base, cookieB, { origin: ORIGIN })).status, 401)
    const bearerA = await fetch(`${base}/v1/projects`, {
      headers: { authorization: `Bearer ${String(a.body.accessToken)}` }
    })
    assert.equal(bearerA.status, 401)
  })

  test('仅 Cookie（Bearer 缺失）登出也撤销 Cookie session', async () => {
    const { app, base } = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const { cookie } = await cookieLogin(base)
    const logout = await fetch(`${base}/v1/auth/logout`, {
      method: 'POST',
      headers: { origin: ORIGIN, cookie: `orca_refresh=${cookie}` }
    })
    assert.equal(logout.status, 200)
    assert.equal(allSessions(app)[0]?.revokedAt !== null, true)
    assert.equal((await refreshWithCookie(base, cookie, { origin: ORIGIN })).status, 401)
  })

  test('COOKIE_MODE=never 登出依旧清 Cookie（不依赖启用状态）', async () => {
    const { base } = await start({ cookieMode: 'never', publicOrigin: ORIGIN })
    const logout = await fetch(`${base}/v1/auth/logout`, { method: 'POST' })
    assert.equal(logout.status, 200)
    const headers = assertCleared(logout, 2)
    assert.ok(headers.some((header) => /^orca_refresh=; Path=\/v1\/auth;/.test(header)))
    assert.ok(headers.some((header) => /^orca_refresh=; Path=\/;/.test(header)))
  })

  test('AC15(f) 旧字面量 "undefined"：有 Cookie 不轮换不撤销，无 Cookie 401', async () => {
    const { app, base } = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const { cookie } = await cookieLogin(base)
    const session = onlySession(app)
    const hashBefore = session.refreshHash

    const withCookie = await refreshWithCookie(
      base,
      cookie,
      { origin: ORIGIN },
      { refreshToken: 'undefined' }
    )
    assert.equal(withCookie.status, 200)
    const body = (await withCookie.json()) as Record<string, unknown>
    assert.equal('refreshToken' in body, false)
    assert.equal(body.refreshCookie, true)
    assert.equal(session.refreshHash, hashBefore)
    assert.equal(session.revokedAt, null)

    const withoutCookie = await refresh(base, 'undefined', { origin: ORIGIN })
    assert.equal(withoutCookie.status, 401)
    assert.equal(
      ((await withoutCookie.json()) as { error: { code: string } }).error.code,
      'SESSION_EXPIRED'
    )
    assert.equal(session.revokedAt, null, 'an unknown literal must not revoke a live session')
  })

  test('AC15(b) 宿主跨源 handoff：新签 body refresh、无 Cookie、无 refreshCookie', async () => {
    const { app, base } = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const dev = app.store.usersByName.get('zhangsan')
    assert.ok(dev)
    app.store.webHandoffs.set('host-cross-code', {
      userId: dev.id,
      projectId: 'proj_payment',
      expiresAt: Date.now() + 60_000
    })
    const res = await fetch(`${base}/v1/web/handoff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://host.example' },
      body: JSON.stringify({ code: 'host-cross-code' })
    })
    assert.equal(res.status, 200)
    assert.deepEqual(res.headers.getSetCookie(), [], 'a cross-origin host never gets a Cookie')
    const body = (await res.json()) as Record<string, unknown>
    assert.equal(typeof body.refreshToken, 'string')
    assert.equal(body.refreshCookie, undefined)
    assert.equal(
      (await refresh(base, String(body.refreshToken), { origin: 'https://host.example' })).status,
      200
    )
  })

  test('AC15(d) COOKIE_MODE=never：handoff 保留新签 body refresh，无能力标记', async () => {
    const { app, base } = await start({ cookieMode: 'never', publicOrigin: ORIGIN })
    const dev = app.store.usersByName.get('zhangsan')
    assert.ok(dev)
    app.store.webHandoffs.set('never-code', {
      userId: dev.id,
      projectId: 'proj_payment',
      expiresAt: Date.now() + 60_000
    })
    const res = await fetch(`${base}/v1/web/handoff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ code: 'never-code' })
    })
    assert.equal(res.status, 200)
    assert.deepEqual(res.headers.getSetCookie(), [])
    const body = (await res.json()) as Record<string, unknown>
    assert.equal(typeof body.refreshToken, 'string')
    assert.equal(body.refreshCookie, undefined)
  })

  test('AC16 伪造 X-Forwarded-Proto / Host 不改变登录/交接/刷新形态', async () => {
    const { app, base } = await start({ cookieMode: 'always', publicOrigin: ORIGIN })
    const forged = { origin: ORIGIN, 'x-forwarded-proto': 'http', host: 'evil.example' }

    const loginRes = await login(base, forged)
    assert.equal(loginRes.status, 200)
    const loginBody = (await loginRes.json()) as Record<string, unknown>
    assert.equal(loginBody.refreshCookie, true)
    assert.equal('refreshToken' in loginBody, false)
    assert.match(cookieOf(loginRes), /Secure/)
    const session = onlySession(app)
    const hashBefore = session.refreshHash

    const dev = app.store.usersByName.get('zhangsan')
    assert.ok(dev)
    app.store.webHandoffs.set('forged-code', {
      userId: dev.id,
      projectId: 'proj_payment',
      expiresAt: Date.now() + 60_000
    })
    const handoffRes = await fetch(`${base}/v1/web/handoff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...forged },
      body: JSON.stringify({ code: 'forged-code' })
    })
    assert.equal(handoffRes.status, 200)
    assert.equal(((await handoffRes.json()) as Record<string, unknown>).refreshCookie, true)
    assert.match(cookieOf(handoffRes), /Secure/)

    const refreshRes = await refreshWithCookie(base, cookieValueOf(loginRes), forged)
    assert.equal(refreshRes.status, 200)
    const refreshBody = (await refreshRes.json()) as Record<string, unknown>
    assert.equal(refreshBody.refreshCookie, true)
    assert.equal('refreshToken' in refreshBody, false, 'Cookie-source refresh returns no token')
    assert.equal(session.refreshHash, hashBefore, 'forged XFP/Host must not rotate the session')
  })

  // Auto degrade warning is process-wide warnOnce, already fired by S1; it is
  // asserted in test/refresh-cookie.test.ts, not here.
  test('AC16 启动矩阵：always 无 origin 拒启，auto 降级 never（告警断言见 S1）', () => {
    assert.throws(
      () =>
        createApp({
          port: 0,
          internalToken: 'u218-matrix',
          cookieMode: 'always',
          publicOrigin: ''
        }),
      /requires a valid ORCA_CLOUD_PUBLIC_ORIGIN/
    )
    const auto = createApp({
      port: 0,
      internalToken: 'u218-matrix',
      cookieMode: 'auto',
      publicOrigin: ''
    })
    apps.push(auto)
  })

  test('AC5 body 源并发：current 只轮换一次，previous 宽限命中', async () => {
    const { app, base } = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const first = (await (await login(base)).json()) as Record<string, unknown>
    const current = String(first.refreshToken)
    const session = onlySession(app)
    const beforeHash = session.refreshHash

    const [a, b] = await Promise.all([refresh(base, current), refresh(base, current)])
    for (const res of [a, b]) assert.equal(res.status, 200)
    const bodies = (await Promise.all([a.json(), b.json()])) as Record<string, unknown>[]
    const rotated = bodies.filter(
      (body) => body.refreshToken !== undefined && body.refreshToken !== current
    )
    assert.equal(rotated.length, 1, 'exactly one request rotates')
    assert.equal(
      bodies.filter((body) => body.refreshToken === current).length,
      1,
      'the loser echoes the previous value inside grace'
    )
    assert.notEqual(session.refreshHash, beforeHash)
    assert.ok(session.previousRefreshHash !== undefined)
    assert.ok(session.graceUntil !== undefined && session.graceUntil > Date.now())
    assert.equal(tokensForSession(app, session.id), 2, 'one old + one new token only')
    assert.equal(session.revokedAt, null)
  })

  test('grace / reuse 审计事件只记录来源，不含 token', async () => {
    const { app, base } = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const first = (await (await login(base)).json()) as Record<string, unknown>
    const previous = String(first.refreshToken)
    const session = onlySession(app)

    // Body source current rotates once and sets the Cookie; the old value is
    // now `previous` inside the grace window.
    const rotated = await refresh(base, previous, { origin: ORIGIN })
    assert.equal(rotated.status, 200)
    const current = String(((await rotated.json()) as Record<string, unknown>).refreshToken)
    const cookie = cookieValueOf(rotated)

    const grace = await refreshWithCookie(
      base,
      cookie,
      { origin: ORIGIN },
      { refreshToken: previous }
    )
    assert.equal(grace.status, 200)
    const graceEvents = app.store.audit.filter(
      (event) => event.eventType === 'refresh.grace_reuse' && event.targetId === session.id
    )
    assert.equal(graceEvents.length, 1, 'the Cookie-current + previous-body hit is audited once')
    assert.deepEqual(graceEvents[0]?.metadata, { source: 'body' })

    // Outside the window the same shape revokes and audits reuse_detected.
    session.graceUntil = Date.now() - 1
    const reuse = await refreshWithCookie(
      base,
      cookie,
      { origin: ORIGIN },
      { refreshToken: previous }
    )
    assert.equal(reuse.status, 401)
    const reuseEvents = app.store.audit.filter(
      (event) => event.eventType === 'refresh.reuse_detected' && event.targetId === session.id
    )
    assert.equal(reuseEvents.length, 1)
    assert.deepEqual(reuseEvents[0]?.metadata, { source: 'cookie' })
    assert.ok(session.revokedAt !== null)

    const serialized = JSON.stringify(app.store.audit)
    for (const token of [previous, current, cookie]) {
      assert.equal(serialized.includes(token), false, 'audit metadata must never carry a token')
    }
  })

  test('U220 N1: COOKIE_MODE=never 下无 Origin + 旧 Cookie 的登录/交接仍按旧契约成功', async () => {
    const { app, base } = await start({ cookieMode: 'never', publicOrigin: ORIGIN })
    const stale = { cookie: 'orca_refresh=stale-from-earlier-deployment' }

    const loginRes = await login(base, stale)
    assert.equal(loginRes.status, 200)
    assert.deepEqual(loginRes.headers.getSetCookie(), [], 'never must not touch the stale Cookie')
    const loginBody = (await loginRes.json()) as Record<string, unknown>
    assert.equal(typeof loginBody.refreshToken, 'string')

    const dev = app.store.usersByName.get('zhangsan')
    assert.ok(dev)
    app.store.webHandoffs.set('never-stale-code', {
      userId: dev.id,
      projectId: 'proj_payment',
      expiresAt: Date.now() + 60_000
    })
    const handoffRes = await fetch(`${base}/v1/web/handoff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...stale },
      body: JSON.stringify({ code: 'never-stale-code' })
    })
    assert.equal(handoffRes.status, 200)
    assert.deepEqual(handoffRes.headers.getSetCookie(), [])
    assert.equal(
      typeof ((await handoffRes.json()) as Record<string, unknown>).refreshToken,
      'string'
    )

    // A Cookie-less script login is unaffected.
    const scriptRes = await login(base)
    assert.equal(scriptRes.status, 200)
    assert.equal(
      typeof ((await scriptRes.json()) as Record<string, unknown>).refreshToken,
      'string'
    )
  })

  test('U220 N3: IP 字面量 PUBLIC_ORIGIN 的清除头无 Domain，域名仍三条', async () => {
    for (const publicOrigin of ['http://127.0.0.1:18787', 'http://[::1]:18787']) {
      const { base } = await start({ cookieMode: 'auto', publicOrigin })
      const res = await fetch(`${base}/v1/auth/logout`, { method: 'POST' })
      assert.equal(res.status, 200)
      const headers = res.headers.getSetCookie()
      assert.equal(headers.length, 2, `${publicOrigin}: ${JSON.stringify(headers)}`)
      for (const header of headers) assert.doesNotMatch(header, /Domain=/)
      assert.ok(headers.some((header) => /^orca_refresh=; Path=\/v1\/auth;/.test(header)))
      assert.ok(headers.some((header) => /^orca_refresh=; Path=\/;/.test(header)))
    }

    const { base } = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const domainRes = await fetch(`${base}/v1/auth/logout`, { method: 'POST' })
    assert.equal(domainRes.headers.getSetCookie().length, 3)
    assert.ok(
      domainRes.headers.getSetCookie().some((header) => /Domain=console\.example\.com/.test(header))
    )
  })

  test('U220 N2: access 过期 + Cookie 登出补一条 logout 审计，Bearer 登出不重复', async () => {
    const { app, base } = await start({
      cookieMode: 'auto',
      publicOrigin: ORIGIN,
      accessTtlMs: 200
    })
    const { cookie, body } = await cookieLogin(base)
    const session = onlySession(app)
    const user = app.store.users.get(session.userId)
    assert.ok(user)
    await new Promise((resolve) => setTimeout(resolve, 350))

    const cookieOnly = await fetch(`${base}/v1/auth/logout`, {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        authorization: `Bearer ${String(body.accessToken)}`,
        cookie: `orca_refresh=${cookie}`
      }
    })
    assert.equal(cookieOnly.status, 200)
    assert.ok(session.revokedAt !== null)

    const cookieLogoutEvents = app.store.audit.filter((event) => event.eventType === 'logout')
    assert.equal(cookieLogoutEvents.length, 1, 'Cookie-only logout must be audited exactly once')
    const [cookieEvent] = cookieLogoutEvents
    assert.ok(cookieEvent)
    assert.equal(cookieEvent.actor, user.username)
    assert.equal(cookieEvent.targetId, session.id)
    assert.equal(JSON.stringify(cookieEvent.metadata ?? {}).includes(cookie), false)

    // The normal Bearer path still writes exactly one event, not two.
    const second = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const bearerLogin = await cookieLogin(second.base)
    const bearerLogout = await fetch(`${second.base}/v1/auth/logout`, {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        authorization: `Bearer ${String(bearerLogin.body.accessToken)}`,
        cookie: `orca_refresh=${bearerLogin.cookie}`
      }
    })
    assert.equal(bearerLogout.status, 200)
    assert.equal(
      second.app.store.audit.filter((event) => event.eventType === 'logout').length,
      1,
      'Bearer logout must not also emit the Cookie-only event'
    )
  })
})

describe('U233 认证端点边界（真实 createApp + HTTP）', () => {
  const duplicateCookie = 'orca_refresh=a; orca_refresh=b'

  function assertClears(response: Response): void {
    const headers = response.headers.getSetCookie()
    assert.equal(headers.length, 3, JSON.stringify(headers))
    assert.ok(headers.some((header) => header.startsWith('orca_refresh=; Path=/v1/auth;')))
    assert.ok(headers.some((header) => /Domain=console\.example\.com/.test(header)))
    assert.ok(headers.some((header) => header.startsWith('orca_refresh=; Path=/;')))
    for (const header of headers) {
      assert.match(header, /Max-Age=0/)
    }
  }

  test('F1 重复 Cookie + 有效 Bearer：401 仍撤销显式会话，旧 access/refresh 立即 401', async () => {
    const { app, base } = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const first = (await (await login(base)).json()) as Record<string, unknown>
    const accessToken = String(first.accessToken)
    const refreshToken = String(first.refreshToken)
    const session = onlySession(app)

    const res = await fetch(`${base}/v1/auth/logout`, {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        authorization: `Bearer ${accessToken}`,
        cookie: duplicateCookie
      }
    })
    assert.equal(res.status, 401)
    assert.equal(
      ((await res.json()) as { error?: { code?: string } }).error?.code,
      'SESSION_EXPIRED'
    )
    assertClears(res)
    assert.ok(session.revokedAt !== null, 'the explicit Bearer session must be revoked')

    const renewed = await refresh(base, refreshToken)
    assert.equal(renewed.status, 401, 'the old refresh must fail immediately')
    const me = await fetch(`${base}/v1/me`, {
      headers: { authorization: `Bearer ${accessToken}` }
    })
    assert.equal(me.status, 401, 'the old access token must fail immediately')
  })

  test('F1 重复 Cookie + body refresh：401 且 body 定位的会话撤销', async () => {
    const { app, base } = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const first = (await (await login(base)).json()) as Record<string, unknown>
    const refreshToken = String(first.refreshToken)
    const session = onlySession(app)

    const res = await fetch(`${base}/v1/auth/logout`, {
      method: 'POST',
      headers: { origin: ORIGIN, cookie: duplicateCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken })
    })
    assert.equal(res.status, 401)
    assertClears(res)
    assert.ok(session.revokedAt !== null, 'the body refresh must locate and revoke the session')
    assert.equal((await refresh(base, refreshToken)).status, 401)
  })

  test('F1 仅重复 Cookie：401 且不猜测撤销任何会话', async () => {
    const { app, base } = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const first = (await (await login(base)).json()) as Record<string, unknown>
    const refreshToken = String(first.refreshToken)
    const session = onlySession(app)

    const res = await fetch(`${base}/v1/auth/logout`, {
      method: 'POST',
      headers: { origin: ORIGIN, cookie: duplicateCookie }
    })
    assert.equal(res.status, 401)
    assertClears(res)
    assert.equal(session.revokedAt, null, 'an ambiguous Cookie must not be guessed at')
    assert.equal((await refresh(base, refreshToken)).status, 200)
  })

  test('F2 单 Cookie 无 Origin：登录/交接 401 且清三种作用域', async () => {
    const { app, base } = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const staleCookie = { cookie: 'orca_refresh=stale-u233' }

    const loginRes = await login(base, staleCookie)
    assert.equal(loginRes.status, 401)
    assertClears(loginRes)

    const dev = app.store.usersByName.get('zhangsan')
    assert.ok(dev)
    app.store.webHandoffs.set('u233-no-origin', {
      userId: dev.id,
      projectId: 'proj_payment',
      expiresAt: Date.now() + 60_000
    })
    const handoffRes = await fetch(`${base}/v1/web/handoff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...staleCookie },
      body: JSON.stringify({ code: 'u233-no-origin' })
    })
    assert.equal(handoffRes.status, 401)
    assertClears(handoffRes)
    assert.equal(app.store.webHandoffs.has('u233-no-origin'), true)
  })

  test('刷新未知 Cookie + 有效 body current：200 轮换 + 单条 Set-Cookie', async () => {
    const { base } = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const first = (await (await login(base)).json()) as Record<string, unknown>
    const refreshToken = String(first.refreshToken)

    const res = await refresh(base, refreshToken, {
      origin: ORIGIN,
      cookie: 'orca_refresh=unknown-u233'
    })
    assert.equal(res.status, 200)
    const cookies = res.headers.getSetCookie()
    assert.equal(cookies.length, 1, JSON.stringify(cookies))
    assert.match(cookies[0] ?? '', /^orca_refresh=[A-Za-z0-9_-]+;/)
    const body = (await res.json()) as Record<string, unknown>
    assert.equal(typeof body.refreshToken, 'string')
    assert.notEqual(body.refreshToken, refreshToken)
  })

  test('刷新禁用用户 + 缺失/异源 Origin：403 且会话不撤销（CSRF 先于撤销）', async () => {
    const { app, base } = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const loginRes = await login(base, { origin: ORIGIN })
    assert.equal(loginRes.status, 200)
    const cookie = cookieValueOf(loginRes)
    const session = onlySession(app)
    const user = app.store.users.get(session.userId)
    assert.ok(user)
    user.status = 'disabled'

    const missingOrigin = await fetch(`${base}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `orca_refresh=${cookie}` },
      body: '{}'
    })
    assert.equal(missingOrigin.status, 403)

    const foreignOrigin = await fetch(`${base}/v1/auth/refresh`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://evil.example',
        cookie: `orca_refresh=${cookie}`
      },
      body: '{}'
    })
    assert.equal(foreignOrigin.status, 403)
    assert.equal(session.revokedAt, null, 'CSRF rejection must not revoke')
    assert.equal(
      app.store.audit.some((event) => event.eventType === 'logout'),
      false,
      'CSRF rejection must not log a revocation'
    )
  })

  test('登出禁用用户仅 Cookie：200 且撤销', async () => {
    const { app, base } = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const loginRes = await login(base, { origin: ORIGIN })
    assert.equal(loginRes.status, 200)
    const cookie = cookieValueOf(loginRes)
    const session = onlySession(app)
    const user = app.store.users.get(session.userId)
    assert.ok(user)
    user.status = 'disabled'

    const res = await fetch(`${base}/v1/auth/logout`, {
      method: 'POST',
      headers: { origin: ORIGIN, cookie: `orca_refresh=${cookie}` }
    })
    assert.equal(res.status, 200)
    assert.ok(session.revokedAt !== null)
  })
})

describe('U235 非对象 refresh body（真实 createApp + HTTP）', () => {
  // JSON.parse can yield these at runtime despite the declared object type.
  const nonObjectBodies = ['null', '42', '"x"', '[]']

  function refreshRaw(
    base: string,
    rawBody: string,
    headers: Record<string, string> = {}
  ): Promise<Response> {
    return fetch(`${base}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: rawBody
    })
  }

  for (const rawBody of nonObjectBodies) {
    test(`Cookie 源 body=${rawBody}：按空 body 处理，200 且不回显 refresh`, async () => {
      const { app, base } = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
      const loginRes = await login(base, { origin: ORIGIN })
      assert.equal(loginRes.status, 200)
      const cookie = cookieValueOf(loginRes)
      const session = onlySession(app)
      const hashBefore = session.refreshHash

      const res = await refreshRaw(base, rawBody, {
        origin: ORIGIN,
        cookie: `orca_refresh=${cookie}`
      })
      assert.equal(res.status, 200)
      const body = (await res.json()) as Record<string, unknown>
      assert.equal('refreshToken' in body, false, 'a non-object body has no refresh to echo')
      assert.equal(typeof body.accessToken, 'string')
      assert.equal(cookieValueOf(res), cookie)
      assert.equal(onlySession(app).refreshHash, hashBefore, 'the Cookie source must not rotate')
    })

    test(`无 Cookie body=${rawBody}：按无 refresh 值处理，401 而不是 500`, async () => {
      const { app, base } = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
      const first = (await (await login(base)).json()) as Record<string, unknown>
      const validToken = String(first.refreshToken)
      assert.equal(typeof first.refreshToken, 'string')

      const res = await refreshRaw(base, rawBody)
      assert.equal(res.status, 401)
      assert.equal(
        ((await res.json()) as { error: { code: string } }).error.code,
        'SESSION_EXPIRED'
      )
      assert.equal(onlySession(app).revokedAt, null, 'an empty value must not guess a session')

      const valid = await refresh(base, validToken)
      assert.equal(valid.status, 200, 'a valid body still refreshes')
      const validBody = (await valid.json()) as Record<string, unknown>
      assert.equal(typeof validBody.refreshToken, 'string')
    })
  }
})
