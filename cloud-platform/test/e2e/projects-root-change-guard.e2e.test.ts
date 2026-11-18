import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveEvidence, spawnService, type Service } from './harness.ts'

/**
 * U21: a heartbeat used to be able to move a host's projectsRoot while every
 * project created under the old root kept its recorded path — and every ticket
 * minted from it kept pointing there — so the host then presented those
 * projects as not-prepared with nothing on the platform saying why. The change
 * is now refused while the host owns non-archived projects: the old root stays,
 * the refusal is audited and reported back on the beat itself, and the rest of
 * the beat still applies.
 */

const EVIDENCE = 'w120-fix-u21'

let api: Service
let adminToken = ''
let devToken = ''
let devDeviceId = ''
let rootA = ''
let rootB = ''

type Created = { id: string; key: string; path: string; status: string; hostId: string }
type Beat = {
  status: number
  projectsRootRejected?: string
  policyVersion?: number
  serverTime?: number
}

function auth(token: string): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${token}` }
}

async function login(
  username: string,
  password: string
): Promise<{ token: string; deviceId: string }> {
  const res = await fetch(`${api.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, deviceName: 'u21-root-guard' })
  })
  const body = (await res.json()) as {
    accessToken?: string
    device?: { id: string }
    error?: { code: string }
  }
  assert.equal(res.status, 200, `login ${username} failed: ${body.error?.code}`)
  assert.ok(body.accessToken && body.device?.id)
  return { token: body.accessToken, deviceId: body.device.id }
}

async function registerHost(
  name: string,
  projectsRoot: string
): Promise<{ hostId: string; credential: string }> {
  const tokenRes = await fetch(`${api.url}/v1/hosts/tokens`, {
    method: 'POST',
    headers: auth(adminToken)
  })
  assert.equal(tokenRes.status, 201)
  const { token } = (await tokenRes.json()) as { token: string }
  const res = await fetch(`${api.url}/v1/hosts/register`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({
      name,
      fingerprint: `sha256:${name}`,
      e2eePublicKeyB64: 'test-e2ee-key',
      orcaVersion: '1.5.0',
      protocolVersion: 3,
      networkZone: 'intranet',
      directAddrs: ['127.0.0.1:9'],
      relayTarget: '127.0.0.1:9',
      runtimeCapabilities: ['pty', 'files'],
      projectsRoot
    })
  })
  const body = (await res.json()) as { hostId?: string; credential?: string }
  assert.equal(res.status, 201, JSON.stringify(body))
  assert.ok(body.hostId && body.credential)
  // U65/U67: self-service creation needs the host provision bit.
  const granted = await fetch(`${api.url}/v1/hosts/${body.hostId}/grants`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...auth(adminToken) },
    body: JSON.stringify({
      subjectType: 'group',
      subjectId: 'developers',
      permissions: ['provision']
    })
  })
  assert.equal(granted.status, 200, await granted.text())
  return { hostId: body.hostId, credential: body.credential }
}

async function heartbeat(
  hostId: string,
  credential: string,
  body: Record<string, unknown>
): Promise<Beat> {
  const res = await fetch(`${api.url}/v1/hosts/${hostId}/heartbeat`, {
    method: 'POST',
    headers: auth(credential),
    body: JSON.stringify({ status: 'online', ...body })
  })
  const text = await res.text()
  assert.equal(res.status, 200, text)
  return JSON.parse(text) as Beat
}

async function createSelfService(hostId: string, dir: string, name: string): Promise<Created> {
  const res = await fetch(`${api.url}/v1/projects/self`, {
    method: 'POST',
    headers: auth(devToken),
    body: JSON.stringify({ name, dir, hostId })
  })
  const body = (await res.json()) as Created & { error?: { code: string } }
  assert.equal(res.status, 201, JSON.stringify(body))
  return body
}

async function hostRow(hostId: string): Promise<{ projectsRoot: string | null }> {
  const res = await fetch(`${api.url}/v1/hosts`, { headers: auth(adminToken) })
  assert.equal(res.status, 200)
  const body = (await res.json()) as { hosts: { id: string; projectsRoot: string | null }[] }
  const row = body.hosts.find((host) => host.id === hostId)
  assert.ok(row, `host ${hostId} missing`)
  return row
}

async function project(id: string): Promise<{ path: string; status: string }> {
  const res = await fetch(`${api.url}/v1/projects/${id}`, { headers: auth(devToken) })
  assert.equal(res.status, 200)
  return (await res.json()) as { path: string; status: string }
}

async function deniedRootChanges(): Promise<
  { targetId: string; metadata: Record<string, unknown> }[]
> {
  const res = await fetch(
    `${api.url}/v1/audit/events?eventType=projects_root_change&result=denied&limit=200`,
    { headers: auth(adminToken) }
  )
  assert.equal(res.status, 200)
  const body = (await res.json()) as {
    events: {
      eventType: string
      result: string
      targetId: string
      metadata: Record<string, unknown>
    }[]
  }
  return body.events
}

