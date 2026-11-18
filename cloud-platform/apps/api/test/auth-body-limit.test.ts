import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp, type ApiHandle } from '../src/server.ts'

/**
 * U249 P3-7: the unauthenticated login/refresh bodies were read without a cap.
 * They now share the logout limit and answer 413 before parsing, while a normal
 * (or long-token) request keeps working.
 */

const ORIGIN = 'https://console.u249.example'
const AUTH_BODY_MAX_BYTES = 16 * 1024
const INTERNAL_BODY_MAX_BYTES = 4 * 1024
const SENSITIVE_WRITE_BODY_MAX_BYTES = 16 * 1024
const DENIED_AUDIT_BODY_MAX_BYTES = 4 * 1024
const INTERNAL_TOKEN = 'u249-token'
const PROJECT_ID = 'proj_payment'
const HOST_ID = 'host_dev001'
const apps: ApiHandle[] = []

async function startApp(): Promise<{ app: ApiHandle; base: string }> {
  const app = createApp({
    port: 0,
    accessTtlMs: 60_000,
    refreshTtlMs: 60_000,
    internalToken: INTERNAL_TOKEN,
    cookieMode: 'auto',
    publicOrigin: ORIGIN
  })
  apps.push(app)
  const port = await app.listen()
  return { app, base: `http://127.0.0.1:${port}` }
}

async function start(): Promise<string> {
  return (await startApp()).base
}

type Json = Record<string, unknown>

function login(base: string, body: string, headers: Record<string, string> = {}) {
  return fetch(`${base}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body
  })
}

function refresh(base: string, body: string, headers: Record<string, string> = {}) {
  return fetch(`${base}/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body
  })
}

function oversized(fields: Record<string, unknown>): string {
  // Comfortably above the cap; the old code buffered all of it before parsing.
  return JSON.stringify({ ...fields, pad: 'x'.repeat(AUTH_BODY_MAX_BYTES * 4) })
}

function postInternal(base: string, path: string, body: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
    body
  })
}

function errorCode(body: Json): unknown {
  const error = body.error
  return error !== null && typeof error === 'object' ? (error as Json).code : undefined
}

async function loginAs(
  base: string,
  username: string,
  password: string,
  device: string
): Promise<{ token: string; userId: string }> {
  const res = await login(base, JSON.stringify({ username, password, deviceName: device }))
  assert.equal(res.status, 200, `${username} must log in`)
  const body = (await res.json()) as Json
  const user = body.user as Json | undefined
  return { token: String(body.accessToken ?? ''), userId: String(user?.id ?? '') }
}

function authedJson(
  base: string,
  token: string,
  method: string,
  path: string,
  body?: string
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body })
  })
}

function oversizedSensitive(fields: Record<string, unknown>): string {
  // The named fields stay legible in the JSON; only the cap decides they are ignored.
  return JSON.stringify({ ...fields, pad: 'x'.repeat(SENSITIVE_WRITE_BODY_MAX_BYTES * 2) })
}

async function deniedAuditEvents(base: string, token: string, actor: string): Promise<Json[]> {
  const query = new URLSearchParams({ actor, result: 'denied', limit: '200' })
  const res = await authedJson(base, token, 'GET', `/v1/audit/events?${query.toString()}`)
  assert.equal(res.status, 200, 'audit query must be available to the admin')
  const body = (await res.json()) as Json
  return (body.events as Json[] | undefined) ?? []
}

function redeemHandoff(
  base: string,
  body: string,
  headers: Record<string, string> = {}
): Promise<Response> {
  return fetch(`${base}/v1/web/handoff`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body
  })
}

function seedHandoff(app: ApiHandle, code: string): void {
  const user = app.store.usersByName.get('zhangsan')
  assert.ok(user)
  app.store.webHandoffs.set(code, {
    userId: user.id,
    projectId: 'proj_payment',
    expiresAt: Date.now() + 60_000
  })
}

after(async () => {
  await Promise.all(apps.map((app) => app.close()))
})

