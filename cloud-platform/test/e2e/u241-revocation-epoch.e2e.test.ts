import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp, type ApiHandle } from '../../apps/api/src/server.ts'

/**
 * U241 ②: reuse detection and refresh expiry must revoke the session and bump
 * its epoch, so access tokens issued before the revocation die immediately.
 * An already-revoked session is never bumped a second time.
 */

const ORIGIN = 'https://console.u241e.example'
const apps: ApiHandle[] = []

type LoginBody = {
  accessToken?: string
  refreshToken?: string
  error?: { code?: string }
}

async function start(
  options: { refreshTtlMs?: number; refreshGraceMs?: number; cookieMode?: string } = {}
): Promise<{ app: ApiHandle; base: string }> {
  const app = createApp({
    port: 0,
    accessTtlMs: 60_000,
    refreshTtlMs: options.refreshTtlMs ?? 60_000,
    refreshGraceMs: options.refreshGraceMs,
    internalToken: 'u241-epoch-token',
    cookieMode: options.cookieMode,
    publicOrigin: options.cookieMode === 'auto' ? ORIGIN : ''
  })
  apps.push(app)
  const port = await app.listen()
  return { app, base: `http://127.0.0.1:${port}` }
}

async function login(
  base: string,
  headers: Record<string, string> = {}
): Promise<{ res: Response; body: LoginBody }> {
  const res = await fetch(`${base}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'u241-epoch' })
  })
  return { res, body: (await res.json()) as LoginBody }
}

function refreshBody(base: string, refreshToken: string): Promise<Response> {
  return fetch(`${base}/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken })
  })
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

function cookieValueOf(res: Response): string {
  const match = /^orca_refresh=([A-Za-z0-9_-]+);/.exec(res.headers.getSetCookie()[0] ?? '')
  assert.ok(match, 'cookieMode auto must issue a refresh Cookie')
  return match[1] ?? ''
}

function onlySession(app: ApiHandle) {
  const userId = app.store.usersByName.get('admin')?.id
  const session = [...app.store.sessions.values()].find((entry) => entry.userId === userId)
  assert.ok(session, 'the login must create a session')
  return session
}

function me(base: string, accessToken: string): Promise<Response> {
  return fetch(`${base}/v1/me`, { headers: { authorization: `Bearer ${accessToken}` } })
}

function reuseEvents(app: ApiHandle, sessionId: string) {
  return app.store.audit.filter(
    (event) => event.eventType === 'refresh.reuse_detected' && event.targetId === sessionId
  )
}

after(async () => {
  await Promise.all(apps.map((app) => app.close()))
})

describe('U241 ② 刷新撤销的 epoch 一致性（真实 createApp + HTTP）', () => {
  test('body reuse 检测：撤销并 bump，旧 access 立即 401，重复命中不再 bump', async () => {
    const { app, base } = await start({ refreshGraceMs: 0 })
    const first = await login(base)
    assert.equal(first.res.status, 200)
    const session = onlySession(app)
    assert.equal(session.epoch, 1)
    const previous = first.body.refreshToken ?? ''
    assert.ok(previous)

    const rotated = await refreshBody(base, previous)
    assert.equal(rotated.status, 200)
    const current = (await rotated.json()) as LoginBody
    assert.ok(current.accessToken)
    assert.equal(session.epoch, 1, 'rotation alone must not bump the epoch')

    const replay = await refreshBody(base, previous)
    assert.equal(replay.status, 401)
    assert.equal(((await replay.json()) as LoginBody).error?.code, 'SESSION_EXPIRED')
    assert.ok(session.revokedAt, 'a replayed token must revoke the session')
    assert.equal(session.epoch, 2, 'reuse detection must bump the epoch exactly once')
    assert.equal(
      (await me(base, current.accessToken ?? '')).status,
      401,
      'access issued before reuse detection must be dead immediately'
    )
    assert.equal(reuseEvents(app, session.id).length, 1)

    const again = await refreshBody(base, previous)
    assert.equal(again.status, 401)
    assert.equal(session.epoch, 2, 'a second hit on the revoked session must not bump again')
    assert.equal(reuseEvents(app, session.id).length, 1, 'the reuse event is written once')
  })

  test('body 刷新过期：撤销并 bump，旧 access 立即 401，重复命中不再 bump', async () => {
    const { app, base } = await start({ refreshTtlMs: 120 })
    const first = await login(base)
    assert.equal(first.res.status, 200)
    const session = onlySession(app)
    assert.equal(session.epoch, 1)
    const accessToken = first.body.accessToken ?? ''
    const refreshToken = first.body.refreshToken ?? ''
    assert.ok(accessToken && refreshToken)

    await new Promise((resolve) => setTimeout(resolve, 220))

    const expired = await refreshBody(base, refreshToken)
    assert.equal(expired.status, 401)
    assert.equal(((await expired.json()) as LoginBody).error?.code, 'SESSION_EXPIRED')
    assert.ok(session.revokedAt, 'an expired refresh must revoke the session')
    assert.equal(session.epoch, 2, 'expiry must bump the epoch exactly once')
    assert.equal(
      (await me(base, accessToken)).status,
      401,
      'access issued before expiry must be dead immediately'
    )
    assert.equal(reuseEvents(app, session.id).length, 0, 'expiry logs no reuse event')

    const again = await refreshBody(base, refreshToken)
    assert.equal(again.status, 401)
    assert.equal(session.epoch, 2, 'a second expired hit must not bump again')
  })

  test('Cookie 刷新过期：撤销并 bump，旧 access 立即 401，重复命中不再 bump', async () => {
    const { app, base } = await start({ refreshTtlMs: 120, cookieMode: 'auto' })
    const first = await login(base, { origin: ORIGIN })
    assert.equal(first.res.status, 200)
    const session = onlySession(app)
    assert.equal(session.epoch, 1)
    const accessToken = first.body.accessToken ?? ''
    const cookie = cookieValueOf(first.res)

    await new Promise((resolve) => setTimeout(resolve, 220))

    const expired = await refreshCookie(base, cookie)
    assert.equal(expired.status, 401)
    assert.equal(((await expired.json()) as LoginBody).error?.code, 'SESSION_EXPIRED')
    assert.match(expired.headers.getSetCookie().join(';'), /Max-Age=0/)
    assert.ok(session.revokedAt)
    assert.equal(session.epoch, 2)
    assert.equal((await me(base, accessToken)).status, 401)

    const again = await refreshCookie(base, cookie)
    assert.equal(again.status, 401)
    assert.equal(session.epoch, 2, 'a second expired hit must not bump again')
  })
})
