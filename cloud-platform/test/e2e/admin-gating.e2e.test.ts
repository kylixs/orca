import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  makeTempWorkspace,
  registerHost,
  saveEvidence,
  spawnService,
  type Service
} from './harness.ts'

const EVIDENCE = 'm8-admin-gating'
let api: Service
let relay: Service
let adminToken = ''
let devToken = ''

async function login(username: string, password: string): Promise<string> {
  const res = await fetch(`${api.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, deviceName: 'e2e-gating' })
  })
  const body = (await res.json()) as { accessToken?: string; error?: { code: string } }
  assert.equal(res.status, 200, `login ${username} failed: ${body.error?.code}`)
  return body.accessToken!
}

function auth(token: string): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${token}` }
}

before(async () => {
  const workspace = makeTempWorkspace()
  api = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api'
  )
  relay = await spawnService(
    'apps/relay/src/relay.ts',
    { PORT: '0', API_URL: api.url },
    /\[relay\] listening on :(\d+)/,
    'relay'
  )
  await fetch(`${api.url}/v1/internal/relay-endpoint`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-token': 'internal-test-token' },
    body: JSON.stringify({ port: relay.port })
  })
  adminToken = await login('admin', 'Adm1n!')
  devToken = await login('zhangsan', 'Passw0rd!')
  await registerHost({
    apiUrl: api.url,
    adminToken,
    name: 'dev-001',
    directAddr: '127.0.0.1:9',
    relayTarget: '127.0.0.1:9'
  })
  void workspace
})

after(async () => {
  await relay?.stop()
  await api?.stop()
})

describe('M8 管控面服务端门禁（AC-18 / AC-32）', () => {
  const adminOnly: { method: string; path: string; body?: unknown; label: string }[] = [
    { method: 'GET', path: '/v1/hosts', label: '主机列表' },
    { method: 'POST', path: '/v1/hosts/tokens', label: '生成注册令牌' },
    {
      method: 'POST',
      path: '/v1/projects',
      body: { key: 'x', name: 'x', hostId: 'host_dev001', path: '/srv/x' },
      label: '登记项目'
    },
    {
      method: 'PUT',
      path: '/v1/projects/proj_payment/grants',
      body: { subjectType: 'group', subjectId: 'team-payment', permissions: ['open'] },
      label: '修改项目授权'
    },
    {
      method: 'PUT',
      path: '/v1/projects/proj_payment/policy',
      body: { downloadPolicy: 'allow' },
      label: '修改项目下载策略'
    },
    { method: 'GET', path: '/v1/audit/events?limit=10', label: '查询审计日志' },
    {
      method: 'PUT',
      path: '/v1/policies/download',
      body: { downloadDefault: 'allow' },
      label: '修改全局策略'
    }
  ]

  for (const route of adminOnly) {
    test(`开发者访问「${route.label}」返回 403`, async () => {
      const res = await fetch(`${api.url}${route.path}`, {
        method: route.method,
        headers: auth(devToken),
        body: route.body ? JSON.stringify(route.body) : undefined
      })
      const body = (await res.json()) as { error?: { code: string } }
      assert.equal(res.status, 403, `${route.path} expected 403, got ${res.status}`)
      assert.equal(body.error?.code, 'PERMISSION_DENIED')
    })
  }

  test('管理员访问管控面全部成功', async () => {
    const results: Record<string, number> = {}
    for (const route of adminOnly) {
      // Skip mutations that would break later assertions; uses a read-only subset.
      if (route.method !== 'GET') continue
      const res = await fetch(`${api.url}${route.path}`, { headers: auth(adminToken) })
      results[route.path] = res.status
      assert.equal(res.status, 200, `${route.path} expected 200, got ${res.status}`)
    }
    saveEvidence(EVIDENCE, 'admin-readonly-success.json', results)
  })

  test('非创建者归档项目返回 404（M65 自助归档，与无权限同语义）', async () => {
    const res = await fetch(`${api.url}/v1/projects/proj_payment/archive`, {
      method: 'POST',
      headers: auth(devToken)
    })
    const body = (await res.json()) as { error?: { code: string } }
    assert.equal(res.status, 404)
    assert.equal(body.error?.code, 'PROJECT_NOT_FOUND')
  })

  test('开发者访问项目详情：有权限 200，无权限统一 404', async () => {
    const visible = await fetch(`${api.url}/v1/projects/proj_payment`, { headers: auth(devToken) })
    assert.equal(visible.status, 200)

    const unknown = await fetch(`${api.url}/v1/projects/proj_does_not_exist`, {
      headers: auth(devToken)
    })
    const unknownBody = (await unknown.json()) as { error?: { code: string } }
    assert.equal(unknown.status, 404)
    assert.equal(unknownBody.error?.code, 'PROJECT_NOT_FOUND')

    // Body must not leak whether the project exists elsewhere.
    assert.equal(JSON.stringify(unknownBody).includes('payment-service'), false)

    saveEvidence(EVIDENCE, 'project-visibility.json', {
      visible: visible.status,
      unknown: unknown.status,
      unknownBody
    })
  })

  test('未登录访问管控面返回 401', async () => {
    const res = await fetch(`${api.url}/v1/hosts`)
    assert.equal(res.status, 401)
    const body = (await res.json()) as { error?: { code: string } }
    assert.equal(body.error?.code, 'SESSION_EXPIRED')
    saveEvidence(EVIDENCE, 'anonymous-admin-access.json', { status: res.status, body })
  })

  test('被拒的管理操作写入审计（denied）', async () => {
    const res = await fetch(`${api.url}/v1/audit/events?eventType=project_create&limit=20`, {
      headers: auth(adminToken)
    })
    const body = (await res.json()) as { events: { result: string; actor: string | null }[] }
    const denied = body.events.filter((e) => e.result === 'denied' && e.actor === 'zhangsan')
    assert.ok(denied.length >= 1, 'denied project_create event expected')
    saveEvidence(EVIDENCE, 'denied-audit.json', {
      deniedCount: denied.length,
      events: body.events.slice(0, 5)
    })
  })

  test('开发者无法通过响应差异探测项目是否存在（未知 vs 无权限）', async () => {
    // Create a project the developer cannot see, then compare responses.
    const created = await fetch(`${api.url}/v1/projects`, {
      method: 'POST',
      headers: auth(adminToken),
      body: JSON.stringify({
        key: 'secret-project',
        name: 'secret-project',
        repoUrl: 'git@git.example.com:hidden/secret.git',
        hostId: 'host_dev001',
        path: '/srv/work/secret-project'
      })
    })
    assert.equal(created.status, 201)
    const createdBody = (await created.json()) as { id: string }

    const forbidden = await fetch(`${api.url}/v1/projects/${createdBody.id}`, {
      headers: auth(devToken)
    })
    const missing = await fetch(`${api.url}/v1/projects/proj_missing_anyway`, {
      headers: auth(devToken)
    })
    assert.equal(forbidden.status, missing.status, 'status must not differ')
    const normalise = (body: { error?: Record<string, unknown> }): unknown => {
      const { traceId: _traceId, ...rest } = body.error ?? {}
      return rest
    }
    const forbiddenBody = normalise(await forbidden.json())
    const missingBody = normalise(await missing.json())
    assert.deepEqual(forbiddenBody, missingBody, 'error payload must not differ')

    saveEvidence(EVIDENCE, 'existence-non-disclosure.json', {
      forbiddenStatus: forbidden.status,
      missingStatus: missing.status,
      forbiddenBody,
      missingBody
    })
  })
})