describe('U250 /v1/web/handoff body 上限（未认证）', () => {
  test('合法交接码 2xx（回归）', async () => {
    const { app, base } = await startApp()
    seedHandoff(app, 'u250-valid')

    const res = await redeemHandoff(
      base,
      JSON.stringify({ code: 'u250-valid', deviceName: 'u250' })
    )

    assert.equal(res.status, 200)
    const body = (await res.json()) as Json
    assert.equal((body.user as Json).username, 'zhangsan')
    assert.equal(app.store.webHandoffs.has('u250-valid'), false, 'a redeemed code is consumed')
  })

  test('超大 body → 413 PAYLOAD_TOO_LARGE，且不消耗交接码', async () => {
    const { app, base } = await startApp()
    seedHandoff(app, 'u250-keep')

    const res = await redeemHandoff(base, oversized({ code: 'u250-keep', deviceName: 'u250' }))

    assert.equal(res.status, 413)
    assert.equal(errorCode((await res.json()) as Json), 'PAYLOAD_TOO_LARGE')
    assert.ok(app.store.webHandoffs.has('u250-keep'), 'the code must survive an oversized request')

    const again = await redeemHandoff(base, JSON.stringify({ code: 'u250-keep' }))
    assert.equal(again.status, 200, 'the untouched code still redeems')
  })

  test('有无有效凭据行为一致：未知码、重复 Cookie 同样 413，不泄露凭据状态', async () => {
    const { app, base } = await startApp()
    seedHandoff(app, 'u250-known')

    const known = await redeemHandoff(base, oversized({ code: 'u250-known' }))
    const unknown = await redeemHandoff(base, oversized({ code: 'u250-unknown' }))
    // The cap runs before the Cookie-state checks, so a request that would
    // otherwise be a Cookie 401 is still a content-size 413.
    const ambiguousCookie = await redeemHandoff(base, oversized({ code: 'u250-known' }), {
      cookie: 'orca_refresh=a; orca_refresh=b'
    })

    assert.equal(known.status, 413)
    assert.equal(unknown.status, 413)
    assert.equal(ambiguousCookie.status, 413)
    assert.equal(errorCode((await known.json()) as Json), 'PAYLOAD_TOO_LARGE')
    assert.equal(errorCode((await unknown.json()) as Json), 'PAYLOAD_TOO_LARGE')
    assert.ok(app.store.webHandoffs.has('u250-known'), 'neither request may consume the code')
  })
})

describe('U249 未认证 login/refresh body 上限', () => {
  test('login 超大 body → 413 PAYLOAD_TOO_LARGE，且不建立会话', async () => {
    const base = await start()
    const res = await login(base, oversized({ username: 'admin', password: 'Adm1n!' }))
    assert.equal(res.status, 413)
    assert.equal(errorCode((await res.json()) as Json), 'PAYLOAD_TOO_LARGE')
  })

  test('login 正常 body 仍 200（回归）', async () => {
    const base = await start()
    const res = await login(
      base,
      JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'u249' })
    )
    assert.equal(res.status, 200)
  })

  test('refresh body 分支超大 body → 413，且不消耗原 token', async () => {
    const base = await start()
    const first = (await (
      await login(base, JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'u249' }))
    ).json()) as Json
    const token = first.refreshToken
    assert.equal(typeof token, 'string')

    const huge = await refresh(base, oversized({ refreshToken: token }))
    assert.equal(huge.status, 413)
    assert.equal(errorCode((await huge.json()) as Json), 'PAYLOAD_TOO_LARGE')

    const again = await refresh(base, JSON.stringify({ refreshToken: token }))
    assert.equal(again.status, 200)
  })

  test('refresh Cookie 分支超大 body → 413，Cookie 会话仍可用', async () => {
    const base = await start()
    const loginRes = await login(
      base,
      JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'u249' }),
      { origin: ORIGIN }
    )
    assert.equal(loginRes.status, 200)
    const cookie = loginRes.headers.getSetCookie()[0]?.split(';')[0] ?? ''
    assert.match(cookie, /^orca_refresh=/)

    const huge = await refresh(base, oversized({}), { cookie, origin: ORIGIN })
    assert.equal(huge.status, 413)
    assert.equal(errorCode((await huge.json()) as Json), 'PAYLOAD_TOO_LARGE')

    const small = await refresh(base, '{}', { cookie, origin: ORIGIN })
    assert.equal(small.status, 200)
  })
})

