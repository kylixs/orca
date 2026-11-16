import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp, type ApiHandle } from '../../apps/api/src/server.ts'

/**
 * U135: a disabled account must not be re-roled. The write is refused with
 * 409 USER_DISABLED, leaves a role_update denied event, and changes no stored
 * role. Re-enabling restores the ordinary 200 path.
 *
 * In-process app: the disabled flag lives on the store, and the public API has
 * no way to disable an account (the directory owns that state).
 */

const apps: ApiHandle[] = []

type AuditEvent = {
  eventType: string
  actor: string | null
  targetId: string | null
  result: string
  metadata: Record<string, unknown>
}

async function start(): Promise<{ base: string; app: ApiHandle }> {
  const app = createApp({
    port: 0,
    accessTtlMs: 60_000,
    refreshTtlMs: 60_000,
    internalToken: 'u135-token'
  })
  apps.push(app)
  const port = await app.listen()
  return { base: `http://127.0.0.1:${port}`, app }
}

async function login(base: string, username: string, password: string): Promise<string> {
  const res = await fetch(`${base}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, deviceName: 'u135' })
  })
  assert.equal(res.status, 200)
  const body = (await res.json()) as { accessToken: string }
  return body.accessToken
}

async function call(
  base: string,
  token: string,
  path: string,
  method = 'GET',
  body?: unknown
  // oxlint-disable-next-line typescript/no-explicit-any -- assert-driven shape
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

after(async () => {
  await Promise.all(apps.map((app) => app.close()))
})

describe('U135 停用账号不能修改角色', () => {
  test('停用 target → 409 + denied 审计 + 角色未变；启用后仍 200', async () => {
    const { base, app } = await start()
    const adminToken = await login(base, 'admin', 'Adm1n!')
    await login(base, 'lisi', 'Passw0rd!')

    const target = app.store.usersByName.get('lisi')
    assert.ok(target, 'login seeds the directory user')
    const rolesBefore = [...target.roles]
    assert.equal(target.roleOverride, undefined)

    target.status = 'disabled'
    const refused = await call(base, adminToken, `/v1/users/${target.id}/roles`, 'PUT', {
      role: 'auditor'
    })
    assert.equal(refused.status, 409)
    assert.equal(refused.body.error?.code, 'USER_DISABLED')
    assert.match(refused.body.error?.message ?? '', /账号已停用，不能修改角色。/)
    assert.equal(target.roleOverride, undefined, 'the refused write must not set an override')
    assert.deepEqual(target.roles, rolesBefore, 'the refused write must not rewrite roles')

    const denied = await call(
      base,
      adminToken,
      '/v1/audit/events?eventType=role_update&result=denied&limit=50'
    )
    assert.equal(denied.status, 200)
    const event = (denied.body.events as AuditEvent[]).find(
      (entry) => entry.targetId === target.id
    )
    assert.ok(event, 'the refusal must leave a role_update denied event')
    assert.equal(event.actor, 'admin')
    assert.equal(event.result, 'denied')
    assert.equal(event.metadata.username, 'lisi')
    assert.equal(event.metadata.reason, 'USER_DISABLED')

    // Regression: an active account keeps the ordinary write path.
    target.status = 'active'
    const accepted = await call(base, adminToken, `/v1/users/${target.id}/roles`, 'PUT', {
      role: 'auditor'
    })
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body))
    assert.equal(target.roleOverride, 'auditor')
    assert.deepEqual(target.roles, ['developer', 'platform:auditor'])
  })
})
