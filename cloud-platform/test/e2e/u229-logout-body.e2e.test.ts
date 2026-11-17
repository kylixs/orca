import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp, type ApiHandle } from '../../apps/api/src/server.ts'

/**
 * U229 F10: a legacy client has no Cookie, and by the time it signs out its
 * access token may already be expired. The logout body is then the only server
 * side locator for the session, so it must be honoured without weakening any
 * of the existing Bearer/Cookie semantics.
 */

const ORIGIN = 'https://console.example.com'
const apps: ApiHandle[] = []

type Started = { app: ApiHandle; base: string }

async function start(options: {
  accessTtlMs?: number
  refreshTtlMs?: number
  cookieMode?: string
  publicOrigin?: string
} = {}): Promise<Started> {
  const app = createApp({
    port: 0,
    accessTtlMs: options.accessTtlMs ?? 60_000,
    refreshTtlMs: options.refreshTtlMs ?? 60_000,
    internalToken: 'u229-f10',
    cookieMode: options.cookieMode ?? 'never',
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
    body: JSON.stringify({ username, password, deviceName: 'u229-f10' })
  })
}

function refresh(base: string, refreshToken: string): Promise<Response> {
  return fetch(`${base}/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken })
  })
}

function logout(
  base: string,
  options: { headers?: Record<string, string>; body?: unknown } = {}
): Promise<Response> {
  const headers = { ...options.headers }
  const init: RequestInit = { method: 'POST', headers }
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
    init.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
  }
  return fetch(`${base}/v1/auth/logout`, init)
}

function authOf(body: Record<string, unknown>): string {
  assert.equal(typeof body.accessToken, 'string')
  return String(body.accessToken)
}

function refreshOf(body: Record<string, unknown>): string {
  assert.equal(typeof body.refreshToken, 'string')
  return String(body.refreshToken)
}

function sessions(app: ApiHandle) {
  return [...app.store.sessions.values()]
}

function logoutEvents(app: ApiHandle) {
  return app.store.audit.filter((event) => event.eventType === 'logout')
}

after(async () => {
  await Promise.all(apps.map((app) => app.close()))
})

describe('U229 F10 legacy 登出携带 refreshToken（真实 createApp + HTTP）', () => {
  test('access 过期 + 无 Cookie + body refresh：200 且会话撤销，旧 refresh 刷新 401', async () => {
    const { app, base } = await start({ accessTtlMs: 200 })
    const loginRes = await login(base)
    assert.equal(loginRes.status, 200)
    const first = (await loginRes.json()) as Record<string, unknown>
    const expiredAccess = authOf(first)
    const refreshToken = refreshOf(first)
    const session = sessions(app)[0]
    assert.ok(session)

    await new Promise((resolve) => setTimeout(resolve, 350))

    const res = await logout(base, {
      headers: { authorization: `Bearer ${expiredAccess}` },
      body: { refreshToken }
    })
    assert.equal(res.status, 200)
    assert.ok(session.revokedAt !== null, 'the body refresh must locate and revoke the session')
    assert.equal((await refresh(base, refreshToken)).status, 401, 'the revoked session cannot renew')
  })

  test('同场景不带 body：仍 200，但不撤销（现状由客户端负责携带）', async () => {
    const { app, base } = await start({ accessTtlMs: 200 })
    const first = (await (await login(base)).json()) as Record<string, unknown>
    const expiredAccess = authOf(first)
    const refreshToken = refreshOf(first)
    const session = sessions(app)[0]
    assert.ok(session)

    await new Promise((resolve) => setTimeout(resolve, 350))

    // Pinned current behaviour: the server has no locator here, so it stays
    // idempotent but cannot revoke. U229's client fix supplies the body token.
    const res = await logout(base, { headers: { authorization: `Bearer ${expiredAccess}` } })
    assert.equal(res.status, 200)
    assert.equal(session.revokedAt, null)
    assert.equal((await refresh(base, refreshToken)).status, 200)
  })

  test('伪造 refresh：200、不撤销任何会话，并写不含 token 的 denied 审计', async () => {
    const { app, base } = await start({ accessTtlMs: 200 })
    const first = (await (await login(base)).json()) as Record<string, unknown>
    const expiredAccess = authOf(first)
    const refreshToken = refreshOf(first)
    const forged = 'forged-u229-f10-not-a-session'
    const session = sessions(app)[0]
    assert.ok(session)
    await new Promise((resolve) => setTimeout(resolve, 350))

    const forgedRes = await logout(base, {
      headers: { authorization: `Bearer ${expiredAccess}` },
      body: { refreshToken: forged }
    })
    assert.equal(forgedRes.status, 200)
    assert.equal(session.revokedAt, null, 'an unknown value must not revoke')

    const denied = logoutEvents(app).filter((event) => event.result === 'denied')
    assert.equal(denied.length, 1)
    assert.equal(denied[0]?.actor, null)
    assert.deepEqual(denied[0]?.metadata, { reason: 'UNKNOWN_REFRESH' })
    assert.equal(JSON.stringify(app.store.audit).includes(forged), false)

    // Control: the real token on the same route does revoke.
    const validRes = await logout(base, { body: { refreshToken } })
    assert.equal(validRes.status, 200)
    assert.ok(session.revokedAt !== null)
    assert.equal((await refresh(base, refreshToken)).status, 401)
  })

  test('Bearer 有效 + body 携带另一 session 的 refresh：两个 session 都撤销（U218 双凭证语义）', async () => {
    const { app, base } = await start()
    const a = (await (await login(base)).json()) as Record<string, unknown>
    const b = (await (await login(base)).json()) as Record<string, unknown>
    assert.equal(sessions(app).length, 2)
    const [aSession, bSession] = sessions(app)
    assert.ok(aSession)
    assert.ok(bSession)

    const res = await logout(base, {
      headers: { authorization: `Bearer ${authOf(a)}` },
      body: { refreshToken: refreshOf(b) }
    })
    assert.equal(res.status, 200)
    assert.ok(aSession.revokedAt !== null)
    assert.ok(bSession.revokedAt !== null)
    assert.equal((await refresh(base, refreshOf(a))).status, 401)
    assert.equal((await refresh(base, refreshOf(b))).status, 401)
    // One event per revoked session, never repeated for the same target.
    assert.equal(logoutEvents(app).filter((event) => event.result === 'success').length, 2)
  })

  test('容错 body：非 JSON / 空 body / 超大数据均 200，超大数据按无 body 处理', async () => {
    const { app, base } = await start({ accessTtlMs: 60_000 })
    const first = (await (await login(base)).json()) as Record<string, unknown>
    const access = authOf(first)
    const session = sessions(app)[0]
    assert.ok(session)

    // Malformed JSON still revokes through a valid Bearer and never 400/500.
    const malformed = await logout(base, {
      headers: { authorization: `Bearer ${access}` },
      body: 'not-json{'
    })
    assert.equal(malformed.status, 200)
    assert.ok(session.revokedAt !== null)

    // Oversized but well-formed JSON is treated as no body: it must not revoke.
    const second = (await (await login(base)).json()) as Record<string, unknown>
    const secondSession = sessions(app).find((candidate) => candidate.revokedAt === null)
    assert.ok(secondSession)
    const oversized = JSON.stringify({
      refreshToken: refreshOf(second),
      pad: 'x'.repeat(17 * 1024)
    })
    const largeRes = await logout(base, { body: oversized })
    assert.equal(largeRes.status, 200)
    assert.equal(secondSession.revokedAt, null)
    assert.equal((await refresh(base, refreshOf(second))).status, 200)

    // No body at all stays idempotent.
    assert.equal((await logout(base)).status, 200)
  })
})

describe('U232 非对象登出 body 视为空 body（真实 createApp + HTTP）', () => {
  // Raw JSON literals, not stringified objects: JSON.parse can return null or a
  // scalar, so dereferencing body.refreshToken must not become a 500.
  for (const raw of ['null', '42', '"x"', '[]']) {
    test(`body=${raw}：200，有效 Bearer 仍撤销且不写 denied 审计`, async () => {
      const { app, base } = await start()
      const first = (await (await login(base)).json()) as Record<string, unknown>
      const access = authOf(first)
      const refreshToken = refreshOf(first)
      const session = sessions(app)[0]
      assert.ok(session)

      const res = await logout(base, {
        headers: { authorization: `Bearer ${access}` },
        body: raw
      })
      assert.equal(res.status, 200)
      assert.ok(session.revokedAt !== null)
      assert.equal((await refresh(base, refreshToken)).status, 401)
      assert.equal(logoutEvents(app).filter((event) => event.result === 'denied').length, 0)
    })
  }

  test('无 Bearer/Cookie 且 body=null：200，不撤销任何会话', async () => {
    const { app, base } = await start()
    const first = (await (await login(base)).json()) as Record<string, unknown>
    const refreshToken = refreshOf(first)
    const session = sessions(app)[0]
    assert.ok(session)

    const res = await logout(base, { body: 'null' })
    assert.equal(res.status, 200)
    assert.equal(session.revokedAt, null)
    assert.equal((await refresh(base, refreshToken)).status, 200)
  })
})

describe('U229 F10 Cookie 模式回归（真实 createApp + HTTP）', () => {
  async function cookieLogin(base: string) {
    const res = await login(base, { origin: ORIGIN })
    assert.equal(res.status, 200)
    const cookie = /^orca_refresh=([A-Za-z0-9_-]+);/.exec(res.headers.getSetCookie()[0] ?? '')
    assert.ok(cookie)
    return {
      cookie: cookie[1] ?? '',
      body: (await res.json()) as Record<string, unknown>
    }
  }

  test('U233 F1 重复 Cookie + body refresh：登出仍硬 401 并清理，但 body 会话撤销', async () => {
    const { app, base } = await start({
      cookieMode: 'auto',
      publicOrigin: ORIGIN,
      accessTtlMs: 200
    })
    const { cookie } = await cookieLogin(base)
    const session = sessions(app)[0]
    assert.ok(session)

    const res = await logout(base, {
      headers: { origin: ORIGIN, cookie: `orca_refresh=a; orca_refresh=b` },
      body: { refreshToken: cookie }
    })
    assert.equal(res.status, 401)
    const headers = res.headers.getSetCookie()
    assert.equal(headers.length, 3)
    for (const header of headers) assert.match(header, /Max-Age=0/)
    assert.ok(session.revokedAt !== null, 'the explicit body refresh must still be revoked')
    assert.equal((await refresh(base, cookie)).status, 401)
  })

  test('Cookie 登出：清三种作用域并撤销，Cookie 刷新 401', async () => {
    const { app, base } = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const { cookie } = await cookieLogin(base)
    const session = sessions(app)[0]
    assert.ok(session)

    const res = await logout(base, { headers: { origin: ORIGIN, cookie: `orca_refresh=${cookie}` } })
    assert.equal(res.status, 200)
    const headers = res.headers.getSetCookie()
    assert.equal(headers.length, 3)
    assert.ok(headers.some((header) => header.startsWith('orca_refresh=; Path=/v1/auth;')))
    assert.ok(headers.some((header) => /Domain=console\.example\.com/.test(header)))
    assert.ok(headers.some((header) => header.startsWith('orca_refresh=; Path=/;')))
    assert.ok(session.revokedAt !== null)

    const replay = await fetch(`${base}/v1/auth/refresh`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json', cookie: `orca_refresh=${cookie}` },
      body: '{}'
    })
    assert.equal(replay.status, 401)
  })

  test('Bearer=A、Cookie=B：两个 session 都撤销（U218 保持不变）', async () => {
    const { app, base } = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const a = await cookieLogin(base)
    const b = (await (await login(base)).json()) as Record<string, unknown>
    assert.equal(sessions(app).length, 2)

    const res = await logout(base, {
      headers: {
        origin: ORIGIN,
        authorization: `Bearer ${authOf(a.body)}`,
        cookie: `orca_refresh=${refreshOf(b)}`
      }
    })
    assert.equal(res.status, 200)
    for (const session of sessions(app)) assert.ok(session.revokedAt !== null)
  })
})

describe('U233 F5 登出审计 best-effort（真实 createApp + HTTP）', () => {
  test('Bearer 目标审计写入失败：仍 200，且会话已撤销', async () => {
    const { app, base } = await start()
    const first = (await (await login(base)).json()) as Record<string, unknown>
    const accessToken = authOf(first)
    const refreshToken = refreshOf(first)
    const session = sessions(app)[0]
    assert.ok(session)

    app.audit.append = () => {
      throw new Error('audit sink down')
    }

    const res = await logout(base, {
      headers: { authorization: `Bearer ${accessToken}` },
      body: { refreshToken }
    })
    assert.equal(res.status, 200, 'an audit failure must not turn sign-out into 500')
    assert.ok(session.revokedAt !== null)
    assert.equal((await refresh(base, refreshToken)).status, 401)
  })
})