describe('U250 档 2 已鉴权敏感写 body 上限（16 KiB）', () => {
  test('正常写路径：超限 413 PAYLOAD_TOO_LARGE，且先于任何写入', async () => {
    const { app, base } = await startApp()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u250-write-admin')
    const dev = await loginAs(base, 'zhangsan', 'Passw0rd!', 'u250-write-dev')
    assert.notEqual(admin.token, '')
    assert.notEqual(dev.userId, '')

    const cases = [
      {
        name: '项目 grants',
        method: 'PUT',
        path: `/v1/projects/${PROJECT_ID}/grants`,
        body: { subjectType: 'user', subjectId: dev.userId, permissions: ['open'] }
      },
      {
        name: '项目 policy',
        method: 'PUT',
        path: `/v1/projects/${PROJECT_ID}/policy`,
        body: { downloadPolicy: 'allow' }
      },
      {
        name: '用户 roles',
        method: 'PUT',
        path: `/v1/users/${dev.userId}/roles`,
        body: { role: 'auditor' }
      },
      { name: 'hosts/tokens 签发', method: 'POST', path: '/v1/hosts/tokens', body: {} },
      {
        name: 'host grants',
        method: 'PUT',
        path: `/v1/hosts/${HOST_ID}/grants`,
        body: { subjectType: 'user', subjectId: dev.userId, permissions: ['view'] }
      },
      {
        name: 'host provision-policy',
        method: 'PUT',
        path: `/v1/hosts/${HOST_ID}/provision-policy`,
        body: { mode: 'open' }
      },
      {
        name: '全局下载策略',
        method: 'PUT',
        path: '/v1/policies/download',
        body: { downloadDefault: 'allow' }
      }
    ]

    for (const entry of cases) {
      const res = await authedJson(
        base,
        admin.token,
        entry.method,
        entry.path,
        oversizedSensitive(entry.body)
      )
      assert.equal(res.status, 413, `${entry.name} must answer 413`)
      assert.equal(
        errorCode((await res.json()) as Json),
        'PAYLOAD_TOO_LARGE',
        `${entry.name} must name the size refusal`
      )
    }

    // A 413 precedes the write: none of the refused changes may have landed.
    assert.equal(app.store.policies.downloadDefault, 'deny', 'global policy untouched')
    assert.equal(
      app.store.projects.get(PROJECT_ID)?.downloadPolicy,
      'deny',
      'project policy untouched'
    )
    assert.equal(
      app.store.hosts.get(HOST_ID)?.provisionPolicy,
      undefined,
      'provision policy untouched'
    )
    assert.ok(
      !app.store.users.get(dev.userId)?.roles.includes('platform:auditor'),
      'role untouched'
    )
    assert.ok(
      !app.store.grants.some(
        (grant) => grant.projectId === PROJECT_ID && grant.subjectId === dev.userId
      ),
      'project grant untouched'
    )
    assert.ok(
      !app.store.hostGrants.some(
        (grant) => grant.hostId === HOST_ID && grant.subjectId === dev.userId
      ),
      'host grant untouched'
    )
  })

  test('拒绝分支：超限 body 仍 403，denied 审计按空 body 记录', async () => {
    const { base } = await startApp()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u250-deny-admin')
    const dev = await loginAs(base, 'zhangsan', 'Passw0rd!', 'u250-deny-dev')
    const pad = 'x'.repeat(DENIED_AUDIT_BODY_MAX_BYTES * 2)

    const projectGrant = await authedJson(
      base,
      dev.token,
      'PUT',
      `/v1/projects/${PROJECT_ID}/grants`,
      JSON.stringify({ pad, subjectType: 'user', subjectId: dev.userId, permissions: ['open'] })
    )
    assert.equal(projectGrant.status, 403, 'a denied project grant write stays 403')
    assert.equal(
      errorCode((await projectGrant.json()) as Json),
      'PERMISSION_DENIED',
      'the refusal keeps its permission error code'
    )

    const hostGrant = await authedJson(
      base,
      dev.token,
      'PUT',
      `/v1/hosts/${HOST_ID}/grants`,
      JSON.stringify({ pad, subjectType: 'user', subjectId: dev.userId, permissions: ['view'] })
    )
    assert.equal(hostGrant.status, 403, 'a denied host grant write stays 403')
    assert.equal(errorCode((await hostGrant.json()) as Json), 'PERMISSION_DENIED')

    const provision = await authedJson(
      base,
      dev.token,
      'PUT',
      `/v1/hosts/${HOST_ID}/provision-policy`,
      JSON.stringify({ pad, mode: 'open' })
    )
    assert.equal(provision.status, 403, 'a denied provision-policy write stays 403')
    assert.equal(errorCode((await provision.json()) as Json), 'PERMISSION_DENIED')

    // Over the 4 KiB audit cap the body counts as empty, so the record stays
    // bounded instead of echoing an attacker-sized document.
    const events = await deniedAuditEvents(base, admin.token, 'zhangsan')
    const projectEvent = events.find((event) => event.eventType === 'grant_update')
    assert.ok(projectEvent, 'the refused project grant write is audited')
    assert.equal((projectEvent.metadata as Json).subjectId, '')
    assert.deepEqual((projectEvent.metadata as Json).permissions, [])

    const hostEvent = events.find((event) => event.eventType === 'host_grant_update')
    assert.ok(hostEvent, 'the refused host grant write is audited')
    assert.equal((hostEvent.metadata as Json).subjectId, '')
    assert.deepEqual((hostEvent.metadata as Json).permissions, [])

    const provisionEvent = events.find(
      (event) => event.eventType === 'host_provision_policy_update'
    )
    assert.ok(provisionEvent, 'the refused provision-policy write is audited')
    assert.equal((provisionEvent.metadata as Json).mode, '')
  })
})

