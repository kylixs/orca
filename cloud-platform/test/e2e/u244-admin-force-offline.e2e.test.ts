import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, type ApiHandle } from '../../apps/api/src/server.ts'

/**
 * U244 / FR-1.6: an administrator force-offline revokes every platform session
 * of one user (epoch bump kills issued access tokens, refresh dies and clears
 * the Cookie) and drops the host ticket through the user revocation set —
 * without revoking the user's devices.
 */

const ORIGIN = 'https://console.u244.example'
const apps: ApiHandle[] = []

type LoginBody = {
  accessToken?: string
  refreshToken?: string
  error?: { code?: string; message?: string }
  user?: { id: string }
}

type RevokeBody = { ok?: boolean; revokedSessions?: number; error?: { code?: string } }

type AuditEvent = {
  eventType: string
  actor: string | null
  targetType: string | null
  targetId: string | null
  result: string
  metadata: Record<string, unknown>
}

async function start(
  options: {
    cookieMode?: string
    publicOrigin?: string
    auditLogPath?: string
    beforeUserSessionRevoke?: () => void | Promise<void>
  } = {}
): Promise<{ app: ApiHandle; base: string }> {
  const app = createApp({
    port: 0,
    accessTtlMs: 60_000,
    refreshTtlMs: 60_000,
    internalToken: 'u244-token',
    cookieMode: options.cookieMode,
    beforeUserSessionRevoke: options.beforeUserSessionRevoke,
    auditLogPath: options.auditLogPath,
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
    body: JSON.stringify({ username, password, deviceName: `u244-${username}-${Date.now()}` })
  })
  return { status: res.status, res, body: (await res.json()) as LoginBody }
}

