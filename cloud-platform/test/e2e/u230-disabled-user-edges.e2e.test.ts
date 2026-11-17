import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp, type ApiHandle } from '../../apps/api/src/server.ts'

/**
 * U230: re-review gaps left after U228/U229. These pin the disabled-account
 * edges the original suite did not: Cookie-previous/grace, a session whose user
 * no longer exists, a forged body token next to a valid Cookie, login creating
 * no device, and the hash chain itself over `/v1/audit/verify`.
 */

const ORIGIN = 'https://console.u230.example'
const apps: ApiHandle[] = []

type LoginBody = {
  accessToken?: string
  refreshToken?: string
  refreshCookie?: boolean
  error?: { code?: string; message?: string }
  user?: { id: string }
}

type AuditEvent = {
  actor: string | null
  targetId: string | null
  result: string
  metadata: Record<string, unknown>
}

async function start(
  options: { cookieMode?: string; publicOrigin?: string; refreshGraceMs?: number } = {}
): Promise<{ app: ApiHandle; base: string }> {
  const app = createApp({
    port: 0,
    accessTtlMs: 60_000,
    refreshTtlMs: 60_000,
    refreshGraceMs: options.refreshGraceMs,
    internalToken: 'u230-token',
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
    body: JSON.stringify({ username, password, deviceName: 'u230' })
  })
  return { status: res.status, res, body: (await res.json()) as LoginBody }
}

