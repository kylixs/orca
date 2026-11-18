import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { registerHost, saveEvidence, spawnService, type Service } from './harness.ts'

const EVIDENCE = 'm58-provision-recovery'
let api: Service
let adminToken = ''
let devToken = ''
let projectId = ''

async function login(username: string, password: string): Promise<string> {
  const res = await fetch(`${api.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, deviceName: 'm58-update' })
  })
  const body = (await res.json()) as { accessToken?: string; error?: { code: string } }
  assert.equal(res.status, 200, `login ${username} failed: ${body.error?.code}`)
  return body.accessToken!
}

function auth(token: string): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${token}` }
}

async function updateProject(
  token: string,
  body: Record<string, unknown>
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${api.url}/v1/projects/${projectId}`, {
    method: 'PUT',
    headers: auth(token),
    body: JSON.stringify(body)
  })
  return { status: res.status, body: await res.json() }
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
  const host = await registerHost({
    apiUrl: api.url,
    adminToken,
    name: 'dev-m58',
    directAddr: '127.0.0.1:9',
    relayTarget: '127.0.0.1:9'
  })
  const created = await fetch(`${api.url}/v1/projects`, {
    method: 'POST',
    headers: auth(adminToken),
    body: JSON.stringify({
      key: 'm58-recoverable',
      name: 'Recoverable',
      hostId: host.hostId,
      path: '/srv/work/recoverable',
      repoUrl: 'https://git.example.com/pay/m58-recoverable.git',
      defaultBranch: 'main'
    })
  })
  const body = (await created.json()) as { id: string }
  assert.equal(created.status, 201, JSON.stringify(body))
  projectId = body.id
  const granted = await fetch(`${api.url}/v1/projects/${projectId}/grants`, {
    method: 'PUT',
    headers: auth(adminToken),
    body: JSON.stringify({
      subjectType: 'group',
      subjectId: 'team-payment',
      permissions: ['open']
    })
  })
  assert.equal(granted.status, 200)
})

after(async () => {
  await api?.stop()
})

describe('M58 管理员修正项目来源（真实平台）', () => {
  test('开发者 PUT 项目返回 403，且被拒绝写入审计', async () => {
    const result = await updateProject(devToken, {
      repoUrl: 'https://git.example.com/pay/m58-other.git'
    })
    assert.equal(result.status, 403)
    assert.equal((result.body as { error?: { code: string } }).error?.code, 'PERMISSION_DENIED')
  })

  test('管理员 PUT repoUrl 后状态重置为 provisioning 且清除 provisioningError', async () => {
    const result = await updateProject(adminToken, {
      repoUrl: 'https://git.example.com/pay/m58-real-source.git',
      defaultBranch: 'release'
    })
    assert.equal(result.status, 200, JSON.stringify(result.body))
    const body = result.body as {
      repoUrl: string
      defaultBranch: string
      status: string
      provisioningError?: string
    }
    assert.equal(body.repoUrl, 'https://git.example.com/pay/m58-real-source.git')
    assert.equal(body.defaultBranch, 'release')
    assert.equal(body.status, 'provisioning')
    assert.equal(body.provisioningError, undefined)

    const audit = await fetch(`${api.url}/v1/audit/events?eventType=project_update&limit=20`, {
      headers: auth(adminToken)
    })
    const events = ((await audit.json()) as { events: Record<string, unknown>[] }).events.filter(
      (event) => event.targetId === projectId
    )
    const success = events.find((event) => event.result === 'success')
    assert.ok(success, 'project_update success event expected')
    const metadata = success.metadata as Record<string, unknown>
    assert.equal(metadata.key, 'm58-recoverable')
    assert.equal(metadata.repoUrlChanged, true)
    assert.equal(
      JSON.stringify(success).includes('https://git.example.com/pay/m58-real-source.git'),
      false
    )
    saveEvidence(EVIDENCE, 'platform-project-update.json', { update: result.body, audit: events })
  })

  test('非法 repoUrl / 空白分支 / 不可变字段均返回 400', async () => {
    const badUrl = await updateProject(adminToken, { repoUrl: '-oops' })
    assert.equal(badUrl.status, 400)
    assert.equal((badUrl.body as { error?: { code: string } }).error?.code, 'REPO_URL_INVALID')

    const opaqueUrl = await updateProject(adminToken, { repoUrl: 'not-a-valid-url' })
    assert.equal(opaqueUrl.status, 400)
    assert.equal((opaqueUrl.body as { error?: { code: string } }).error?.code, 'REPO_URL_INVALID')

    const badBranch = await updateProject(adminToken, { defaultBranch: 'has space' })
    assert.equal(badBranch.status, 400)
    assert.equal((badBranch.body as { error?: { code: string } }).error?.code, 'BRANCH_INVALID')

    for (const field of [{ path: '/srv/elsewhere' }, { hostId: 'host_other' }]) {
      const immutable = await updateProject(adminToken, field)
      assert.equal(immutable.status, 400)
      assert.equal(
        (immutable.body as { error?: { code: string } }).error?.code,
        'PROJECT_FIELD_IMMUTABLE'
      )
    }
    saveEvidence(EVIDENCE, 'platform-validation.json', {
      badUrl: badUrl.body,
      opaqueUrl: opaqueUrl.body,
      badBranch: badBranch.body
    })
  })

  test('清空 repoUrl 使项目回到 ready；归档项目 PUT 返回 404', async () => {
    const cleared = await updateProject(adminToken, { repoUrl: '' })
    assert.equal(cleared.status, 200)
    assert.equal((cleared.body as { status: string }).status, 'ready')

    const archived = await fetch(`${api.url}/v1/projects/${projectId}/archive`, {
      method: 'POST',
      headers: auth(adminToken)
    })
    assert.equal(archived.status, 200)

    const denied = await updateProject(adminToken, {
      repoUrl: 'https://git.example.com/pay/m58-again.git'
    })
    assert.equal(denied.status, 404)
    assert.equal((denied.body as { error?: { code: string } }).error?.code, 'PROJECT_NOT_FOUND')
  })
})