function cookieValueOf(res: Response): string {
  const match = /^orca_refresh=([A-Za-z0-9_-]+);/.exec(res.headers.getSetCookie()[0] ?? '')
  assert.ok(match, 'expected a refresh cookie')
  return match[1] ?? ''
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

function revoke(
  base: string,
  token: string,
  userId: string,
  body: Record<string, unknown> = {}
): Promise<Response> {
  return fetch(`${base}/v1/users/${userId}/sessions/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  })
}

function sessionsOf(app: ApiHandle, userId: string) {
  return [...app.store.sessions.values()].filter((session) => session.userId === userId)
}

async function auditEvents(base: string, token: string, query: string): Promise<AuditEvent[]> {
  const res = await fetch(`${base}/v1/audit/events?${query}&limit=50`, {
    headers: { authorization: `Bearer ${token}` }
  })
  assert.equal(res.status, 200)
  return ((await res.json()) as { events: AuditEvent[] }).events
}

function rendezvous(timeoutMs = 2_000): () => Promise<void> {
  let arrivals = 0
  let release: () => void = () => {}
  let fail: (error: Error) => void = () => {}
  const gate = new Promise<void>((resolve, reject) => {
    release = resolve
    fail = reject
  })
  const timer = setTimeout(
    () => fail(new Error(`the second revoke did not reach the barrier within ${timeoutMs}ms`)),
    timeoutMs
  )
  timer.unref()
  gate.catch(() => {})
  return async () => {
    arrivals += 1
    if (arrivals === 2) {
      clearTimeout(timer)
      release()
    }
    await gate
  }
}

after(async () => {
  await Promise.all(apps.map((app) => app.close()))
})

describe('U244 管理员强制下线（真实 createApp + HTTP）', () => {
  test('撤销多设备用户：全部会话失效、epoch +1、旧 access 401、refresh 401 并清 Cookie', async () => {
    const { app, base } = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const phone = await login(base, 'zhangsan', 'Passw0rd!', { origin: ORIGIN })
    const laptop = await login(base, 'zhangsan', 'Passw0rd!', { origin: ORIGIN })
    assert.equal(phone.status, 200)
    assert.equal(laptop.status, 200)
    const admin = await login(base, 'admin', 'Adm1n!', { origin: ORIGIN })
    assert.equal(admin.status, 200)
    const zhang = app.store.usersByName.get('zhangsan')
    assert.ok(zhang)
    const sessions = sessionsOf(app, zhang.id)
    assert.equal(sessions.length, 2, 'two logins make two devices and sessions')
    const devices = [...app.store.devices.values()].filter((device) => device.userId === zhang.id)
    assert.equal(devices.length, 2)

    const revoked = await revoke(base, admin.body.accessToken ?? '', zhang.id, { reason: '离职交接' })

    assert.equal(revoked.status, 200)
    assert.deepEqual((await revoked.json()) as RevokeBody, { ok: true, revokedSessions: 2 })
    for (const session of sessions) {
      assert.ok(session.revokedAt !== null, 'every session must be revoked')
      assert.equal(session.epoch, 2, 'the epoch bump must invalidate issued access tokens')
    }
    for (const access of [phone.body.accessToken, laptop.body.accessToken]) {
      const me = await fetch(`${base}/v1/me`, {
        headers: { authorization: `Bearer ${access ?? ''}` }
      })
      assert.equal(me.status, 401, 'old access tokens must be dead immediately')
    }
    const refused = await refreshCookie(base, cookieValueOf(phone.res))
    assert.equal(refused.status, 401)
    assert.equal(((await refused.json()) as LoginBody).error?.code, 'SESSION_EXPIRED')
    assert.match(
      refused.headers.getSetCookie().join(';'),
      /Max-Age=0/,
      'the refresh Cookie must be cleared'
    )
    for (const device of devices) {
      assert.equal(device.revokedAt, null, 'force-offline is not a device loss')
    }
  })

  test('宿主撤销集合写入 user:<username>，内部端点可查', async () => {
    const { app, base } = await start()
    assert.equal((await login(base, 'zhangsan', 'Passw0rd!')).status, 200)
    const admin = await login(base, 'admin', 'Adm1n!')
    const zhang = app.store.usersByName.get('zhangsan')
    assert.ok(zhang)

    const revoked = await revoke(base, admin.body.accessToken ?? '', zhang.id)
    assert.equal(revoked.status, 200)
    assert.equal(((await revoked.json()) as RevokeBody).revokedSessions, 1)

    const res = await fetch(`${base}/v1/internal/revocations`, {
      headers: { 'x-internal-token': 'u244-token' }
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as { users: { id: string }[]; devices: { id: string }[] }
    assert.ok(
      body.users.some((entry) => entry.id === zhang.username),
      'the host ticket must be revoked by username, not user id'
    )
    assert.equal(body.devices.length, 0, 'no device revocation may be written')
  })

  test('非管理员 403 PERMISSION_DENIED + denied 审计，会话无变化', async () => {
    const { app, base } = await start()
    assert.equal((await login(base, 'zhangsan', 'Passw0rd!')).status, 200)
    const lisi = await login(base, 'lisi', 'Passw0rd!')
    assert.equal(lisi.status, 200)
    const zhang = app.store.usersByName.get('zhangsan')
    assert.ok(zhang)
    const session = sessionsOf(app, zhang.id)[0]
    assert.ok(session)

    const denied = await revoke(base, lisi.body.accessToken ?? '', zhang.id)

    assert.equal(denied.status, 403)
    assert.equal(((await denied.json()) as RevokeBody).error?.code, 'PERMISSION_DENIED')
    assert.equal(session.revokedAt, null)
    assert.equal(session.epoch, 1)
    const event = app.store.audit.find(
      (entry) => entry.eventType === 'session_revoke' && entry.result === 'denied'
    )
    assert.ok(event, 'the refusal must be audited')
    assert.equal(event.actor, 'lisi')
    assert.equal(event.targetId, zhang.id)
    assert.equal(event.metadata.reason, 'PERMISSION_DENIED')
    assert.equal(event.metadata.requiredPermission, 'platform:admin')
  })

  test('审计不可写 → 503 且会话未变（fail-closed）', async () => {
    const logPath = join(mkdtempSync(join(tmpdir(), 'u244-audit-')), 'audit.jsonl')
    const { app, base } = await start({ auditLogPath: logPath })
    assert.equal((await login(base, 'zhangsan', 'Passw0rd!')).status, 200)
    const admin = await login(base, 'admin', 'Adm1n!')
    const zhang = app.store.usersByName.get('zhangsan')
    assert.ok(zhang)
    const session = sessionsOf(app, zhang.id)[0]
    assert.ok(session)
    const quiet = app.store.seedUser({
      username: 'quiet',
      displayName: 'Quiet',
      dept: 'ops',
      email: 'quiet@example.com',
      groups: [],
      roles: ['developer'],
      status: 'active'
    })

    chmodSync(logPath, 0o400)
    try {
      const refused = await revoke(base, admin.body.accessToken ?? '', zhang.id)
      assert.equal(refused.status, 503)
      assert.equal(session.revokedAt, null, 'no revocation may happen without an audit record')
      assert.equal(session.epoch, 1)
      assert.equal(
        app.store.revocations.some((entry) => entry.targetType === 'user'),
        false,
        'the host ticket must survive a refused audit write'
      )
      // A user with no sessions still mutates the host revocation set, so it must also fail closed.
      const emptyRefused = await revoke(base, admin.body.accessToken ?? '', quiet.id)
      assert.equal(emptyRefused.status, 503)
      assert.equal(
        app.store.revocations.some(
          (entry) => entry.targetType === 'user' && entry.targetId === 'quiet'
        ),
        false
      )
    } finally {
      chmodSync(logPath, 0o600)
    }
  })

  test('并发撤销只生效一次、只写一条审计；重复请求返回 0', async () => {
    const { app, base } = await start({ beforeUserSessionRevoke: rendezvous() })
    assert.equal((await login(base, 'zhangsan', 'Passw0rd!')).status, 200)
    const admin = await login(base, 'admin', 'Adm1n!')
    const zhang = app.store.usersByName.get('zhangsan')
    assert.ok(zhang)
    const session = sessionsOf(app, zhang.id)[0]
    assert.ok(session)
    const token = admin.body.accessToken ?? ''

    const [first, second] = await Promise.all([
      revoke(base, token, zhang.id),
      revoke(base, token, zhang.id)
    ])

    assert.equal(first.status, 200)
    assert.equal(second.status, 200)
    const counts = [
      ((await first.json()) as RevokeBody).revokedSessions,
      ((await second.json()) as RevokeBody).revokedSessions
    ].sort()
    assert.deepEqual(counts, [0, 1], 'exactly one request performs the revocation')
    assert.ok(session.revokedAt !== null)
    assert.equal(session.epoch, 2, 'the epoch may only be bumped once')
    const successEvents = app.store.audit.filter(
      (entry) => entry.eventType === 'session_revoke' && entry.result === 'success'
    )
    assert.equal(successEvents.length, 1, 'concurrent requests must not duplicate the audit')
    assert.equal(successEvents[0]?.metadata.revokedSessions, 1)

    const repeat = await revoke(base, token, zhang.id)
    assert.equal(repeat.status, 200)
    assert.equal(((await repeat.json()) as RevokeBody).revokedSessions, 0)
    assert.equal(
      app.store.audit.filter(
        (entry) => entry.eventType === 'session_revoke' && entry.result === 'success'
      ).length,
      1,
      'an idempotent repeat writes no second audit'
    )
  })

  test('未知用户 404；无会话用户 200 且仍写宿主撤销', async () => {
    const { app, base } = await start()
    const admin = await login(base, 'admin', 'Adm1n!')
    const token = admin.body.accessToken ?? ''
    const quiet = app.store.seedUser({
      username: 'quiet',
      displayName: 'Quiet',
      dept: 'ops',
      email: 'quiet@example.com',
      groups: [],
      roles: ['developer'],
      status: 'active'
    })

    const missing = await revoke(base, token, 'user_does_not_exist')
    assert.equal(missing.status, 404)
    assert.equal(((await missing.json()) as RevokeBody).error?.code, 'USER_NOT_FOUND')

    const empty = await revoke(base, token, quiet.id)
    assert.equal(empty.status, 200)
    assert.deepEqual((await empty.json()) as RevokeBody, { ok: true, revokedSessions: 0 })
    assert.ok(
      app.store.revocations.some(
        (entry) => entry.targetType === 'user' && entry.targetId === 'quiet'
      ),
      'a user with no sessions still needs the host ticket revoked'
    )
    const events = app.store.audit.filter(
      (entry) => entry.eventType === 'session_revoke' && entry.targetId === quiet.id
    )
    assert.equal(events.length, 1, 'the zero-session revoke is still audited')
    assert.equal(events[0]?.metadata.revokedSessions, 0)
  })

  test('审计事件可按类型筛选，且目录/Web 下拉同步 session_revoke', async () => {
    const { app, base } = await start()
    assert.equal((await login(base, 'zhangsan', 'Passw0rd!')).status, 200)
    const admin = await login(base, 'admin', 'Adm1n!')
    const token = admin.body.accessToken ?? ''
    const zhang = app.store.usersByName.get('zhangsan')
    assert.ok(zhang)
    assert.equal((await revoke(base, token, zhang.id, { reason: '应急' })).status, 200)

    const events = await auditEvents(base, token, 'eventType=session_revoke&result=success')
    const event = events.find((entry) => entry.targetId === zhang.id)
    assert.ok(event, 'the success event must be filterable by type')
    assert.equal(event.actor, 'admin')
    assert.equal(event.targetType, 'user')
    assert.equal(event.metadata.reason, '应急')
    assert.equal(event.metadata.revokedSessions, 1)

    const status = await fetch(`${base}/v1/audit/status`, {
      headers: { authorization: `Bearer ${token}` }
    })
    assert.equal(status.status, 200)
    const capabilities = (await status.json()) as { eventTypes: string[] }
    assert.ok(capabilities.eventTypes.includes('session_revoke'))

    const appJs = readFileSync(new URL('../../apps/web/app.js', import.meta.url), 'utf8')
    assert.match(appJs, /session_revoke: '会话撤销'/, 'the console dropdown needs a zh label')
    assert.match(appJs, /'session_revoke'/, 'the fallback type list must mirror the catalog')
  })
})
