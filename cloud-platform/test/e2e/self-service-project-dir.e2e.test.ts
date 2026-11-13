import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveEvidence, spawnService, type Service } from './harness.ts'

/**
 * M115 (FR-3.7): a developer names the project and its directory; the repo URL
 * is optional. The directory is a single relative segment under the host's
 * projects root — the platform joins and contains it, so nothing outside the
 * root can ever be registered, and a repo-less project is ready immediately.
 */

const EVIDENCE = 'm115-self-service-dir'
const REPO_URL = 'https://git.example.com/pay/dir-demo.git'

let api: Service
let adminToken = ''
let devToken = ''
let devDeviceId = ''
let projectsRoot = ''

type Created = {
  id: string
  key: string
  name: string
  path: string
  status: string
  hostId: string
  repoUrl: string
}

function auth(token: string): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${token}` }
}

async function login(username: string, password: string): Promise<{ token: string; deviceId: string }> {
  const res = await fetch(`${api.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, deviceName: 'm115-dir' })
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

async function registerHost(name: string): Promise<{ hostId: string; credential: string }> {
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
  return { hostId: body.hostId, credential: body.credential }
}

async function heartbeat(
  hostId: string,
  credential: string,
  body: Record<string, unknown>
): Promise<void> {
  const res = await fetch(`${api.url}/v1/hosts/${hostId}/heartbeat`, {
    method: 'POST',
    headers: auth(credential),
    body: JSON.stringify({ status: 'online', ...body })
  })
  assert.equal(res.status, 200)
}

