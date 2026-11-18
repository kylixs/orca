import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp, type ApiHandle } from '../../apps/api/src/server.ts'

/**
 * D23 / U245③: an admin may revoke its own sessions and a sibling admin's
 * sessions; both are real revocations audited exactly once.
 */

const apps: ApiHandle[] = []

type LoginBody = {
  accessToken?: string
  user?: { id: string; roles?: string[] }
}

type RevokeBody = { ok?: boolean; revokedSessions?: number; error?: { code?: string } }

async function start(): Promise<{ app: ApiHandle; base: string }> {
  const app = createApp({
    port: 0,
    accessTtlMs: 60_000,
    refreshTtlMs: 60_000,
    // Empty string pins "unconfigured" even if the developer shell exports one.
    publicOrigin: ''
  })
  apps.push(app)
  return { app, base: `http://127.0.0.1:${await app.listen()}` }
}

async function login(
  base: string,
  username: string,
  password: string
): Promise<{ status: number; body: LoginBody }> {
  const res = await fetch(`${base}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, deviceName: `u244-${username}-${Date.now()}` })
  })
  return { status: res.status, body: (await res.json()) as LoginBody }
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

async function updateUserRole(
  base: string,
  token: string,
  userId: string,
  role: string
): Promise<Response> {
  return fetch(`${base}/v1/users/${userId}/roles`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ role })
  })
}

after(async () => {
  await Promise.all(apps.map((app) => app.close()))
})

describe('U244 D23 管理员撤销策略（自撤与同级撤销，真实 createApp + HTTP）', () => {
  test('D23/U245③：管理员自撤会话 200、实际撤销 ≥1、恰一条 session_revoke（actor=target=自己）', async () => {
    const { app, base } = await start()
    const admin = await login(base, 'admin', 'Adm1n!')
    assert.equal(admin.status, 200)
    const self = app.store.usersByName.get('admin')
    assert.ok(self)
    assert.equal(admin.body.user?.id, self.id)
    const ownSessions = sessionsOf(app, self.id)
    assert.equal(ownSessions.length, 1, 'the login is the admin session being revoked')
    const token = admin.body.accessToken ?? ''

    const revoked = await revoke(base, token, self.id, { reason: '自撤验证' })

    assert.equal(revoked.status, 200, 'D23 allows an admin to revoke its own sessions')
    const body = (await revoked.json()) as RevokeBody
    assert.equal(body.ok, true)
    assert.ok((body.revokedSessions ?? 0) >= 1, 'the caller’s own session must actually die')
    for (const session of ownSessions) {
      assert.ok(session.revokedAt !== null, 'the admin session must be revoked')
      assert.equal(session.epoch, 2, 'the epoch bump kills the token that sent the request')
    }
    const me = await fetch(`${base}/v1/me`, {
      headers: { authorization: `Bearer ${token}` }
    })
    assert.equal(me.status, 401, 'the self-revoke invalidates the access token immediately')

    const events = app.store.audit.filter((entry) => entry.eventType === 'session_revoke')
    assert.equal(events.length, 1, 'a self-revoke is audited exactly once')
    assert.equal(events[0]?.actor, 'admin', 'actor is the admin who acted on itself')
    assert.equal(events[0]?.targetType, 'user')
    assert.equal(events[0]?.targetId, self.id, 'target is the same admin user id')
    assert.equal(events[0]?.result, 'success')
    assert.equal(events[0]?.metadata.username, 'admin')
    assert.equal(events[0]?.metadata.reason, '自撤验证')
    assert.equal(events[0]?.metadata.revokedSessions, body.revokedSessions)
  })

  test('D23/U245③：管理员 A 撤同级管理员 B 会话 200、会话失效、恰一条 session_revoke（actor=A、target=B）', async () => {
    const { app, base } = await start()
    const adminA = await login(base, 'admin', 'Adm1n!')
    assert.equal(adminA.status, 200)
    const tokenA = adminA.body.accessToken ?? ''
    const lisi = await login(base, 'lisi', 'Passw0rd!')
    assert.equal(lisi.status, 200)
    const targetB = app.store.usersByName.get('lisi')
    assert.ok(targetB)

    // Promote B through the real role endpoint, then sign in again so its token
    // carries platform:admin (roleOverride is applied at login).
    const promoted = await updateUserRole(base, tokenA, targetB.id, 'admin')
    assert.equal(promoted.status, 200)
    const adminB = await login(base, 'lisi', 'Passw0rd!')
    assert.equal(adminB.status, 200)
    assert.ok(
      adminB.body.user?.roles?.includes('platform:admin'),
      'B must be a sibling admin before the revoke'
    )
    const tokenB = adminB.body.accessToken ?? ''
    const sessionsB = sessionsOf(app, targetB.id)
    assert.ok(sessionsB.length >= 1)

    const revoked = await revoke(base, tokenA, targetB.id)

    assert.equal(revoked.status, 200, 'D23 allows revoking a same-level admin')
    const body = (await revoked.json()) as RevokeBody
    assert.equal(body.ok, true)
    assert.ok((body.revokedSessions ?? 0) >= 1, 'B’s sessions must actually be revoked')
    for (const session of sessionsB) {
      assert.ok(session.revokedAt !== null, 'every B session must be revoked')
      assert.equal(session.epoch, 2)
    }
    const meB = await fetch(`${base}/v1/me`, {
      headers: { authorization: `Bearer ${tokenB}` }
    })
    assert.equal(meB.status, 401, 'B loses access immediately')

    const events = app.store.audit.filter(
      (entry) => entry.eventType === 'session_revoke' && entry.targetId === targetB.id
    )
    assert.equal(events.length, 1, 'one sibling revoke, one audit event')
    assert.equal(events[0]?.actor, 'admin', 'actor is admin A')
    assert.equal(events[0]?.targetType, 'user')
    assert.equal(events[0]?.metadata.username, 'lisi', 'target is admin B')
    assert.equal(events[0]?.result, 'success')
    assert.equal(events[0]?.metadata.revokedSessions, body.revokedSessions)
  })
})
