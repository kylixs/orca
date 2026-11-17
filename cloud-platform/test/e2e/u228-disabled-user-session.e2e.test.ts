import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp, type ApiHandle } from '../../apps/api/src/server.ts'

/**
 * U228: a disabled account must neither sign in nor renew. Login refuses before
 * any token/Cookie is issued; refresh revokes the session it locates, for the
 * Cookie source and the body source, before current/previous/grace handling.
 */

const ORIGIN = 'https://console.u228.example'
const apps: ApiHandle[] = []

type LoginBody = {
  accessToken?: string
  refreshToken?: string
  error?: { code?: string; message?: string }
  user?: { id: string }
}

type AuditEvent = {
  actor: string | null
  result: string
  metadata: Record<string, unknown>
}

async function start(options: { cookieMode?: string; publicOrigin?: string } = {}): Promise<{
  app: ApiHandle
  base: string
}> {
  const app = createApp({
    port: 0,
    accessTtlMs: 60_000,
    refreshTtlMs: 60_000,
    internalToken: 'u228-token',
    cookieMode: options.cookieMode,
    // Empty string pins "unconfigured" even if the developer shell exports one.
    publicOrigin: options.publicOrigin ?? ''
  })
  apps.push(app)
  const port = await app.listen()
  return { app, base: `http://127.0.0.1:${port}` }
}