async function createSelfService(
  body: Record<string, unknown>
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${api.url}/v1/projects/self`, {
    method: 'POST',
    headers: auth(devToken),
    body: JSON.stringify(body)
  })
  return { status: res.status, body: await res.json() }
}

function errorCode(body: unknown): string {
  return (body as { error?: { code?: string } }).error?.code ?? ''
}

async function hostRow(hostId: string): Promise<{
  projectDirs: string[]
  projectsRoot: string | null
}> {
  const res = await fetch(`${api.url}/v1/hosts`, { headers: auth(adminToken) })
  assert.equal(res.status, 200)
  const hosts = (await res.json()) as {
    hosts: { id: string; projectDirs: string[]; projectsRoot: string | null }[]
  }
  const row = hosts.hosts.find((host) => host.id === hostId)
  assert.ok(row, `host ${hostId} missing`)
  return row
}

before(async () => {
  api = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-self-service-dir'
  )
  const admin = await login('admin', 'Adm1n!')
  adminToken = admin.token
  const dev = await login('zhangsan', 'Passw0rd!')
  devToken = dev.token
  devDeviceId = dev.deviceId
  // A real root the assertions can watch: nothing may appear outside a created
  // project, and an escaped name must not materialise a directory.
  projectsRoot = join(mkdtempSync(join(tmpdir(), 'orca-m115-root-')), 'projects')
  mkdirSync(projectsRoot, { recursive: true })
}, 120_000)

after(async () => {
  await api?.stop()
})

describe('M115 自助建项目：名称+目录必填，仓库地址可选', () => {
  test('名称或目录缺一返回 400', async () => {
    const host = await registerHost('m115-host-a')

    const noName = await createSelfService({ dir: 'dir-demo', repoUrl: REPO_URL, hostId: host.hostId })
    assert.equal(noName.status, 400)
    assert.equal(errorCode(noName.body), 'PROJECT_NAME_INVALID')

    const noDir = await createSelfService({
      name: 'Dir Demo',
      repoUrl: REPO_URL,
      hostId: host.hostId
    })
    assert.equal(noDir.status, 400)
    assert.equal(errorCode(noDir.body), 'INVALID_DIR')
    saveEvidence(EVIDENCE, 'missing-fields-rejected.json', {
      noName: { status: noName.status, code: errorCode(noName.body) },
      noDir: { status: noDir.status, code: errorCode(noDir.body) }
    })
  })

  test('repoUrl 省略：201 且 ready，开发者可见并可 connect', async () => {
    const host = await registerHost('m115-host-b')
    await heartbeat(host.hostId, host.credential, { projectDirs: ['dir-demo'] })

    const result = await createSelfService({ name: 'Dir Demo', dir: 'dir-demo', hostId: host.hostId })
    assert.equal(result.status, 201, JSON.stringify(result.body))
    const created = result.body as Created
    assert.equal(created.status, 'ready')
    assert.equal(created.repoUrl, '')
    assert.equal(created.path, join(projectsRoot, 'dir-demo'))
    assert.equal(created.key, 'dir-demo')

    const listed = await fetch(`${api.url}/v1/projects`, { headers: auth(devToken) })
    const ids = ((await listed.json()) as { projects: { id: string }[] }).projects.map((p) => p.id)
    assert.ok(ids.includes(created.id), 'the creator must see the project')

    const connect = await fetch(`${api.url}/v1/projects/${created.id}/connect`, {
      method: 'POST',
      headers: auth(devToken),
      body: JSON.stringify({ deviceId: devDeviceId, clientVersion: '1.5.0' })
    })
    assert.equal(connect.status, 200, JSON.stringify(await connect.json()))
    saveEvidence(EVIDENCE, 'repo-optional-ready.json', { created, connectStatus: connect.status })
  })

  test('心跳上报 projectDirs 后 /v1/hosts 与 /v1/hosts/available 携带清单', async () => {
    const host = await registerHost('m115-host-c')
    await heartbeat(host.hostId, host.credential, {
      projectDirs: ['zeta', 'alpha', 'alpha', 'bad/name', 42]
    })

    const row = await hostRow(host.hostId)
    assert.deepEqual(row.projectDirs, ['alpha', 'zeta'])
    assert.equal(row.projectsRoot, projectsRoot)

    const available = await fetch(`${api.url}/v1/hosts/available`, { headers: auth(devToken) })
    assert.equal(available.status, 200)
    const body = (await available.json()) as {
      hosts: { id: string; projectDirs: string[] }[]
    }
    assert.deepEqual(
      body.hosts.find((entry) => entry.id === host.hostId)?.projectDirs,
      ['alpha', 'zeta']
    )
    saveEvidence(EVIDENCE, 'host-project-dirs.json', { admin: row, available: body.hosts })
  })

  test('dir 含 .. 或绝对路径：400 且宿主文件系统未建目录', async () => {
    const host = await registerHost('m115-host-d')
    const before = readdirSync(projectsRoot).sort()

    for (const dir of ['../escape', '/etc/cron.d', 'a/b', '..']) {
      const result = await createSelfService({
        name: `Escape ${dir}`,
        dir,
        hostId: host.hostId
      })
      assert.equal(result.status, 400, dir)
      assert.equal(errorCode(result.body), 'INVALID_DIR', dir)
    }

    assert.deepEqual(readdirSync(projectsRoot).sort(), before, 'no directory may be created')
    assert.equal(existsSync(join(projectsRoot, '..', 'escape')), false)
    saveEvidence(EVIDENCE, 'path-escape-rejected.json', { rejected: ['../escape', '/etc/cron.d', 'a/b', '..'] })
  })

  test('同主机重复目录返回 409 PROJECT_PATH_TAKEN', async () => {
    const host = await registerHost('m115-host-e')
    const first = await createSelfService({
      name: 'Dir Demo Two',
      dir: 'shared-dir',
      repoUrl: REPO_URL,
      hostId: host.hostId
    })
    assert.equal(first.status, 201, JSON.stringify(first.body))

    const second = await createSelfService({
      name: 'Dir Demo Two Again',
      dir: 'shared-dir',
      hostId: host.hostId
    })
    assert.equal(second.status, 409)
    assert.equal(errorCode(second.body), 'PROJECT_PATH_TAKEN')
    saveEvidence(EVIDENCE, 'duplicate-dir-rejected.json', {
      first: first.status,
      second: { status: second.status, code: errorCode(second.body) }
    })
  })
})