describe('U250 内部端点 body 上限（4 KiB，超限丢弃整包）', () => {
  test('internal relay-endpoint：超限按空 body 处理，非对象归一化为 {}', async () => {
    const base = await start()
    const valid = JSON.stringify({ id: 'u250-relay', port: 28450 })

    const ok = await postInternal(base, '/v1/internal/relay-endpoint', valid)
    assert.equal(ok.status, 200)

    // An unknown top-level field is ignored by parseRelayRegistration, so a
    // full read would still be a 200; only the discard turns this into a 400.
    const huge = await postInternal(
      base,
      '/v1/internal/relay-endpoint',
      JSON.stringify({ id: 'u250-relay', port: 28450, pad: 'x'.repeat(INTERNAL_BODY_MAX_BYTES * 2) })
    )
    assert.equal(huge.status, 400)
    assert.equal(errorCode((await huge.json()) as Json), 'RELAY_PORT_INVALID')

    const scalar = await postInternal(base, '/v1/internal/relay-endpoint', 'null')
    assert.equal(scalar.status, 400)
    assert.equal(errorCode((await scalar.json()) as Json), 'RELAY_PORT_INVALID')
  })

  test('internal audit file-events：超限按空 body 处理，非对象归一化为 {}', async () => {
    const base = await start()
    const valid = JSON.stringify({ eventType: 'file_download', result: 'success' })

    // No cloud session: a valid body answers 200 without touching the chain.
    const ok = await postInternal(base, '/v1/internal/audit/file-events', valid)
    assert.equal(ok.status, 200)

    // `subject` is an allowed field, so a full read would still be a 200; only
    // the discard (empty body) fails the eventType check.
    const huge = await postInternal(
      base,
      '/v1/internal/audit/file-events',
      JSON.stringify({
        eventType: 'file_download',
        result: 'success',
        subject: 'x'.repeat(INTERNAL_BODY_MAX_BYTES * 2)
      })
    )
    assert.equal(huge.status, 400)
    assert.equal(errorCode((await huge.json()) as Json), 'INVALID_FILE_EVENT')

    const scalar = await postInternal(base, '/v1/internal/audit/file-events', 'null')
    assert.equal(scalar.status, 400)
    assert.equal(errorCode((await scalar.json()) as Json), 'INVALID_FILE_EVENT')
  })
})