function refreshBody(
  base: string,
  refreshToken: string,
  headers: Record<string, string> = {}
): Promise<Response> {
  return fetch(`${base}/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
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

function deleteUser(app: ApiHandle, username: string) {
  const user = app.store.usersByName.get(username)
  assert.ok(user, `${username} must exist`)
  app.store.users.delete(user.id)
  app.store.usersByName.delete(user.username)
  return user
}

function auditOf(app: ApiHandle, sessionId: string): AuditEvent[] {
  return app.store.audit.filter(
    (event) =>
      event.eventType === 'logout' &&
      event.targetId === sessionId &&
      event.metadata?.reason === 'USER_DISABLED'
  )
}

after(async () => {
  await Promise.all(apps.map((app) => app.close()))
})

describe('U230 停用账号边界（真实 createApp + HTTP）', () => {
  test('Cookie=previous 宽限分支：禁用后 401、撤销并 bump epoch、actor 为用户名', async () => {
    const { app, base } = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    // Script login keeps the body refresh; rotating it by body makes that value
    // `previous` inside the grace window and sets the current Cookie.
    const first = await login(base, 'zhangsan', 'Passw0rd!')
    const previous = first.body.refreshToken ?? ''
    const rotated = await refreshBody(base, previous, { origin: ORIGIN })
    assert.equal(rotated.status, 200)
    const current = ((await rotated.json()) as LoginBody).refreshToken ?? ''
    assert.notEqual(current, previous)
    const user = app.store.usersByName.get('zhangsan')
    assert.ok(user)
    const session = sessionOf(app, user.id)
    assert.ok(session.previousRefreshHash, 'precondition: the old value is in grace')
    user.status = 'disabled'

    const refused = await refreshCookie(base, previous)

    assert.equal(refused.status, 401)
    assert.equal(((await refused.json()) as LoginBody).error?.code, 'SESSION_EXPIRED')
    assert.match(refused.headers.getSetCookie().join(';'), /Max-Age=0/)
    assert.ok(session.revokedAt, 'the disabled session must be revoked')
    assert.equal(session.epoch, 2, 'the epoch bump kills already-issued access tokens')
    const [event] = auditOf(app, session.id)
    assert.ok(event, 'the refusal must be audited')
    assert.equal(event.actor, 'zhangsan')
    assert.equal(event.result, 'denied')
    assert.equal(event.metadata.source, 'cookie')
    assert.equal(
      JSON.stringify(event.metadata).includes(previous),
      false,
      'the audit must never carry the refresh value'
    )

    const me = await fetch(`${base}/v1/me`, {
      headers: { authorization: `Bearer ${first.body.accessToken ?? ''}` }
    })
    assert.equal(me.status, 401, 'the old access token must already be dead')
  })

  test('session.userId 已删除：body 与 Cookie 刷新均撤销、401、审计 actor=null', async () => {
    const { app, base } = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const zhang = await login(base, 'zhangsan', 'Passw0rd!')
    const admin = await login(base, 'admin', 'Adm1n!', { origin: ORIGIN })
    assert.equal(admin.status, 200)
    const adminCookie = cookieValueOf(admin.res)
    const zhangSession = sessionOf(app, deleteUser(app, 'zhangsan').id)
    const adminSession = sessionOf(app, deleteUser(app, 'admin').id)

    const bodyRefused = await refreshBody(base, zhang.body.refreshToken ?? '')
    assert.equal(bodyRefused.status, 401)
    assert.equal(((await bodyRefused.json()) as LoginBody).error?.code, 'SESSION_EXPIRED')
    assert.ok(zhangSession.revokedAt)
    assert.equal(zhangSession.epoch, 2)
    const [bodyEvent] = auditOf(app, zhangSession.id)
    assert.ok(bodyEvent)
    assert.equal(bodyEvent.actor, null, 'a deleted user has no actor to record')
    assert.equal(bodyEvent.metadata.source, 'body')

    const cookieRefused = await refreshCookie(base, adminCookie)
    assert.equal(cookieRefused.status, 401)
    assert.equal(((await cookieRefused.json()) as LoginBody).error?.code, 'SESSION_EXPIRED')
    assert.match(cookieRefused.headers.getSetCookie().join(';'), /Max-Age=0/)
    assert.ok(adminSession.revokedAt)
    assert.equal(adminSession.epoch, 2)
    const [cookieEvent] = auditOf(app, adminSession.id)
    assert.ok(cookieEvent)
    assert.equal(cookieEvent.actor, null)
    assert.equal(cookieEvent.metadata.source, 'cookie')

    const me = await fetch(`${base}/v1/me`, {
      headers: { authorization: `Bearer ${zhang.body.accessToken ?? ''}` }
    })
    assert.equal(me.status, 401, 'an access token for a deleted user must stop working')
  })

  test('假 body token + 有效 Cookie：刷新按 Cookie 源处理，假值被忽略', async () => {
    const { app, base } = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const loggedIn = await login(base, 'admin', 'Adm1n!', { origin: ORIGIN })
    assert.equal(loggedIn.status, 200)
    assert.equal(loggedIn.body.refreshToken, undefined)
    const cookie = cookieValueOf(loggedIn.res)
    const session = sessionOf(app, app.store.usersByName.get('admin')?.id ?? '')
    const hashBefore = session.refreshHash
    const forged = 'forged-body-token-not-owned-by-this-session'

    const res = await fetch(`${base}/v1/auth/refresh`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        cookie: `orca_refresh=${cookie}`
      },
      body: JSON.stringify({ refreshToken: forged })
    })

    assert.equal(res.status, 200, 'the Cookie is the credential; a foreign body value is ignored')
    const body = (await res.json()) as LoginBody
    assert.equal(body.refreshToken, undefined, 'a foreign body value is never echoed')
    assert.equal(body.refreshCookie, true)
    assert.equal(cookieValueOf(res), cookie, 'the identical current Cookie is re-sent')
    assert.equal(session.refreshHash, hashBefore, 'the fake value must not rotate the session')
    assert.equal(session.previousRefreshHash, undefined)
    assert.equal(session.revokedAt, null)
    assert.equal(
      JSON.stringify(app.store.audit).includes(forged),
      false,
      'the audit must never carry the forged value'
    )
  })

  test('停用登录不创建 device/session/token', async () => {
    const { app, base } = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const seeded = await login(base, 'zhangsan', 'Passw0rd!', { origin: ORIGIN })
    assert.equal(seeded.status, 200)
    const user = app.store.usersByName.get('zhangsan')
    assert.ok(user)
    const countsBefore = {
      devices: app.store.devices.size,
      sessions: app.store.sessions.size,
      refreshTokens: app.store.refreshTokens.size,
      accessTokens: app.store.accessTokens.size
    }
    user.status = 'disabled'

    const denied = await login(base, 'zhangsan', 'Passw0rd!', { origin: ORIGIN })

    assert.equal(denied.status, 403)
    assert.equal(denied.body.error?.code, 'USER_DISABLED')
    assert.equal(denied.body.accessToken, undefined)
    assert.equal(denied.body.refreshToken, undefined)
    assert.deepEqual(denied.res.headers.getSetCookie(), [])
    assert.deepEqual(
      {
        devices: app.store.devices.size,
        sessions: app.store.sessions.size,
        refreshTokens: app.store.refreshTokens.size,
        accessTokens: app.store.accessTokens.size
      },
      countsBefore,
      'a refused login must not create a device, session, or token'
    )
  })

  test('/v1/audit/verify 校验通过，且拒绝事件与密码/令牌均未入链', async () => {
    const { app, base } = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const admin = await login(base, 'admin', 'Adm1n!', { origin: ORIGIN })
    assert.equal(admin.status, 200)
    const target = await login(base, 'zhangsan', 'Passw0rd!', { origin: ORIGIN })
    assert.equal(target.status, 200)
    const cookie = cookieValueOf(target.res)
    const user = app.store.usersByName.get('zhangsan')
    assert.ok(user)
    const session = sessionOf(app, user.id)
    user.status = 'disabled'

    assert.equal((await login(base, 'zhangsan', 'Passw0rd!', { origin: ORIGIN })).status, 403)
    const refused = await refreshCookie(base, cookie)
    assert.equal(refused.status, 401)
    assert.ok(session.revokedAt)

    const expected = app.store.audit.length
    const verify = await fetch(`${base}/v1/audit/verify`, {
      headers: { authorization: `Bearer ${admin.body.accessToken ?? ''}` }
    })
    assert.equal(verify.status, 200)
    const verdict = (await verify.json()) as { ok: boolean; checked: number; tip?: string }
    assert.equal(verdict.ok, true, 'the real hash chain must verify')
    assert.equal(verdict.checked, expected, 'every event before the verify call is checked')
    assert.equal(typeof verdict.tip, 'string')

    const events = await fetch(
      `${base}/v1/audit/events?eventType=logout&result=denied&limit=50`,
      { headers: { authorization: `Bearer ${admin.body.accessToken ?? ''}` } }
    )
    assert.equal(events.status, 200)
    const { events: denied } = (await events.json()) as { events: AuditEvent[] }
    const disabledEvents = denied.filter((event) => event.metadata.reason === 'USER_DISABLED')
    assert.ok(disabledEvents.length >= 1, 'the refusals must be queryable')
    const serialized = JSON.stringify(app.store.audit)
    for (const secret of ['Passw0rd!', cookie]) {
      assert.equal(serialized.includes(secret), false, 'audit metadata must never carry a secret')
    }
  })
})

describe('U233 F3 交接拒绝 reason 分流（真实 createApp + HTTP）', () => {
  type DenyBody = { error?: { code?: string; details?: { reason?: string } } }

  async function redeem(base: string, code: string): Promise<{ status: number; body: DenyBody }> {
    const res = await fetch(`${base}/v1/web/handoff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code })
    })
    return { status: res.status, body: (await res.json()) as DenyBody }
  }

  test('禁用用户：reason=subject_gone，不再误记 project_archived', async () => {
    const { app, base } = await start()
    const user = app.store.usersByName.get('zhangsan')
    assert.ok(user)
    user.status = 'disabled'
    app.store.webHandoffs.set('u233-disabled-handoff', {
      userId: user.id,
      projectId: 'proj_payment',
      expiresAt: Date.now() + 60_000
    })

    const { status, body } = await redeem(base, 'u233-disabled-handoff')
    assert.equal(status, 410)
    assert.equal(body.error?.code, 'HANDOFF_GONE')
    assert.equal(body.error?.details?.reason, 'subject_gone')
    assert.notEqual(body.error?.details?.reason, 'project_archived')
  })

  test('归档项目：reason=project_archived', async () => {
    const { app, base } = await start()
    const user = app.store.usersByName.get('zhangsan')
    const project = app.store.projects.get('proj_payment')
    assert.ok(user)
    assert.ok(project)
    project.status = 'archived'
    app.store.webHandoffs.set('u233-archived-handoff', {
      userId: user.id,
      projectId: project.id,
      expiresAt: Date.now() + 60_000
    })

    const { status, body } = await redeem(base, 'u233-archived-handoff')
    assert.equal(status, 410)
    assert.equal(body.error?.details?.reason, 'project_archived')
  })
})
