import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { createApp, type ApiHandle } from '../../apps/api/src/server.ts'

/**
 * U241 ①: the logout revocation loop used to revoke unconditionally, so a
 * session already revoked by a concurrent disabled refresh got a second epoch
 * bump and a second `logout/success` event. Logout must be idempotent per
 * session while still clearing the Cookie and returning 200.
 */

const ORIGIN = 'https://console.u241.example'
const apps: ApiHandle[] = []

async function start(makeBarrier: () => () => Promise<void>): Promise<{
  app: ApiHandle
  base: string
}> {
  const app = createApp({
    port: 0,
    accessTtlMs: 60_000,
    refreshTtlMs: 60_000,
    internalToken: 'u241-token',
    cookieMode: 'auto',
    beforeDisabledSessionRevoke: makeBarrier(),
    publicOrigin: ORIGIN
  })
  apps.push(app)
  const port = await app.listen()
  return { app, base: `http://127.0.0.1:${port}` }
}

/** `blocked` resolves once the disabled revoke reaches the barrier. */
function barrier(): {
  before: () => Promise<void>
  blocked: Promise<void>
  release: () => void
} {
  let release: () => void = () => {}
  let blockedResolve: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const blocked = new Promise<void>((resolve) => {
    blockedResolve = resolve
  })
  return {
    before: async () => {
      blockedResolve()
      await gate
    },
    blocked,
    release: () => release()
  }
}

async function login(base: string, username = 'admin'): Promise<{
  accessToken: string
  cookie: string
  userId: string
}> {
  const res = await fetch(`${base}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ username, password: 'Adm1n!', deviceName: 'u241' })
  })
  assert.equal(res.status, 200)
  const body = (await res.json()) as { accessToken?: string }
  assert.equal(typeof body.accessToken, 'string')
  const match = /^orca_refresh=([A-Za-z0-9_-]+);/.exec(res.headers.getSetCookie()[0] ?? '')
  assert.ok(match, 'cookieMode auto must issue a refresh Cookie')
  return {
    accessToken: String(body.accessToken),
    cookie: match[1] ?? '',
    userId: String(body.user?.id ?? '')
  }
}

function refreshCookie(base: string, cookie: string): Promise<Response> {
  return fetch(`${base}/v1/auth/refresh`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: ORIGIN,
      cookie: `orca_refresh=${cookie}`
    },
    body: '{}'
  })
}

function logout(
  base: string,
  accessToken: string,
  body?: Record<string, unknown>
): Promise<Response> {
  return fetch(`${base}/v1/auth/logout`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${accessToken}`
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
}

/** A disabled user's Bearer no longer resolves, so logout locates via Cookie. */
function logoutCookie(base: string, cookie: string): Promise<Response> {
  return fetch(`${base}/v1/auth/logout`, {
    method: 'POST',
    headers: { origin: ORIGIN, cookie: `orca_refresh=${cookie}` }
  })
}

/**
 * Sends the logout headers plus a partial JSON body and holds the rest until
 * `finish()`. The handler cannot reach its revocation loop while the body is
 * incomplete, which lets the disabled refresh revoke first deterministically.
 */
function stalledLogout(
  base: string,
  cookie: string
): { finish: () => void; response: Promise<{ status: number; setCookie: string[] }> } {
  const req = request(`${base}/v1/auth/logout`, {
    method: 'POST',
    headers: { cookie: `orca_refresh=${cookie}`, 'content-type': 'application/json' }
  })
  const response = new Promise<{ status: number; setCookie: string[] }>((resolve, reject) => {
    req.on('response', (res) => {
      res.resume()
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, setCookie: res.headers['set-cookie'] ?? [] })
      )
    })
    req.on('error', reject)
  })
  req.write('{')
  return { finish: () => req.end('}'), response }
}

function activeSession(app: ApiHandle) {
  const session = [...app.store.sessions.values()].find((entry) => entry.revokedAt === null)
  assert.ok(session, 'login must leave a live session')
  return session
}

after(async () => {
  await Promise.all(apps.map((app) => app.close()))
})