before(async () => {
  api = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-u21-root-guard'
  )
  const admin = await login('admin', 'Adm1n!')
  adminToken = admin.token
  const dev = await login('zhangsan', 'Passw0rd!')
  devToken = dev.token
  devDeviceId = dev.deviceId
  rootA = join(mkdtempSync(join(tmpdir(), 'orca-u21-root-a-')), 'projects')
  rootB = join(mkdtempSync(join(tmpdir(), 'orca-u21-root-b-')), 'projects')
  mkdirSync(rootA, { recursive: true })
  mkdirSync(rootB, { recursive: true })
}, { timeout: 120_000 })

after(async () => {
  await api?.stop()
})

describe('U21 心跳换根护栏', () => {
  test('宿主有活跃项目时换根被拒：旧根保留、项目路径与票据不变、denied 落审计', async () => {
    const host = await registerHost('u21-host-active', rootA)
    const created = await createSelfService(host.hostId, 'dir-demo', 'Dir Demo')
    assert.equal(created.path, join(rootA, 'dir-demo'))

    const beat = await heartbeat(host.hostId, host.credential, {
      projectsRoot: rootB,
      projectDirs: ['dir-demo']
    })
    assert.equal(beat.projectsRootRejected, 'PROJECTS_ROOT_CONFLICT')

    const row = await hostRow(host.hostId)
    assert.equal(row.projectsRoot, rootA, 'the old root must survive a refused change')

    const after = await project(created.id)
    assert.equal(after.path, created.path, 'the recorded project path must not move')
    assert.equal(after.status, 'ready')

    const connect = await fetch(`${api.url}/v1/projects/${created.id}/connect`, {
      method: 'POST',
      headers: auth(devToken),
      body: JSON.stringify({ deviceId: devDeviceId, clientVersion: '1.5.0' })
    })
    const connectText = await connect.text()
    assert.equal(connect.status, 200, connectText)
    const ticket = JSON.parse(connectText) as { workspace: { projectRoot: string } }
    assert.equal(
      ticket.workspace.projectRoot,
      created.path,
      'tickets must keep pointing at the retained root'
    )

    const denied = await deniedRootChanges()
    const event = denied.find((entry) => entry.targetId === host.hostId)
    assert.ok(event, 'the refusal must be audited')
    assert.equal(event.metadata.reason, 'PROJECTS_ROOT_CONFLICT')
    assert.equal(event.metadata.requested, rootB)
    assert.equal(event.metadata.current, rootA)
    assert.equal(event.metadata.conflictCount, 1)
    assert.deepEqual(event.metadata.sampleKeys, [created.key])

    // Clearing the root is the same move in disguise: it strands the same paths.
    const cleared = await heartbeat(host.hostId, host.credential, { projectsRoot: '' })
    assert.equal(cleared.projectsRootRejected, 'PROJECTS_ROOT_CONFLICT')
    assert.equal((await hostRow(host.hostId)).projectsRoot, rootA)

    // The rest of a refused beat still applies: the directory list follows.
    assert.deepEqual(
      (
        (await fetch(`${api.url}/v1/hosts`, { headers: auth(adminToken) }).then((r) =>
          r.json()
        )) as { hosts: { id: string; projectDirs: string[] }[] }
      ).hosts.find((entry) => entry.id === host.hostId)?.projectDirs,
      ['dir-demo']
    )
    saveEvidence(EVIDENCE, 'active-project-change-denied.json', {
      beat: { projectsRootRejected: beat.projectsRootRejected },
      hostRoot: row.projectsRoot,
      project: { id: created.id, path: after.path, status: after.status },
      ticketProjectRoot: ticket.workspace.projectRoot,
      audit: { reason: event.metadata.reason, conflictCount: event.metadata.conflictCount }
    })
  })

  test('同根重报不拒绝：例行心跳保持静默', async () => {
    const host = await registerHost('u21-host-same', rootA)
    await createSelfService(host.hostId, 'same-dir', 'Same Dir')
    const before = (await deniedRootChanges()).length

    const beat = await heartbeat(host.hostId, host.credential, { projectsRoot: rootA })
    assert.equal(beat.projectsRootRejected, undefined)
    assert.equal((await deniedRootChanges()).length, before)
    saveEvidence(EVIDENCE, 'same-root-beat-silent.json', { projectsRoot: rootA })
  })

  test('无项目宿主换根照常应用', async () => {
    const host = await registerHost('u21-host-empty', rootA)
    const beat = await heartbeat(host.hostId, host.credential, { projectsRoot: rootB })
    assert.equal(beat.projectsRootRejected, undefined)
    assert.equal((await hostRow(host.hostId)).projectsRoot, rootB)
    saveEvidence(EVIDENCE, 'empty-host-change-applied.json', { from: rootA, to: rootB })
  })

  test('归档项目不阻塞换根', async () => {
    const host = await registerHost('u21-host-archived', rootA)
    const created = await createSelfService(host.hostId, 'archived-dir', 'Archived Dir')
    const archived = await fetch(`${api.url}/v1/projects/${created.id}/archive`, {
      method: 'POST',
      headers: auth(devToken)
    })
    assert.equal(archived.status, 200, JSON.stringify(await archived.json()))

    const beat = await heartbeat(host.hostId, host.credential, { projectsRoot: rootB })
    assert.equal(beat.projectsRootRejected, undefined)
    assert.equal((await hostRow(host.hostId)).projectsRoot, rootB)
    saveEvidence(EVIDENCE, 'archived-project-change-applied.json', {
      project: created.id,
      hostRoot: rootB
    })
  })
})
