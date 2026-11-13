import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { login, registerHost, saveEvidence, spawnService, type Service } from './harness.ts'

/**
 * M74 (G-05 / AC-08): the workbench decides whether 「打开」 is enabled from
 * `hostStatus`, so that field must follow the heartbeat, not the last status
 * the host happened to report. A real platform process, a real registration and
 * real heartbeats; only the offline window is shortened.
 */

const EVIDENCE = 'm74-offline-host'
const OFFLINE_WINDOW_MS = 400

type LoginBody = { accessToken?: string; device?: { id: string } }
type ErrorBody = { error?: { code: string } }
type ProjectRow = { id: string; hostStatus: string }
type HostRow = { id: string; status: string; online: boolean }

let api: Service
let adminToken = ''
let hostId = ''
let hostCredential = ''
let projectId = ''
let dev: LoginBody = {}

async function beat(): Promise<void> {
  const res = await fetch(`${api.url}/v1/hosts/${hostId}/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${hostCredential}` },
    body: JSON.stringify({ status: 'online' })
  })
  assert.equal(res.status, 200)
}

async function hostStatus(): Promise<string | undefined> {
  const res = await fetch(`${api.url}/v1/projects`, {
    headers: { authorization: `Bearer ${dev.accessToken}` }
  })
  const rows = ((await res.json()) as { projects: ProjectRow[] }).projects
  return rows.find((row) => row.id === projectId)?.hostStatus
}

async function hostOnline(): Promise<boolean | undefined> {
  const res = await fetch(`${api.url}/v1/hosts`, {
    headers: { authorization: `Bearer ${adminToken}` }
  })
  const rows = ((await res.json()) as { hosts: HostRow[] }).hosts
  return rows.find((row) => row.id === hostId)?.online
}

async function connect(): Promise<{ status: number; body: ErrorBody }> {
  const res = await fetch(`${api.url}/v1/projects/${projectId}/connect`, {
    method: 'POST',
    headers: { ...{ authorization: `Bearer ${dev.accessToken}` }, 'content-type': 'application/json' },
    body: JSON.stringify({
      deviceId: dev.device?.id,
      devicePubKey: Buffer.from('m74-device-key').toString('base64'),
      clientVersion: '1.5.0'
    })
  })
  return { status: res.status, body: (await res.json()) as ErrorBody }
}

before(async () => {
  api = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', ORCA_CLOUD_HOST_OFFLINE_MS: String(OFFLINE_WINDOW_MS) },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-host-offline'
  )
  adminToken = await login(api.url, 'admin', 'Adm1n!')
  const registered = await registerHost({
    apiUrl: api.url,
    adminToken,
    name: 'm74-offline-host',
    directAddr: '127.0.0.1:16770',
    relayTarget: '127.0.0.1:16770'
  })
  hostId = registered.hostId
  hostCredential = registered.credential

  const created = await fetch(`${api.url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      key: 'm74-offline-svc',
      name: 'm74-offline-svc',
      hostId,
      path: '/srv/work/m74-offline-svc'
    })
  })
  assert.equal(created.status, 201)
  projectId = ((await created.json()) as { id: string }).id
  const grant = await fetch(`${api.url}/v1/projects/${projectId}/grants`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      subjectType: 'group',
      subjectId: 'team-payment',
      permissions: ['open', 'terminal', 'agent', 'file:read', 'file:write']
    })
  })
  assert.equal(grant.status, 200)

  const res = await fetch(`${api.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'zhangsan',
      password: 'Passw0rd!',
      devicePubKey: Buffer.from('m74-device-key').toString('base64'),
      deviceName: 'm74-dev'
    })
  })
  dev = (await res.json()) as LoginBody
  assert.ok(dev.accessToken && dev.device?.id)
})

after(async () => {
  await api?.stop()
})

test('心跳过期后项目行转 offline 并拒绝打开，恢复心跳后回到 online', async () => {
  await beat()
  assert.equal(await hostStatus(), 'online')
  assert.equal(await hostOnline(), true)
  const fresh = await connect()
  assert.equal(fresh.status, 200)

  await new Promise((resolve) => setTimeout(resolve, OFFLINE_WINDOW_MS + 300))

  const staleStatus = await hostStatus()
  const staleOnline = await hostOnline()
  const staleConnect = await connect()
  assert.equal(staleStatus, 'offline', '项目行必须按心跳超时显示离线，工作台据此禁用「打开」')
  assert.equal(staleOnline, false)
  assert.equal(staleConnect.status, 409)
  assert.equal(staleConnect.body.error?.code, 'HOST_OFFLINE')

  await beat()
  assert.equal(await hostStatus(), 'online')
  assert.equal(await hostOnline(), true)

  saveEvidence(EVIDENCE, 'host-offline.json', {
    offlineWindowMs: OFFLINE_WINDOW_MS,
    beforeExpiry: { hostStatus: 'online', hostsOnline: true, connectStatus: fresh.status },
    afterExpiry: {
      hostStatus: staleStatus,
      hostsOnline: staleOnline,
      connectStatus: staleConnect.status,
      connectError: staleConnect.body.error
    },
    afterHeartbeat: { hostStatus: await hostStatus(), hostsOnline: await hostOnline() }
  })
})
