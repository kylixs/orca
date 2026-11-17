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
}): Promise<Started> {
  const app = createApp({
    port: 0,
    accessTtlMs: 60_000,
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