describe('U241 ① 登出撤销幂等（真实 createApp + HTTP）', () => {
  test('禁用刷新先撤销、登出后到：epoch 只 +1，成功审计 0，禁用 denied 1 条', async () => {
    const gate = barrier()
    const { app, base } = await start(() => gate.before)
    const { cookie } = await login(base)
    const session = activeSession(app)
    const user = app.store.users.get(session.userId)
    assert.ok(user)
    user.status = 'disabled'

    const disabledRefresh = refreshCookie(base, cookie)
    await gate.blocked
    const stalled = stalledLogout(base, cookie)
    // The held body proves the revoke cannot have happened yet; release the
    // disabled path so it owns the first (and only) revocation.
    gate.release()
    const disabledRes = await disabledRefresh
    stalled.finish()
    const logoutRes = await stalled.response

    assert.equal(disabledRes.status, 401, 'a disabled account must not renew')
    assert.equal(logoutRes.status, 200, 'logout stays 200 for an already revoked session')
    assert.ok(
      logoutRes.setCookie.some((header) => /Max-Age=0/.test(header)),
      'Cookie clearing is independent of whether this request revoked anything'
    )
    assert.equal(session.epoch, 2, 'one revocation means one epoch bump')
    const disabledEvents = app.store.audit.filter(
      (event) =>
        event.eventType === 'session.revoked' &&
        event.targetId === session.id &&
        event.metadata?.reason === 'USER_DISABLED'
    )
    assert.equal(disabledEvents.length, 1, 'the disabled refusal is audited once')
    const successEvents = app.store.audit.filter(
      (event) =>
        event.eventType === 'logout' && event.targetId === session.id && event.result === 'success'
    )
    assert.equal(successEvents.length, 0, 'a session revoked elsewhere gets no logout success')
  })

  test('登出先撤销、禁用刷新后到：epoch 只 +1，成功审计恰 1，禁用路径不再补 denied', async () => {
    const gate = barrier()
    const { app, base } = await start(() => gate.before)
    const { cookie } = await login(base)
    const session = activeSession(app)
    const user = app.store.users.get(session.userId)
    assert.ok(user)
    user.status = 'disabled'

    const disabledRefresh = refreshCookie(base, cookie)
    await gate.blocked
    const logoutRes = await logoutCookie(base, cookie)
    gate.release()
    const disabledRes = await disabledRefresh

    assert.equal(logoutRes.status, 200)
    assert.equal(disabledRes.status, 401)
    assert.equal(session.epoch, 2, 'the disabled re-check must not bump a second time')
    const events = app.store.audit.filter(
      (event) => event.eventType === 'logout' && event.targetId === session.id
    )
    assert.equal(events.filter((event) => event.result === 'success').length, 1)
    assert.equal(
      events.filter((event) => event.metadata?.reason === 'USER_DISABLED').length,
      0,
      'the disabled path sees the session already revoked and writes nothing'
    )
  })

  test('重复登出与单请求多凭据：每 session 恰 1 条 success，epoch 不重复 bump', async () => {
    const { app, base } = await start(() => async () => {})
    const first = await login(base)
    await login(base)
    const sessions = [...app.store.sessions.values()]
    assert.equal(sessions.length, 2)
    const [a, b] = sessions
    assert.ok(a)
    assert.ok(b)

    // Bearer A + body refresh B in one request: both revoked once each.
    const bodyB = refreshTokenOf(app, b.id)
    const res = await logout(base, first.accessToken, { refreshToken: bodyB })
    assert.equal(res.status, 200)
    assert.equal(a.epoch, 2)
    assert.equal(b.epoch, 2)
    const successFor = (sessionId: string) =>
      app.store.audit.filter(
        (event) =>
          event.eventType === 'logout' &&
          event.targetId === sessionId &&
          event.result === 'success'
      ).length
    assert.equal(successFor(a.id), 1, 'Bearer target audited once')
    assert.equal(successFor(b.id), 1, 'body target audited once, deduped by the target set')

    // Replaying the same request must not bump or audit again.
    const replay = await logout(base, first.accessToken, { refreshToken: bodyB })
    assert.equal(replay.status, 200)
    assert.equal(a.epoch, 2)
    assert.equal(b.epoch, 2, 'an already revoked session keeps its epoch')
    assert.equal(successFor(a.id), 1)
    assert.equal(successFor(b.id), 1)

    // Same session via Bearer and body: still one event for that target.
    const second = await login(base)
    const c = [...app.store.sessions.values()].find(
      (session) => session.userId === second.userId && session.revokedAt === null
    )
    assert.ok(c)
    const bodyC = refreshTokenOf(app, c.id)
    const deduped = await logout(base, second.accessToken, { refreshToken: bodyC })
    assert.equal(deduped.status, 200)
    assert.equal(c.epoch, 2)
    assert.equal(successFor(c.id), 1)
  })
})

/** The store keeps the plaintext token in memory next to the hash. */
function refreshTokenOf(app: ApiHandle, sessionId: string): string {
  const session = app.store.sessions.get(sessionId)
  assert.ok(session?.currentRefreshToken)
  return session.currentRefreshToken
}
