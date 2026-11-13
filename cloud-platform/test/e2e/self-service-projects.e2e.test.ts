import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { registerHost, saveEvidence, spawnService, type Service } from './harness.ts'

const EVIDENCE = 'm59-self-service-projects'
const REPO_URL = 'https://git.example.com/pay/self-service-demo.git'
let api: Service
let adminToken = ''
let devToken = ''
let otherToken = ''
let firstHostId = ''

async function login(username: string, password: string): Promise<string> {
  const res = await fetch(`${api.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, deviceName: 'm59-self-service' })
  })
  const body = (await res.json()) as { accessToken?: string; error?: { code: string } }
  assert.equal(res.status, 200, `login ${username} failed: ${body.error?.code}`)
  return body.accessToken!
}

function auth(token: string): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${token}` }
}

async function createSelfService(
  token: string,
  body: Record<string, unknown>
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${api.url}/v1/projects/self`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify(body)
  })
  return { status: res.status, body: await res.json() }
}

function errorCode(body: unknown): string | null {
  const error = (body as { error?: { code?: string } }).error
  return error?.code ?? null
}

function visibleIds(body: unknown): string[] {
  return ((body as { projects?: { id: string }[] }).projects ?? []).map((project) => project.id)
}

before(async () => {
  api = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api'
  )
  adminToken = await login('admin', 'Adm1n!')
  devToken = await login('zhangsan', 'Passw0rd!')
  otherToken = await login('lisi', 'Passw0rd!')
})

after(async () => {
  await api?.stop()
})

describe('M59 开发者自助创建云端项目（真实平台进程）', () => {
  test('没有声明 projectsRoot 的主机时返回 409 NO_PROVISIONABLE_HOST', async () => {
    const result = await createSelfService(devToken, {
      name: 'Self Service Demo',
      repoUrl: REPO_URL
    })
    assert.equal(result.status, 409)
    assert.equal(errorCode(result.body), 'NO_PROVISIONABLE_HOST')
  })

  test('普通开发者创建：路径由主机 projectsRoot 推导并自动授权', async () => {
    const host = await registerHost({
      apiUrl: api.url,
      adminToken,
      name: 'dev-m59-a',
      directAddr: '127.0.0.1:9',
      relayTarget: '127.0.0.1:9',
      projectsRoot: '/srv/projects'
    })
    firstHostId = host.hostId

    const result = await createSelfService(devToken, {
      name: 'Self Service Demo',
      repoUrl: REPO_URL,
      defaultBranch: 'main'
    })
    assert.equal(result.status, 201, JSON.stringify(result.body))
    const created = result.body as {
      id: string
      key: string
      path: string
      status: string
      hostId: string
      hostName: string
      downloadPolicy: string
      permissions: string[]
    }
    assert.equal(created.key, 'self-service-demo')
    assert.equal(created.path, '/srv/projects/self-service-demo')
    assert.equal(created.status, 'provisioning')
    assert.equal(created.hostId, host.hostId)
    assert.equal(created.hostName, 'dev-m59-a')
    assert.equal(created.downloadPolicy, 'deny')
    for (const permission of ['open', 'terminal', 'agent', 'file:read', 'file:write']) {
      assert.ok(created.permissions.includes(permission), `missing ${permission}`)
    }
    assert.equal(created.permissions.includes('download'), false)

    const listed = await fetch(`${api.url}/v1/projects`, { headers: auth(devToken) })
    assert.equal(visibleIds(await listed.json()).includes(created.id), true)

    saveEvidence(EVIDENCE, 'platform-self-service-create.json', {
      hostId: host.hostId,
      created
    })
  })

  test('显式指定 path 返回 400 PROJECT_PATH_FORBIDDEN', async () => {
    const result = await createSelfService(devToken, {
      name: 'Path Injection',
      key: 'path-injection',
      repoUrl: REPO_URL,
      path: '/etc/cron.d'
    })
    assert.equal(result.status, 400)
    assert.equal(errorCode(result.body), 'PROJECT_PATH_FORBIDDEN')
  })

  test('重复 key 返回 409 PROJECT_KEY_TAKEN（可预期，不自动改名）', async () => {
    const result = await createSelfService(devToken, {
      name: 'Self Service Demo Duplicate',
      key: 'self-service-demo',
      repoUrl: REPO_URL
    })
    assert.equal(result.status, 409)
    assert.equal(errorCode(result.body), 'PROJECT_KEY_TAKEN')
  })

  test('非创建者在 GET /v1/projects 中看不到该项目', async () => {
    const listed = await fetch(`${api.url}/v1/projects`, { headers: auth(otherToken) })
    assert.equal(visibleIds(await listed.json()).includes('self-service-demo'), false)
  })

  test('GET /v1/hosts/available 只返回 id/name/online/provisionable', async () => {
    const res = await fetch(`${api.url}/v1/hosts/available`, { headers: auth(devToken) })
    assert.equal(res.status, 200)
    const raw = await res.text()
    assert.equal(raw.includes('credentialHash'), false)
    assert.equal(raw.includes('directAddrs'), false)
    assert.equal(raw.includes('e2eePublicKey'), false)
    const body = JSON.parse(raw) as {
      hosts: { id: string; name: string; online: boolean; provisionable: boolean }[]
    }
    const first = body.hosts.find((host) => host.id === firstHostId)
    assert.deepEqual(first, {
      id: firstHostId,
      name: 'dev-m59-a',
      online: true,
      provisionable: true
    })
    const seeded = body.hosts.find((host) => host.id === 'host_dev001')
    assert.equal(seeded?.provisionable, false)
  })

  test('多台合格主机且未指定 hostId 返回 409 HOST_REQUIRED（附主机列表）', async () => {
    await registerHost({
      apiUrl: api.url,
      adminToken,
      name: 'dev-m59-b',
      directAddr: '127.0.0.1:9',
      relayTarget: '127.0.0.1:9',
      projectsRoot: '/srv/projects-b'
    })
    const result = await createSelfService(devToken, {
      name: 'Ambiguous Host',
      repoUrl: REPO_URL
    })
    assert.equal(result.status, 409)
    assert.equal(errorCode(result.body), 'HOST_REQUIRED')
    const details = (
      result.body as { error: { details: { hosts: { id: string; name: string }[] } } }
    ).error.details
    assert.equal(details.hosts.length, 2)
    assert.deepEqual(details.hosts.map((host) => host.name).sort(), ['dev-m59-a', 'dev-m59-b'])
    saveEvidence(EVIDENCE, 'platform-host-selection.json', {
      hostRequired: result.body
    })
  })

  test('未声明 projectsRoot 的主机（即使显式指定）返回 409 HOST_NOT_PROVISIONABLE', async () => {
    const result = await createSelfService(devToken, {
      name: 'Not Provisionable',
      repoUrl: REPO_URL,
      hostId: 'host_dev001'
    })
    assert.equal(result.status, 409)
    assert.equal(errorCode(result.body), 'HOST_NOT_PROVISIONABLE')
  })

  test('Windows 风格 projectsRoot 用反斜杠拼接项目路径', async () => {
    const host = await registerHost({
      apiUrl: api.url,
      adminToken,
      name: 'dev-m59-win',
      directAddr: '127.0.0.1:9',
      relayTarget: '127.0.0.1:9',
      projectsRoot: 'D:\\projects'
    })
    const result = await createSelfService(devToken, {
      name: 'Windows Layout',
      key: 'windows-layout',
      repoUrl: REPO_URL,
      hostId: host.hostId
    })
    assert.equal(result.status, 201, JSON.stringify(result.body))
    assert.equal((result.body as { path: string }).path, 'D:\\projects\\windows-layout')
  })

  test('每用户 20 个未归档项目上限，超限返回 429 PROJECT_LIMIT_REACHED', async () => {
    // Two projects already exist (self-service-demo, windows-layout), so 18 more reach 20.
    for (let index = 2; index <= 19; index += 1) {
      const created = await createSelfService(devToken, {
        name: `Quota ${index}`,
        key: `quota-${index}`,
        repoUrl: REPO_URL,
        hostId: firstHostId
      })
      assert.equal(created.status, 201, JSON.stringify(created.body))
    }
    const over = await createSelfService(devToken, {
      name: 'Quota 20',
      key: 'quota-20',
      repoUrl: REPO_URL,
      hostId: firstHostId
    })
    assert.equal(over.status, 429)
    assert.equal(errorCode(over.body), 'PROJECT_LIMIT_REACHED')
  })
})
