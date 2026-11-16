import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { login, registerHost, saveEvidence, spawnService, type Service } from './harness.ts'
import { loadWebConsolePage } from './web-console-page.ts'

/**
 * U58 P3 batch (exploratory r2 `api.json`): malformed input used to be coerced
 * into a plausible-looking state. Each case here is the probe payload, asserted
 * against a real platform process.
 *  - PX1: a credentialed clone URL must not reach a non-admin reader.
 *  - H7: a token-only registration must not create a nameless host.
 *  - H12b: a bad heartbeat `status` must not be stored as offline.
 *  - H18: a relative `projectsRoot` must be reported, not silently dropped.
 *  - H23: `enabled: "false"` must not enter maintenance.
 *  - Y13: a non-safe-integer read budget must not be accepted.
 *  - Y14: an unknown `downloadDefault` must not be coerced to deny.
 * U54 WEB-R2-017: Escape closes a host drawer.
 */

const EVIDENCE = 'u58-input-hardening'

type Json = Record<string, unknown>

let api: Service
let adminToken = ''
let hostId = ''
let projectId = ''

function auth(token = adminToken): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${token}` }
}

async function call(
  path: string,
  method = 'GET',
  body?: unknown,
  token = adminToken
): Promise<{ status: number; body: Json; text: string }> {
  const res = await fetch(`${api.url}${path}`, {
    method,
    headers: auth(token),
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  const text = await res.text()
  return { status: res.status, body: text ? (JSON.parse(text) as Json) : {}, text }
}

async function hostRow(id: string): Promise<Json> {
  const res = await call('/v1/hosts')
  assert.equal(res.status, 200, res.text)
  const row = (res.body.hosts as Json[]).find((host) => host.id === id)
  assert.ok(row, `host ${id} missing`)
  return row
}

async function heartbeat(
  id: string,
  credential: string,
  body: Json
): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${api.url}/v1/hosts/${id}/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
    body: JSON.stringify(body)
  })
  return { status: res.status, body: (await res.json()) as Json }
}

before(async () => {
  api = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN: 'u58-internal-token' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-u58-hardening'
  )
  adminToken = await login(api.url, 'admin', 'Adm1n!')
  const host = await registerHost({
    apiUrl: api.url,
    adminToken,
    name: 'u58-host',
    directAddr: '127.0.0.1:19121',
    relayTarget: '127.0.0.1:19121',
    projectsRoot: '/srv/u58-work'
  })
  hostId = host.hostId
  const created = await call('/v1/projects', 'POST', {
    key: 'u58-secret',
    name: 'u58-secret',
    hostId,
    path: '/srv/u58-work/u58-secret',
    repoUrl: 'https://probe-user:S3cretProbe@git.example.com/team/secret.git'
  })
  assert.equal(created.status, 201, created.text)
  projectId = created.body.id as string
  const granted = await call(`/v1/projects/${projectId}/grants`, 'PUT', {
    subjectType: 'user',
    subjectId: 'zhangsan',
    permissions: ['open']
  })
  assert.equal(granted.status, 200, granted.text)
}, 120_000)

after(async () => {
  await api?.stop()
  saveEvidence(EVIDENCE, 'summary.json', {
    unit: 'U58 P3 + U54 WEB-R2-017',
    projectId,
    hostId
  })
})

test('U58 PX1 普通用户读不到含凭据的 repoUrl，管理员仍可见', async () => {
  const devToken = await login(api.url, 'zhangsan', 'Passw0rd!')
  const list = await call('/v1/projects', 'GET', undefined, devToken)
  assert.equal(list.status, 200, list.text)
  const row = (list.body.projects as { id: string; repoUrl: string }[]).find(
    (p) => p.id === projectId
  )
  assert.ok(row, 'the granted project must be listed')
  assert.ok(!row.repoUrl.includes('probe-user'), row.repoUrl)
  assert.ok(!row.repoUrl.includes('S3cretProbe'), row.repoUrl)
  assert.equal(row.repoUrl, 'https://git.example.com/team/secret.git')

  const detail = await call(`/v1/projects/${projectId}`, 'GET', undefined, devToken)
  assert.equal(detail.status, 200, detail.text)
  assert.equal(detail.body.repoUrl, 'https://git.example.com/team/secret.git')

  const adminView = await call(`/v1/projects/${projectId}`)
  assert.equal(adminView.status, 200, adminView.text)
  assert.match(adminView.body.repoUrl as string, /probe-user:S3cretProbe@/)
})

test('U58 H7 缺 name 的注册被拒，且令牌未被消耗', async () => {
  const tokenRes = await call('/v1/hosts/tokens', 'POST')
  assert.equal(tokenRes.status, 201, tokenRes.text)
  const token = tokenRes.body.token as string
  const refused = await fetch(`${api.url}/v1/hosts/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({})
  })
  const refusedBody = (await refused.json()) as Json
  assert.equal(refused.status, 400, JSON.stringify(refusedBody))
  assert.equal((refusedBody.error as Json).code, 'HOST_NAME_REQUIRED')
  assert.equal(
    [...((await call('/v1/hosts')).body.hosts as Json[])].some((h) => h.name === ''),
    false,
    'no nameless host may exist'
  )

  // The same one-time token still registers a named host.
  const accepted = await fetch(`${api.url}/v1/hosts/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: 'u58-named', directAddrs: ['127.0.0.1:19122'] })
  })
  assert.equal(accepted.status, 201, await accepted.text())
})

test('U58 H12b 心跳 status 只接受 online/offline', async () => {
  const host = await registerHost({
    apiUrl: api.url,
    adminToken,
    name: 'u58-status-host',
    directAddr: '127.0.0.1:19123',
    relayTarget: '127.0.0.1:19123'
  })
  const refused = await heartbeat(host.hostId, host.credential, { status: 'banana' })
  assert.equal(refused.status, 400, JSON.stringify(refused.body))
  assert.equal((refused.body.error as Json).code, 'HOST_STATUS_INVALID')
  assert.equal((await hostRow(host.hostId)).online, true, 'the bad beat must not mark it offline')

  const accepted = await heartbeat(host.hostId, host.credential, { status: 'offline' })
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body))
  assert.equal((await hostRow(host.hostId)).online, false)
})

test('U58 H18 相对 projectsRoot 被拒并显式告知', async () => {
  const host = await registerHost({
    apiUrl: api.url,
    adminToken,
    name: 'u58-root-host',
    directAddr: '127.0.0.1:19124',
    relayTarget: '127.0.0.1:19124'
  })
  const refused = await heartbeat(host.hostId, host.credential, {
    projectsRoot: 'relative/path'
  })
  assert.equal(refused.status, 200, JSON.stringify(refused.body))
  assert.equal(refused.body.projectsRootRejected, 'PROJECTS_ROOT_INVALID')
  assert.equal((await hostRow(host.hostId)).projectsRoot, null)

  const accepted = await heartbeat(host.hostId, host.credential, {
    projectsRoot: '/srv/u58-root'
  })
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body))
  assert.equal(accepted.body.projectsRootRejected, undefined)
  assert.equal((await hostRow(host.hostId)).projectsRoot, '/srv/u58-root')
})

test('U58 H23 维护开关的 enabled 必须是布尔值', async () => {
  const host = await registerHost({
    apiUrl: api.url,
    adminToken,
    name: 'u58-maint-host',
    directAddr: '127.0.0.1:19125',
    relayTarget: '127.0.0.1:19125'
  })
  const refused = await call(`/v1/hosts/${host.hostId}/maintenance`, 'POST', {
    enabled: 'false'
  })
  assert.equal(refused.status, 400, refused.text)
  assert.equal((refused.body.error as Json).code, 'HOST_MAINTENANCE_INVALID')
  assert.equal((await hostRow(host.hostId)).online, true, 'a string must not enter maintenance')

  assert.equal(
    (await call(`/v1/hosts/${host.hostId}/maintenance`, 'POST', { enabled: true })).status,
    200
  )
  assert.equal(
    (
      await call(`/v1/hosts/${host.hostId}/maintenance`, 'POST', {
        enabled: false
      })
    ).status,
    200
  )
  assert.equal((await hostRow(host.hostId)).online, true)
})

test('U58 H24c 退出维护后不再返回陈旧的维护原因', async () => {
  const host = await registerHost({
    apiUrl: api.url,
    adminToken,
    name: 'u58-maint-reason-host',
    directAddr: '127.0.0.1:19126',
    relayTarget: '127.0.0.1:19126'
  })
  const created = await call('/v1/projects', 'POST', {
    key: 'u58-maint-reason',
    name: 'u58-maint-reason',
    hostId: host.hostId,
    path: '/srv/u58-work/u58-maint-reason'
  })
  assert.equal(created.status, 201, created.text)
  const id = created.body.id as string

  const entered = await call(`/v1/hosts/${host.hostId}/maintenance`, 'POST', {
    enabled: true,
    reason: '计划维护'
  })
  assert.equal(entered.status, 200, entered.text)
  const inMaintenance = await call(`/v1/projects/${id}`)
  assert.equal(inMaintenance.status, 200, inMaintenance.text)
  assert.equal(inMaintenance.body.hostStatus, 'maintenance')
  assert.equal(inMaintenance.body.hostMaintenanceReason, '计划维护')

  const exited = await call(`/v1/hosts/${host.hostId}/maintenance`, 'POST', {
    enabled: false
  })
  assert.equal(exited.status, 200, exited.text)
  const online = await call(`/v1/projects/${id}`)
  assert.equal(online.status, 200, online.text)
  assert.equal(online.body.hostStatus, 'online')
  assert.equal(online.body.hostMaintenanceReason, undefined, 'the reason belongs to the window')
})

test('U58 Y13/Y14 限速与下载默认值拒绝非法输入', async () => {
  const before = await call('/v1/policies/download')
  assert.equal(before.status, 200, before.text)

  const hugeRate = await call('/v1/policies/download', 'PUT', {
    downloadDefault: 'allow',
    readRatePerHour: { calls: 1e300, bytes: 1e300 }
  })
  assert.equal(hugeRate.status, 400, hugeRate.text)
  assert.equal((hugeRate.body.error as Json).code, 'POLICY_INVALID')

  const banana = await call('/v1/policies/download', 'PUT', { downloadDefault: 'banana' })
  assert.equal(banana.status, 400, banana.text)
  assert.equal((banana.body.error as Json).code, 'POLICY_INVALID')

  const after = await call('/v1/policies/download')
  assert.equal(after.status, 200, after.text)
  assert.equal(after.body.version, before.body.version, 'a refused write must not bump the version')
  assert.equal(after.body.downloadDefault, before.body.downloadDefault)
})

test('U54 WEB-R2-017 Escape 关闭主机抽屉', async () => {
  const page = loadWebConsolePage(api.url)
  await page.settle()
  await page.submitLogin('admin', 'Adm1n!')
  await page.clickNav('hosts')
  const detail = page.window.document.querySelector<HTMLElement>(`[data-host="${hostId}"]`)
  assert.ok(detail, 'the registered host row must offer a detail entry')
  detail!.click()
  await page.settle()
  assert.ok(page.window.document.querySelector('.drawer-backdrop'), 'the drawer must open')

  page.window.document.dispatchEvent(
    new page.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
  )
  await page.settle()
  assert.equal(page.window.document.querySelector('.drawer-backdrop'), null)
})
