import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Agent, request as httpRequest } from 'node:http'
import { createApp, type ApiHandle } from '../src/server.ts'
import { startAuditWriter, type AuditWriter } from '../../audit-writer/src/writer.ts'

/**
 * U249 P3-7: the unauthenticated login/refresh bodies were read without a cap.
 * They now share the logout limit and answer 413 before parsing, while a normal
 * (or long-token) request keeps working.
 */

const ORIGIN = 'https://console.u249.example'
const AUTH_BODY_MAX_BYTES = 16 * 1024
const INTERNAL_BODY_MAX_BYTES = 8 * 1024
const SENSITIVE_WRITE_BODY_MAX_BYTES = 16 * 1024
const REGISTER_BODY_MAX_BYTES = 64 * 1024
const DENIED_AUDIT_BODY_MAX_BYTES = 4 * 1024
const HEARTBEAT_BODY_MAX_BYTES = 1024 * 1024
const FILE_EVENT_METADATA_LIMIT = 4096
const PROJECT_PATH_MAX_CHARS = 4096
const INTERNAL_TOKEN = 'u249-token'
const PROJECT_ID = 'proj_payment'
const HOST_ID = 'host_dev001'
const apps: ApiHandle[] = []
const writers: AuditWriter[] = []

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

/** U254: the regression only exists behind the shared writer's 16 KiB event cap. */
async function startAppWithWriter(): Promise<{
  app: ApiHandle
  base: string
  writer: AuditWriter
}> {
  const writer = await startAuditWriter({ port: 0, internalToken: INTERNAL_TOKEN })
  writers.push(writer)
  const app = createApp({
    port: 0,
    accessTtlMs: 60_000,
    refreshTtlMs: 60_000,
    internalToken: INTERNAL_TOKEN,
    cookieMode: 'auto',
    publicOrigin: ORIGIN,
    auditWriterUrl: `http://127.0.0.1:${writer.port}`
  })
  apps.push(app)
  const port = await app.listen()
  return { app, base: `http://127.0.0.1:${port}`, writer }
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

function oversizedBody(fields: Record<string, unknown>): string {
  // The named fields stay legible in the JSON; only the cap decides they are ignored.
  return JSON.stringify({ ...fields, pad: 'x'.repeat(SENSITIVE_WRITE_BODY_MAX_BYTES * 2) })
}

function oversizedRegisterBody(fields: Record<string, unknown>): string {
  // Registration now has its own cap, so the 16 KiB shape above is legal.
  return JSON.stringify({ ...fields, pad: 'x'.repeat(REGISTER_BODY_MAX_BYTES * 2) })
}

/**
 * U252: the registration contract allows 200 projectDirs; a name may reach the
 * filesystem's 255 B limit, so the legal maximum measured ~52 KiB.
 */
function legalMaxRegistration(): { body: string; dirs: string[] } {
  const dirs = Array.from({ length: 200 }, (_, index) => {
    const prefix = `dir${String(index).padStart(3, '0')}`
    return `${prefix}${'d'.repeat(255 - prefix.length)}`
  })
  const body = JSON.stringify({
    name: 'u252-max-register',
    fingerprint: 'sha256:u252-max-register',
    protocolVersion: 3,
    networkZone: 'intranet',
    projectDirs: dirs
  })
  return { body, dirs }
}

function pathOfLength(length: number): string {
  return `/${'p'.repeat(length - 1)}`
}

function repoUrlOfLength(length: number): string {
  const prefix = 'https://git.example.com/'
  const suffix = '.git'
  return `${prefix}${'r'.repeat(length - prefix.length - suffix.length)}${suffix}`
}

async function mintHostToken(base: string, token: string): Promise<string> {
  const res = await authedJson(base, token, 'POST', '/v1/hosts/tokens')
  assert.equal(res.status, 201, 'an admin may mint a host registration token')
  return String(((await res.json()) as Json).token ?? '')
}

function registerHost(base: string, token: string, body: string): Promise<Response> {
  return fetch(`${base}/v1/hosts/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body
  })
}

function postHeartbeat(
  base: string,
  hostId: string,
  credential: string,
  body: string
): Promise<Response> {
  return fetch(`${base}/v1/hosts/${hostId}/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
    body
  })
}

