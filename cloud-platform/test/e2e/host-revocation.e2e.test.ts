import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { login, registerHost, saveEvidence, spawnService, type Service } from './harness.ts'

/**
 * AC-14: revoking a host must reach the host itself, so its live cloud sessions
 * can be closed, and must refuse new project connections immediately.
 */

const EVIDENCE = 'm71-host-revocation'

type HeartbeatBody = {
  hostRevoked?: boolean
  revoked?: { projects?: { id: string }[] }
  policyVersion?: number
}
type LoginBody = { accessToken?: string; device?: { id: string }; error?: { code: string } }
type ErrorBody = { error?: { code: string } }
type HostRow = {
  id: string
  status: string
  online: boolean
  revokedAt?: number | null
  credentialHash?: unknown
}
type ProjectRow = { id: string; hostStatus: string }

let api: Service
let adminToken = ''
let hostId = ''
let projectId = ''
let hostCredential = ''

async function adminLogin(): Promise<string> {
  return login(api.url, 'admin', 'Adm1n!')
}

async function heartbeat(): Promise<{ status: number; body: HeartbeatBody }> {
  const res = await fetch(`${api.url}/v1/hosts/${hostId}/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${hostCredential}` },
    body: JSON.stringify({ status: 'online' })
  })
  return { status: res.status, body: (await res.json()) as HeartbeatBody }
}

before(async () => {
  api = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-host-revocation'
  )
  adminToken = await adminLogin()
  const registered = await registerHost({
    apiUrl: api.url,
    adminToken,
    name: 'm71-revocable',
    directAddr: '127.0.0.1:16768',
    relayTarget: '127.0.0.1:16768'
  })
  hostId = registered.hostId
  hostCredential = registered.credential

  const created = await fetch(`${api.url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      key: 'm71-revocable-svc',
      name: 'm71-revocable-svc',
      hostId,
      path: '/srv/work/m71-revocable-svc'
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
})

after(async () => {
  await api?.stop()
})

test('主机吊销后心跳仍可达并携带 hostRevoked，新连接被 409 HOST_REVOKED 拒绝', async () => {
  const before = await heartbeat()
  assert.equal(before.status, 200)
  assert.notEqual(before.body.hostRevoked, true)

  const revoke = await fetch(`${api.url}/v1/hosts/${hostId}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${adminToken}` }
  })
  assert.equal(revoke.status, 200)

  const after = await heartbeat()
  assert.equal(after.status, 200)
  assert.equal(after.body.hostRevoked, true)
  const revokedProjects = after.body.revoked?.projects ?? []
  assert.ok(
    revokedProjects.some((entry) => entry.id === projectId),
    'heartbeat still carries the revoked project set'
  )

  const hostsRes = await fetch(`${api.url}/v1/hosts`, {
    headers: { authorization: `Bearer ${adminToken}` }
  })
  const hostRows = ((await hostsRes.json()) as { hosts: HostRow[] }).hosts
  const row = hostRows.find((entry) => entry.id === hostId)
  assert.ok(row)
  assert.equal(row.status, 'offline')
  assert.equal(row.online, false)
  assert.equal(typeof row.revokedAt, 'number')
  assert.equal('credentialHash' in row, false, 'the admin view must stay redacted')

  const devRes = await fetch(`${api.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'zhangsan',
      password: 'Passw0rd!',
      devicePubKey: Buffer.from('m71-device-key').toString('base64'),
      deviceName: 'm71-dev'
    })
  })
  const dev = (await devRes.json()) as LoginBody
  assert.ok(dev.accessToken && dev.device?.id)

  const projectsRes = await fetch(`${api.url}/v1/projects`, {
    headers: { authorization: `Bearer ${dev.accessToken}` }
  })
  const projects = ((await projectsRes.json()) as { projects: ProjectRow[] }).projects
  assert.equal(projects.find((entry) => entry.id === projectId)?.hostStatus, 'offline')

  const connect = await fetch(`${api.url}/v1/projects/${projectId}/connect`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${dev.accessToken}`
    },
    body: JSON.stringify({
      deviceId: dev.device.id,
      devicePubKey: Buffer.from('m71-device-key').toString('base64'),
      clientVersion: '1.5.0'
    })
  })
  const connectBody = (await connect.json()) as ErrorBody
  assert.equal(connect.status, 409)
  assert.equal(connectBody.error?.code, 'HOST_REVOKED')

  saveEvidence(EVIDENCE, 'platform-revocation.json', {
    hostId,
    projectId,
    heartbeatBeforeRevoke: { status: before.status, hostRevoked: before.body.hostRevoked ?? false },
    revokeStatus: revoke.status,
    heartbeatAfterRevoke: {
      status: after.status,
      hostRevoked: after.body.hostRevoked === true,
      revokedProjectIds: revokedProjects.map((entry) => entry.id)
    },
    adminHostRow: {
      status: row.status,
      online: row.online,
      revokedAt: row.revokedAt ?? null,
      exposesCredentialHash: 'credentialHash' in row
    },
    projectHostStatus: projects.find((entry) => entry.id === projectId)?.hostStatus,
    connectStatus: connect.status,
    connectErrorCode: connectBody.error?.code ?? null
  })
})