async function login(
  base: string,
  username: string,
  password: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; res: Response; body: LoginBody }> {
  const res = await fetch(`${base}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ username, password, deviceName: 'u228' })
  })
  return { status: res.status, res, body: (await res.json()) as LoginBody }
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
    body: JSON.stringify({})
  })
}

function cookieValueOf(res: Response): string {
  const match = /^orca_refresh=([A-Za-z0-9_-]+);/.exec(res.headers.getSetCookie()[0] ?? '')
  assert.ok(match, 'expected a refresh cookie')
  return match[1] ?? ''
}

function sessionOf(app: ApiHandle, userId: string) {
  const session = [...app.store.sessions.values()].find((entry) => entry.userId === userId)
  assert.ok(session, 'the login must have created a session')
  return session
}

async function auditEvents(
  base: string,
  accessToken: string,
  query: string
): Promise<AuditEvent[]> {
  const res = await fetch(`${base}/v1/audit/events?${query}`, {
    headers: { authorization: `Bearer ${accessToken}` }
  })
  assert.equal(res.status, 200)
  const body = (await res.json()) as { events: AuditEvent[] }
  return body.events
}

after(async () => {
  await Promise.all(apps.map((app) => app.close()))
})

describe('U228 停用账号不能登录/续期（真实 createApp + HTTP）', () => {
  test('停用后登录：403 USER_DISABLED，无令牌无 Cookie，审计 login denied', async () => {
    const { app, base } = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    // First login seeds the directory user; then the directory disables it.
    assert.equal((await login(base, 'zhangsan', 'Passw0rd!', { origin: ORIGIN })).status, 200)
    const admin = await login(base, 'admin', 'Adm1n!')
    assert.equal(admin.status, 200)
    const target = app.store.usersByName.get('zhangsan')
    assert.ok(target)
    target.status = 'disabled'
    const sessionsBefore = app.store.sessions.size

    const denied = await login(base, 'zhangsan', 'Passw0rd!', { origin: ORIGIN })

    assert.equal(denied.status, 403)
    assert.equal(denied.body.error?.code, 'USER_DISABLED')
    assert.match(denied.body.error?.message ?? '', /停用/)
    assert.equal(denied.body.accessToken, undefined, 'no access token may be issued')
    assert.equal(denied.body.refreshToken, undefined, 'no refresh token may be issued')
    assert.deepEqual(denied.res.headers.getSetCookie(), [], 'no Cookie may be issued')
    assert.equal(app.store.sessions.size, sessionsBefore, 'no session may be created')

    const events = await auditEvents(
      base,
      admin.body.accessToken ?? '',
      'eventType=login&result=denied&limit=50'
    )
    const event = events.find(
      (entry) => entry.actor === 'zhangsan' && entry.metadata.reason === 'USER_DISABLED'
    )
    assert.ok(event, 'the refusal must leave a login denied event')
    assert.equal(event.result, 'denied')
    assert.equal(
      JSON.stringify(event.metadata).includes('Passw0rd'),
      false,
      'the audit event must never carry the password'
    )
  })

  test('body 刷新：current 与宽限 previous 均 401、撤销会话、清 Cookie', async () => {
    const { app, base } = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    // zhangsan: rotate once so the next request is the current token.
    const zhang = await login(base, 'zhangsan', 'Passw0rd!')
    const zhangRotated = await refreshBody(base, zhang.body.refreshToken ?? '')
    assert.equal(zhangRotated.status, 200)
    const zhangCurrent = ((await zhangRotated.json()) as LoginBody).refreshToken ?? ''
    // lisi: keep the first token, which is a previous value inside the grace window.
    const li = await login(base, 'lisi', 'Passw0rd!')
    const liPrevious = li.body.refreshToken ?? ''
    const liRotated = await refreshBody(base, liPrevious)
    assert.equal(liRotated.status, 200)

    const zhangUser = app.store.usersByName.get('zhangsan')
    const liUser = app.store.usersByName.get('lisi')
    assert.ok(zhangUser && liUser)
    zhangUser.status = 'disabled'
    liUser.status = 'disabled'
    const zhangSession = sessionOf(app, zhangUser.id)
    const liSession = sessionOf(app, liUser.id)

    const current = await refreshBody(base, zhangCurrent)
    assert.equal(current.status, 401)
    assert.equal(((await current.json()) as LoginBody).error?.code, 'SESSION_EXPIRED')
    assert.ok(zhangSession.revokedAt, 'the disabled session must be revoked')
    assert.equal(zhangSession.epoch, 2, 'the epoch bump kills already-issued access tokens')
    assert.match(
      current.headers.getSetCookie().join(';'),
      /Max-Age=0/,
      'the refresh Cookie must be cleared'
    )

    const grace = await refreshBody(base, liPrevious)
    assert.equal(grace.status, 401, 'the grace window must not renew a disabled account')
    assert.equal(((await grace.json()) as LoginBody).error?.code, 'SESSION_EXPIRED')
    assert.ok(liSession.revokedAt)
    assert.equal(liSession.epoch, 2)

    const me = await fetch(`${base}/v1/me`, {
      headers: { authorization: `Bearer ${zhang.body.accessToken ?? ''}` }
    })
    assert.equal(me.status, 401, 'the old access token must already be dead')
  })

  test('Cookie 刷新：禁用后 401、撤销会话、下发清 Cookie', async () => {
    const { app, base } = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const loggedIn = await login(base, 'admin', 'Adm1n!', { origin: ORIGIN })
    assert.equal(loggedIn.status, 200)
    assert.equal(loggedIn.body.refreshToken, undefined, 'same-origin login hides the body refresh')
    const cookie = cookieValueOf(loggedIn.res)
    const target = app.store.usersByName.get('admin')
    assert.ok(target)
    const session = sessionOf(app, target.id)
    target.status = 'disabled'

    const refused = await refreshCookie(base, cookie)

    assert.equal(refused.status, 401)
    assert.equal(((await refused.json()) as LoginBody).error?.code, 'SESSION_EXPIRED')
    assert.match(
      refused.headers.getSetCookie().join(';'),
      /Max-Age=0/,
      'the Cookie must be cleared'
    )
    assert.ok(session.revokedAt)
    assert.equal(session.epoch, 2)

    const me = await fetch(`${base}/v1/me`, {
      headers: { authorization: `Bearer ${loggedIn.body.accessToken ?? ''}` }
    })
    assert.equal(me.status, 401, 'the still-valid access token must stop working')
  })
})