/**
 * U251: the largest beat a current host can legally send — 100 file events whose
 * metadata sits near the platform's 4096 B per-event cap, 200 projectDirs (200 B
 * names), and 32 provision reports (500 B errors). Every shape comes from the
 * upstream producers: `cloud-host-audit.ts` (100/beat), `cloud-project-dirs.ts`
 * (200 names), and `cloud-provision-report-queue.ts` (32 reports).
 */
function legalMaxHeartbeat(): string {
  const metadata = {
    hostId: 'h'.repeat(128),
    hostName: 'n'.repeat(128),
    projectKey: 'p'.repeat(128),
    method: 'm'.repeat(128),
    kind: 'k'.repeat(128),
    surface: 's'.repeat(128),
    capturePoint: 'c'.repeat(128),
    captureConfidence: 'c'.repeat(128),
    copyKind: 'c'.repeat(128),
    policy: 'p'.repeat(128),
    reason: 'r'.repeat(128),
    mime: 'm'.repeat(128),
    clientVersion: 'v'.repeat(64),
    fileName: 'f'.repeat(255),
    savedName: 's'.repeat(255),
    path: 'd'.repeat(1024),
    sizeBytes: Number.MAX_SAFE_INTEGER,
    copiedChars: Number.MAX_SAFE_INTEGER,
    copiedBytes: Number.MAX_SAFE_INTEGER,
    itemCount: Number.MAX_SAFE_INTEGER,
    occurredAt: Number.MAX_SAFE_INTEGER,
    isBinary: true,
    truncated: true,
    excerptTruncated: false,
    sha256: 'a'.repeat(64),
    sha256Source: 'host'
  }
  assert.ok(
    Buffer.byteLength(JSON.stringify(metadata)) <= FILE_EVENT_METADATA_LIMIT,
    'the fixture metadata must stay inside the per-event cap or the event is dropped'
  )

  const audit = Array.from({ length: 100 }, (_, index) => ({
    eventType: 'file_download',
    result: 'success',
    deviceId: `device_u251_${index}`,
    subject: 'user:zhangsan',
    projectId: PROJECT_ID,
    method: 'GET',
    traceId: `trace_u251_${index}`,
    metadata
  }))
  const projectDirs = Array.from(
    { length: 200 },
    (_, index) => `dir${String(index).padStart(3, '0')}${'d'.repeat(194)}`
  )
  const provisioned = Array.from({ length: 32 }, (_, index) => ({
    projectId: `proj_u251_${index}`,
    ok: false,
    error: 'e'.repeat(500)
  }))

  return JSON.stringify({
    status: 'online',
    directAddrs: ['192.168.10.10:5210'],
    projectDirs,
    provisioned,
    audit,
    orcaVersion: '1.5.0'
  })
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

/**
 * U251: declares `content-length` above the cap but only writes a prefix. The
 * server must answer from the header alone, without waiting for the body.
 */
function declaredOversizedRequest(
  base: string,
  path: string,
  declared: number
): Promise<{ status: number; connection: string | undefined; body: string; elapsedMs: number }> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const req = httpRequest(
      `${base}${path}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': String(declared) }
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          body += chunk
        })
        res.on('end', () => {
          const elapsedMs = Date.now() - started
          clearTimeout(deadline)
          req.destroy()
          resolve({
            status: res.statusCode ?? 0,
            connection: res.headers.connection,
            body,
            elapsedMs
          })
        })
      }
    )
    // A server that waits for the rest of the declared body must fail, not hang.
    const deadline = setTimeout(() => {
      req.destroy()
      reject(new Error('no 413 before the deadline: the server waited for the full body'))
    }, 1500)
    req.on('error', reject)
    req.write('{"username":"admin"')
  })
}

/**
 * U251: streams a chunked body (no `content-length`) past the cap until the
 * server closes. Reports when the 413 and the socket close arrived.
 */
function streamingOversizedRequest(
  base: string,
  path: string
): Promise<{
  status: number
  connection: string | undefined
  responseMs: number
  closeMs: number
  sentBytes: number
}> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    let status = 0
    let connection: string | undefined
    let responseMs = 0
    let closeMs = 0
    let sentBytes = 0
    let headersReceived = false
    let socketClosed = false
    let settled = false
    const finish = (): void => {
      if (!headersReceived || !socketClosed || settled) return
      settled = true
      clearInterval(writeTimer)
      clearTimeout(deadline)
      resolve({ status, connection, responseMs, closeMs, sentBytes })
    }
    const req = httpRequest(
      `${base}${path}`,
      { method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        responseMs = Date.now() - started
        status = res.statusCode ?? 0
        connection = res.headers.connection
        headersReceived = true
        // The refusal arrived: stop feeding the stream and let the socket close.
        clearInterval(writeTimer)
        res.resume()
        finish()
      }
    )
    req.on('socket', (socket) => {
      socket.once('close', () => {
        closeMs = Date.now() - started
        socketClosed = true
        finish()
      })
    })
    // A reset after the headers is expected; only an early failure is fatal.
    req.on('error', (error: Error) => {
      if (headersReceived || settled) return
      clearInterval(writeTimer)
      clearTimeout(deadline)
      reject(error)
    })
    const chunk = Buffer.alloc(8 * 1024, 'x')
    const writeTimer = setInterval(() => {
      if (headersReceived) return
      try {
        req.write(chunk)
        sentBytes += chunk.length
      } catch {
        // Writing after the reset is the expected outcome.
      }
    }, 2)
    // A server that drains the whole stream must fail, not hang.
    const deadline = setTimeout(() => {
      clearInterval(writeTimer)
      req.destroy()
      reject(new Error('no 413 before the deadline: the stream was drained to completion'))
    }, 2000)
  })
}

function agentPost(
  agent: Agent,
  url: string,
  body: string
): Promise<{ status: number; reused: boolean }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      {
        method: 'POST',
        agent,
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body))
        }
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve({ status: res.statusCode ?? 0, reused: req.reusedSocket }))
      }
    )
    req.on('error', reject)
    req.end(body)
  })
}

after(async () => {
  await Promise.all(apps.map((app) => app.close()))
  await Promise.all(writers.map((writer) => writer.close()))
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
        oversizedBody(entry.body)
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

describe('U250/U251 内部端点 body 上限（8 KiB，超限丢弃整包）', () => {
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

  test('file-events：4096 B metadata + 顶层字段的合法包（>4 KiB）不被丢弃', async () => {
    const base = await start()
    // A real event may carry metadata up to FILE_EVENT_METADATA_LIMIT (4096 B)
    // plus its envelope; the old 4 KiB cap turned that legal shape into `{}`.
    const envelope = JSON.stringify({
      eventType: 'file_download',
      result: 'success',
      subject: 's'.repeat(4 * 1024),
      metadata: { path: 'd'.repeat(1024) }
    })
    const bytes = Buffer.byteLength(envelope)
    assert.ok(bytes > 4 * 1024, `fixture is ${bytes} B, must exceed the old cap`)
    assert.ok(bytes < INTERNAL_BODY_MAX_BYTES, `fixture is ${bytes} B, must fit the new cap`)

    const res = await postInternal(base, '/v1/internal/audit/file-events', envelope)
    assert.equal(res.status, 200, await res.text())
  })
})

describe('U250 档 3 普通读写调用点 body 上限（16 KiB）', () => {
  test('POST /v1/projects：超限 413 且不创建项目，正常 body 仍 201', async () => {
    const { app, base } = await startApp()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u250-tier3-project')
    const before = app.store.projects.size
    const fields = {
      hostId: HOST_ID,
      key: 'u250-bounded-project',
      name: 'u250-bounded-project',
      path: '/srv/work/u250-bounded-project',
      defaultBranch: 'main'
    }

    const res = await authedJson(base, admin.token, 'POST', '/v1/projects', oversizedBody(fields))
    assert.equal(res.status, 413)
    assert.equal(errorCode((await res.json()) as Json), 'PAYLOAD_TOO_LARGE')
    assert.equal(app.store.projects.size, before, 'the refused create adds no project')
    assert.equal(
      [...app.store.projects.values()].some((project) => project.key === fields.key),
      false
    )

    const ok = await authedJson(base, admin.token, 'POST', '/v1/projects', JSON.stringify(fields))
    assert.equal(ok.status, 201)
    assert.ok(app.store.projectsByKey.has(fields.key), 'a normal body still creates the project')
  })

  test('POST /v1/hosts/register：超限 413 且不消耗注册令牌，错误可诊断', async () => {
    const { app, base } = await startApp()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u250-tier3-register')
    const token = await mintHostToken(base, admin.token)
    const fields = {
      name: 'u250-bounded-host',
      fingerprint: 'sha256:u250-bounded-host',
      protocolVersion: 3,
      networkZone: 'intranet'
    }

    // U252: registration has its own 64 KiB cap, so the overage is 128 KiB.
    const res = await registerHost(base, token, oversizedRegisterBody(fields))
    assert.equal(res.status, 413)
    const payload = (await res.json()) as Json
    assert.equal(errorCode(payload), 'PAYLOAD_TOO_LARGE')
    const failure = payload.error as Json
    assert.equal(typeof failure.traceId, 'string', 'the wire refusal names a trace id')
    assert.equal(app.store.hostsByName.has(fields.name), false)

    // The token is single-use and must survive the refusal.
    const retried = await registerHost(base, token, JSON.stringify(fields))
    assert.equal(retried.status, 201)
    assert.ok(app.store.hostsByName.has(fields.name))
  })

  test('POST /v1/audit/export：超限 413 且不创建导出任务', async () => {
    const { app, base } = await startApp()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u250-tier3-export')

    const res = await authedJson(
      base,
      admin.token,
      'POST',
      '/v1/audit/export',
      oversizedBody({ confirm: true, format: 'jsonl' })
    )

    assert.equal(res.status, 413)
    assert.equal(errorCode((await res.json()) as Json), 'PAYLOAD_TOO_LARGE')
    assert.equal(app.auditExportStore.countActive(admin.userId), 0, 'no job was accepted')
  })

  test('其余 6 个普通调用点超限同样 413', async () => {
    const { app, base } = await startApp()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u250-tier3-other-admin')
    const dev = await loginAs(base, 'zhangsan', 'Passw0rd!', 'u250-tier3-other-dev')
    const beforeProjects = app.store.projects.size

    const cases: Array<{
      name: string
      token: string
      method: string
      path: string
      body: Json
    }> = [
      {
        name: '项目更新',
        token: admin.token,
        method: 'PUT',
        path: `/v1/projects/${PROJECT_ID}`,
        body: { repoUrl: 'https://git.example.com/u250/bounded.git' }
      },
      {
        name: '自助项目创建',
        token: dev.token,
        method: 'POST',
        path: '/v1/projects/self',
        body: { name: 'u250-self-service' }
      },
      {
        name: '主机维护',
        token: admin.token,
        method: 'POST',
        path: `/v1/hosts/${HOST_ID}/maintenance`,
        body: { enabled: true }
      },
      {
        name: 'web 交接',
        token: admin.token,
        method: 'POST',
        path: `/v1/projects/${PROJECT_ID}/web-handoff`,
        body: { surface: 'admin' }
      },
      {
        name: '连接',
        token: admin.token,
        method: 'POST',
        path: `/v1/projects/${PROJECT_ID}/connect`,
        body: {}
      }
    ]

    for (const entry of cases) {
      const res = await authedJson(
        base,
        entry.token,
        entry.method,
        entry.path,
        oversizedBody(entry.body)
      )
      assert.equal(res.status, 413, `${entry.name} must answer 413`)
      assert.equal(errorCode((await res.json()) as Json), 'PAYLOAD_TOO_LARGE', entry.name)
    }

    assert.equal(app.store.projects.size, beforeProjects, 'no project was created or replaced')
    assert.equal(
      app.store.projects.get(PROJECT_ID)?.repoUrl,
      'git@git.example.com:pay/payment-service.git'
    )
    assert.equal(app.store.hosts.get(HOST_ID)?.status, 'online', 'maintenance was not applied')
    assert.equal(app.store.webHandoffs.size, 0, 'no handoff code was minted')

    // U251: heartbeat is no longer a 16 KiB sensitive write; a 32 KiB beat is a
    // legal batch headroom case and must be accepted.
    const hostToken = await mintHostToken(base, admin.token)
    const registered = await registerHost(
      base,
      hostToken,
      JSON.stringify({ name: 'u250-beat-host', protocolVersion: 3, networkZone: 'intranet' })
    )
    assert.equal(registered.status, 201)
    const host = (await registered.json()) as Json
    const beat = await postHeartbeat(
      base,
      String(host.hostId),
      String(host.credential),
      oversizedBody({ status: 'online' })
    )
    assert.equal(beat.status, 200, await beat.text())
  })
})

describe('U252 register 独立 body 上限（64 KiB）', () => {
  test('注册契约合法最大包（200 × 255 B projectDirs）→ 201，目录全部入存储', async () => {
    const { app, base } = await startApp()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u252-max-admin')
    const token = await mintHostToken(base, admin.token)
    const { body, dirs } = legalMaxRegistration()
    const bytes = Buffer.byteLength(body)
    assert.ok(bytes > SENSITIVE_WRITE_BODY_MAX_BYTES, `fixture is ${bytes} B, must exceed 16 KiB`)
    assert.ok(bytes < REGISTER_BODY_MAX_BYTES, `fixture is ${bytes} B, must fit the 64 KiB cap`)

    const res = await registerHost(base, token, body)
    const payload = (await res.json()) as Json
    assert.equal(res.status, 201, JSON.stringify(payload))
    const stored = app.store.hosts.get(String(payload.hostId))
    assert.equal(stored?.projectDirs.length, 200, 'every legal directory was stored')
    assert.deepEqual(stored?.projectDirs, [...dirs].sort())
  })

  test('超过 64 KiB → 413 PAYLOAD_TOO_LARGE，且注册令牌未被消耗', async () => {
    const { app, base } = await startApp()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u252-huge-admin')
    const token = await mintHostToken(base, admin.token)
    const fields = {
      name: 'u252-huge-host',
      fingerprint: 'sha256:u252-huge-host',
      protocolVersion: 3,
      networkZone: 'intranet'
    }

    const huge = await registerHost(base, token, oversizedRegisterBody(fields))
    assert.equal(huge.status, 413)
    assert.equal(errorCode((await huge.json()) as Json), 'PAYLOAD_TOO_LARGE')
    assert.equal(app.store.hostsByName.has(fields.name), false)

    const retried = await registerHost(base, token, JSON.stringify(fields))
    assert.equal(retried.status, 201, 'the single-use token survives the refusal')
    assert.ok(app.store.hostsByName.has(fields.name))
  })
})

describe('U252 项目 path 契约上限（4096 字符）', () => {
  test('path 4096 字符 → 201，正常创建', async () => {
    const { app, base } = await startApp()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u252-path-4096-admin')
    const path = pathOfLength(PROJECT_PATH_MAX_CHARS)
    const key = 'u252-path-4096'

    const res = await authedJson(
      base,
      admin.token,
      'POST',
      '/v1/projects',
      JSON.stringify({ hostId: HOST_ID, key, name: key, path, defaultBranch: 'main' })
    )
    assert.equal(res.status, 201, await res.text())
    const stored = [...app.store.projects.values()].find((project) => project.key === key)
    assert.equal(stored?.path, path)
  })

  test('path 4097 字符 → 400 PROJECT_PATH_INVALID，且不创建项目', async () => {
    const { app, base } = await startApp()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u252-path-4097-admin')
    const path = pathOfLength(PROJECT_PATH_MAX_CHARS + 1)
    const key = 'u252-path-4097'

    const res = await authedJson(
      base,
      admin.token,
      'POST',
      '/v1/projects',
      JSON.stringify({ hostId: HOST_ID, key, name: key, path, defaultBranch: 'main' })
    )
    assert.equal(res.status, 400)
    assert.equal(errorCode((await res.json()) as Json), 'PROJECT_PATH_INVALID')
    assert.equal(app.store.projectsByKey.has(key), false, 'the refused create adds no project')
  })

  test('path 4000 + repoUrl 4096 → 201，不再依赖 body 上限兜底', async () => {
    const { app, base } = await startApp()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u252-path-repo-admin')
    const path = pathOfLength(4000)
    const repoUrl = repoUrlOfLength(4096)
    assert.equal(repoUrl.length, 4096)
    const key = 'u252-path-repo'

    const res = await authedJson(
      base,
      admin.token,
      'POST',
      '/v1/projects',
      JSON.stringify({
        hostId: HOST_ID,
        key,
        name: key,
        path,
        repoUrl,
        defaultBranch: 'main'
      })
    )
    assert.equal(res.status, 201, await res.text())
    const stored = app.store.projectsByKey.get(key)
    assert.equal(stored?.path.length, 4000)
    assert.equal(stored?.repoUrl.length, 4096)
  })
})

describe('U251 heartbeat 独立 body 上限（1 MiB）', () => {
  test('100 审计事件（4096 B metadata）+ 200 projectDirs + 32 报告 → 200，整批入链', async () => {
    const { app, base } = await startApp()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u251-beat-admin')
    const hostToken = await mintHostToken(base, admin.token)
    const registered = await registerHost(
      base,
      hostToken,
      JSON.stringify({ name: 'u251-beat-host', protocolVersion: 3, networkZone: 'intranet' })
    )
    assert.equal(registered.status, 201)
    const host = (await registered.json()) as Json
    const hostId = String(host.hostId)

    const body = legalMaxHeartbeat()
    const bodyBytes = Buffer.byteLength(body)
    assert.ok(bodyBytes > SENSITIVE_WRITE_BODY_MAX_BYTES, 'the legal beat exceeds the old 16 KiB cap')
    assert.ok(bodyBytes < HEARTBEAT_BODY_MAX_BYTES, 'the legal beat stays inside the new cap')

    const beat = await postHeartbeat(base, hostId, String(host.credential), body)
    assert.equal(beat.status, 200, await beat.text())

    // The host only calls clearThrough after beat.ok, so a 200 with the whole
    // batch in the chain is exactly the acknowledgement that unblocks it.
    const query = await authedJson(
      base,
      admin.token,
      'GET',
      '/v1/audit/events?eventType=file_download&limit=200'
    )
    assert.equal(query.status, 200)
    const page = (await query.json()) as Json
    const events = (page.events as Json[] | undefined) ?? []
    assert.equal(events.length, 100, 'the platform accepted every event in the batch')
    assert.equal((events[0]?.metadata as Json | undefined)?.path, 'd'.repeat(1024))

    const stored = app.store.hosts.get(hostId)
    assert.equal(stored?.projectDirs.length, 200, 'all 200 reported directories were stored')
    assert.ok(stored?.projectDirs.every((dir) => dir.length === 200))
  })

  test('超过 1 MiB → 413 PAYLOAD_TOO_LARGE，心跳状态不写入', async () => {
    const { app, base } = await startApp()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u251-huge-admin')
    const hostToken = await mintHostToken(base, admin.token)
    const registered = await registerHost(
      base,
      hostToken,
      JSON.stringify({ name: 'u251-huge-host', protocolVersion: 3, networkZone: 'intranet' })
    )
    assert.equal(registered.status, 201)
    const host = (await registered.json()) as Json
    const hostId = String(host.hostId)

    const huge = JSON.stringify({
      status: 'offline',
      pad: 'x'.repeat(HEARTBEAT_BODY_MAX_BYTES + 1024)
    })
    const beat = await postHeartbeat(base, hostId, String(host.credential), huge)
    assert.equal(beat.status, 413)
    assert.equal(errorCode((await beat.json()) as Json), 'PAYLOAD_TOO_LARGE')
    assert.equal(app.store.hosts.get(hostId)?.status, 'online', 'the refused beat changed nothing')
  })
})

describe('U251 超限早拒（不等待、不排空请求体）', () => {
  test('声明 content-length 远超上限：只发少量前缀即收到 413 且 Connection: close', async () => {
    const base = await start()
    // 8 MiB is past the bounded drain budget, so the refusal must come from the
    // header alone. A modest overage is drained first for client compatibility.
    const { status, connection, body, elapsedMs } = await declaredOversizedRequest(
      base,
      '/v1/auth/login',
      8 * 1024 * 1024
    )

    assert.equal(status, 413)
    assert.equal(connection, 'close')
    assert.equal(errorCode(JSON.parse(body) as Json), 'PAYLOAD_TOO_LARGE')
    assert.ok(elapsedMs < 1000, `the refusal waited ${elapsedMs}ms for the declared body`)
  }, { timeout: 5000 })

  test('chunked 持续发送超限：立即 413、连接关闭且不再消费', async () => {
    const base = await start()
    const { status, connection, responseMs, closeMs, sentBytes } =
      await streamingOversizedRequest(base, '/v1/auth/login')

    assert.equal(status, 413)
    assert.equal(connection, 'close')
    assert.ok(responseMs < 1000, `the refusal arrived after ${responseMs}ms`)
    assert.ok(closeMs >= responseMs, 'the connection closes only after the refusal')
    assert.ok(sentBytes > AUTH_BODY_MAX_BYTES, `the client streamed ${sentBytes} B before the close`)
  }, { timeout: 5000 })

  test('keep-alive：未超限的正常请求继续复用同一连接', async () => {
    const base = await start()
    const agent = new Agent({ keepAlive: true, maxSockets: 1 })
    try {
      const first = await agentPost(
        agent,
        `${base}/v1/auth/login`,
        JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'u251-ka-1' })
      )
      const second = await agentPost(
        agent,
        `${base}/v1/auth/login`,
        JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'u251-ka-2' })
      )

      assert.equal(first.status, 200)
      assert.equal(second.status, 200)
      assert.equal(first.reused, false, 'the first request opens the connection')
      assert.equal(second.reused, true, 'a normal request keeps the connection usable')
    } finally {
      agent.destroy()
    }
  }, { timeout: 5000 })
})

describe('U251 P3 审计可用性检查先于 policy 读取', () => {
  test('审计链损坏 + 超限 body → 503 AUDIT_CHAIN_BROKEN，而非 413', async () => {
    const { app, base } = await startApp()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u251-policy-order')

    if (app.store.audit.length === 0) {
      app.audit.append({
        eventType: 'login',
        actor: 'admin',
        targetType: 'session',
        targetId: null,
        result: 'success',
        traceId: 'u251-seed'
      })
    }
    const first = app.store.audit[0]
    assert.ok(first)
    first.metadata = { ...first.metadata, tampered: true }
    assert.equal(app.audit.verify().ok, false, 'the chain is now broken')

    const res = await authedJson(
      base,
      admin.token,
      'PUT',
      `/v1/projects/${PROJECT_ID}/policy`,
      oversizedBody({ downloadPolicy: 'allow' })
    )

    assert.equal(res.status, 503)
    assert.equal(errorCode((await res.json()) as Json), 'AUDIT_CHAIN_BROKEN')
    assert.equal(app.store.projects.get(PROJECT_ID)?.downloadPolicy, 'deny', 'nothing was written')
  }, { timeout: 5000 })
})

/**
 * U254: the writer refuses any event over 16 KiB (`BATCH_INVALID`). These legal
 * 16 KiB bodies had their oversized field copied verbatim into `metadata`, so
 * the event was refused, the audit gate answered 503, and the operation never
 * happened. The fields are now truncated at the audit landing point.
 */
describe('U254 超长 body 字段不得把审计事件撑过 writer 16 KiB', () => {
  const MAINTENANCE_REASON_MAX_CHARS = 200
  const PROJECT_KEY_MAX_CHARS = 64
  // Just under the 16 KiB sensitive-write body cap; the audit envelope pushes
  // the same value over the writer's per-event cap.
  const OVERSIZED_FIELD_CHARS = SENSITIVE_WRITE_BODY_MAX_BYTES - 128

  test('16 KiB maintenance reason → 2xx，维护生效且事件入链，reason 截断到 200', async () => {
    const { app, base } = await startAppWithWriter()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u254-maintenance-admin')
    const reason = 'r'.repeat(OVERSIZED_FIELD_CHARS)
    const body = JSON.stringify({ enabled: true, reason })
    assert.ok(Buffer.byteLength(body) < SENSITIVE_WRITE_BODY_MAX_BYTES, 'the body is legal')
    assert.ok(
      Buffer.byteLength(
        JSON.stringify({
          eventType: 'host_maintenance',
          actor: 'admin',
          targetType: 'host',
          targetId: HOST_ID,
          result: 'success',
          traceId: '0'.repeat(36),
          metadata: { enabled: true, reason }
        })
      ) > 16 * 1024,
      'the untruncated event exceeds the writer cap'
    )

    const res = await authedJson(
      base,
      admin.token,
      'POST',
      `/v1/hosts/${HOST_ID}/maintenance`,
      body
    )
    assert.equal(res.status, 200, await res.text())
    assert.equal(app.store.hosts.get(HOST_ID)?.status, 'maintenance', '维护已生效')

    const query = await authedJson(
      base,
      admin.token,
      'GET',
      '/v1/audit/events?eventType=host_maintenance&limit=200'
    )
    assert.equal(query.status, 200)
    const events = (((await query.json()) as Json).events as Json[] | undefined) ?? []
    assert.equal(events.length, 1, 'the maintenance event is in the chain')
    const storedReason = (events[0]?.metadata as Json | undefined)?.reason
    assert.equal(typeof storedReason, 'string')
    assert.equal((storedReason as string).length, MAINTENANCE_REASON_MAX_CHARS)
    assert.equal(storedReason, 'r'.repeat(MAINTENANCE_REASON_MAX_CHARS))
  })

  test('16 KiB 非法 project path → 400，拒绝事件入链，path 截断到 4096', async () => {
    const { app, base } = await startAppWithWriter()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u254-path-admin')
    const key = 'u254-path-oversize'
    const path = pathOfLength(OVERSIZED_FIELD_CHARS)
    const body = JSON.stringify({ hostId: HOST_ID, key, name: key, path, defaultBranch: 'main' })
    assert.ok(Buffer.byteLength(body) < SENSITIVE_WRITE_BODY_MAX_BYTES, 'the body is legal')

    const res = await authedJson(base, admin.token, 'POST', '/v1/projects', body)
    const payload = (await res.json()) as Json
    assert.equal(res.status, 400, JSON.stringify(payload))
    assert.equal(errorCode(payload), 'PROJECT_PATH_INVALID')
    assert.equal(app.store.projectsByKey.has(key), false, '拒绝时未创建项目')

    const denied = await deniedAuditEvents(base, admin.token, 'admin')
    const event = denied.find(
      (entry) => (entry.metadata as Json | undefined)?.reason === 'PROJECT_PATH_INVALID'
    )
    assert.ok(event, 'the refused create is audited')
    assert.equal(((event.metadata as Json).path as string).length, PROJECT_PATH_MAX_CHARS)
  })

  test('16 KiB 非法 project key → 400，拒绝事件入链，key 截断到 64', async () => {
    const { app, base } = await startAppWithWriter()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u254-key-admin')
    const key = 'k'.repeat(OVERSIZED_FIELD_CHARS)
    const body = JSON.stringify({ hostId: HOST_ID, key })
    assert.ok(Buffer.byteLength(body) < SENSITIVE_WRITE_BODY_MAX_BYTES, 'the body is legal')

    const res = await authedJson(base, admin.token, 'POST', '/v1/projects', body)
    const payload = (await res.json()) as Json
    assert.equal(res.status, 400, JSON.stringify(payload))
    assert.equal(errorCode(payload), 'PROJECT_KEY_INVALID')
    assert.equal(app.store.projectsByKey.has(key), false, '拒绝时未创建项目')

    const denied = await deniedAuditEvents(base, admin.token, 'admin')
    const event = denied.find(
      (entry) => (entry.metadata as Json | undefined)?.reason === 'PROJECT_KEY_INVALID'
    )
    assert.ok(event, 'the refused create is audited')
    assert.equal(((event.metadata as Json).key as string).length, PROJECT_KEY_MAX_CHARS)
  })
})
