import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp, type ApiHandle } from '../../apps/api/src/server.ts'

/**
 * D20 / U243: refresh expiry writes `session.expired` exactly once (first
 * revoker wins) and a disabled-account refresh writes `session.revoked`
 * instead of the old semantically inverted `logout/denied` pair.
 */

const ORIGIN = 'https://console.u243.example'
const apps: ApiHandle[] = []

type LoginBody = {
  accessToken?: string
  refreshToken?: string
  refreshCookie?: boolean
  user?: { id: string }
}

async function start(cookieMode?: string): Promise<{ app: ApiHandle; base: string }> {
  const app = createApp({
    port: 0,
    accessTtlMs: 60_000,
    refreshTtlMs: 60_000,
    internalToken: 'u243-token',
    cookieMode,
    // Empty string pins "unconfigured" even if the developer shell exports one.
    publicOrigin: cookieMode ? ORIGIN : ''
  })
  apps.push(app)
  const port = await app.listen()
  return { app, base: `http://127.0.0.1:${port}` }
}

after(async () => {
  await Promise.all(apps.map((app) => app.close()))
})

function login(
  base: string,
  options: { cookie?: boolean; username?: string } = {}
): Promise<{ res: Response; body: LoginBody }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (options.cookie) headers.origin = ORIGIN
  return fetch(`${base}/v1/auth/login`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      username: options.username ?? 'admin',
      password: 'Adm1n!',
      deviceName: 'u243'
    })
  }).then(async (res) => ({ res, body: (await res.json()) as LoginBody }))
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
  assert.ok(match, 'expected a refresh cookie')
  return match[1] ?? ''
}

function eventsOf(app: ApiHandle, type: string) {
  return app.store.audit.filter((event) => event.eventType === type)
}

function sessionOf(app: ApiHandle, username: string) {
  const user = app.store.usersByName.get(username)
  assert.ok(user, `${username} must exist`)
  const session = [...app.store.sessions.values()].find(
    (entry) => entry.userId === user.id && entry.revokedAt === null
  )
  assert.ok(session, `${username} must have a live session`)
  return session
}

describe('D20 会话事件词汇', () => {
  test('body 刷新过期：恰好 1 条 session.expired，reason/source/expiredAt 正确', async () => {
    const { app, base } = await start()
    const loggedIn = await login(base)
    const session = sessionOf(app, 'admin')
    const refreshToken = loggedIn.body.refreshToken ?? ''
    session.refreshExpiresAt = Date.now() - 1
    const expiredAt = session.refreshExpiresAt

    const res = await refreshBody(base, refreshToken)

    assert.equal(res.status, 401)
    assert.equal(session.epoch, 2, 'the expiry revoke bumps the epoch once')
    const events = eventsOf(app, 'session.expired')
    assert.equal(events.length, 1)
    const [event] = events
    assert.ok(event)
    assert.equal(event.result, 'success')
    assert.equal(event.actor, 'admin')
    assert.equal(event.targetType, 'session')
    assert.equal(event.targetId, session.id)
    assert.deepEqual(event.metadata, { reason: 'EXPIRED', source: 'body', expiredAt })
    const serialized = JSON.stringify(event)
    assert.equal(serialized.includes(refreshToken), false, 'the event must not carry the token')
    assert.equal(serialized.includes(session.refreshHash), false, 'the event must not carry a hash')
  })

  test('Cookie 刷新过期：恰好 1 条 session.expired，source=cookie 且仍清 Cookie', async () => {
    const { app, base } = await start('auto')
    const loggedIn = await login(base, { cookie: true })
    const cookie = cookieValueOf(loggedIn.res)
    const session = sessionOf(app, 'admin')
    session.refreshExpiresAt = Date.now() - 1

    const res = await refreshCookie(base, cookie)

    assert.equal(res.status, 401)
    assert.equal(session.epoch, 2)
    assert.ok(
      res.headers.getSetCookie().some((header) => /Max-Age=0/.test(header)),
      '401 must still clear the Cookie'
    )
    const events = eventsOf(app, 'session.expired')
    assert.equal(events.length, 1)
    assert.equal(events[0]?.metadata.source, 'cookie')
    assert.equal(events[0]?.metadata.reason, 'EXPIRED')
    assert.equal(JSON.stringify(events[0]).includes(cookie), false)
  })

  test('并发刷新同一过期会话：两条均 401，事件仍只有 1 条', async () => {
    const { app, base } = await start()
    const loggedIn = await login(base)
    const session = sessionOf(app, 'admin')
    const refreshToken = loggedIn.body.refreshToken ?? ''
    session.refreshExpiresAt = Date.now() - 1

    const [first, second] = await Promise.all([
      refreshBody(base, refreshToken),
      refreshBody(base, refreshToken)
    ])

    assert.equal(first.status, 401)
    assert.equal(second.status, 401)
    assert.equal(session.epoch, 2, 'one revocation means one epoch bump')
    assert.equal(eventsOf(app, 'session.expired').length, 1)
  })

  test('禁用用户刷新：1 条 session.revoked，且没有 logout denied', async () => {
    const { app, base } = await start()
    const loggedIn = await login(base)
    const session = sessionOf(app, 'admin')
    const user = app.store.usersByName.get('admin')
    assert.ok(user)
    user.status = 'disabled'

    const res = await refreshBody(base, loggedIn.body.refreshToken ?? '')

    assert.equal(res.status, 401, 'the 401 contract is unchanged')
    assert.ok(session.revokedAt, 'the disabled session is revoked')
    const revoked = eventsOf(app, 'session.revoked')
    assert.equal(revoked.length, 1)
    assert.equal(revoked[0]?.result, 'success')
    assert.equal(revoked[0]?.actor, 'admin')
    assert.equal(revoked[0]?.targetType, 'session')
    assert.equal(revoked[0]?.targetId, session.id)
    assert.deepEqual(revoked[0]?.metadata, { reason: 'USER_DISABLED', source: 'body' })
    assert.equal(
      app.store.audit.filter(
        (event) =>
          event.eventType === 'logout' &&
          event.result === 'denied' &&
          event.metadata?.reason === 'USER_DISABLED'
      ).length,
      0,
      'the old logout/denied pair must be gone'
    )
    assert.equal(eventsOf(app, 'session.expired').length, 0, 'a disabled session did not expire')
  })
})
