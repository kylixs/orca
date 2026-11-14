import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { saveEvidence, spawnService, type Service } from './harness.ts'

/**
 * M120c1: the console must tell a pinned per-project download policy from a
 * project that follows the global default (`downloadPolicyExplicit`), and be
 * able to un-pin one (`inherit: true`). Wire-compatible by construction: old
 * clients never send `inherit`, so their requests still take the pinned branch
 * untouched — asserted here as the old-form regression baseline.
 */

const EVIDENCE = 'w120c1-policy-inherit'
const INTERNAL_TOKEN = 'w120c1-internal-token'
const PROJECT_ID = 'proj_payment'

type PolicyView = {
  downloadPolicy: string
  effective: string
  globalDefault: string
  readRatePerHour: { calls: number; bytes: number }
  globalReadRatePerHour: { calls: number; bytes: number }
  version: number
}

type ProjectListItem = {
  id: string
  downloadPolicy: string
  downloadPolicyExplicit: boolean
}

type InternalPolicy = {
  version: number
  downloadDefault: string
  projectOverrides: Record<string, string>
  rateOverrides: Record<string, { calls: number; bytes: number }>
}

type AuditEvent = {
  seq: number
  eventType: string
  actor: string
  targetType: string
  targetId: string | null
  result: string
  metadata?: Record<string, unknown>
}

let service: Service
let adminToken = ''
let devToken = ''

async function callJson(
  token: string,
  path: string,
  method: string,
  body?: unknown
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${service.url}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  return { status: res.status, json: await res.json() }
}

async function getPolicy(token: string): Promise<PolicyView> {
  const res = await callJson(token, `/v1/projects/${PROJECT_ID}/policy`, 'GET')
  assert.equal(res.status, 200)
  return res.json as PolicyView
}

async function projectExplicitFlag(): Promise<boolean> {
  const res = await callJson(adminToken, '/v1/projects', 'GET')
  assert.equal(res.status, 200)
  const projects = (res.json as { projects: ProjectListItem[] }).projects
  const found = projects.find((project) => project.id === PROJECT_ID)
  assert.ok(found, 'seeded project must be listed for admin')
  return found.downloadPolicyExplicit
}

async function internalPolicy(): Promise<InternalPolicy> {
  const res = await fetch(`${service.url}/v1/internal/policy`, {
    headers: { 'x-internal-token': INTERNAL_TOKEN }
  })
  assert.equal(res.status, 200)
  return (await res.json()) as InternalPolicy
}

async function policyAuditEvents(result: 'success' | 'denied'): Promise<AuditEvent[]> {
  const res = await fetch(
    `${service.url}/v1/audit/events?eventType=policy_update&result=${result}&limit=200`,
    { headers: { authorization: `Bearer ${adminToken}` } }
  )
  assert.equal(res.status, 200)
  const events = ((await res.json()) as { events: AuditEvent[] }).events
  return events.filter((event) => event.targetType === 'project' && event.targetId === PROJECT_ID)
}

before(async () => {
  service = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-download-policy'
  )
  const login = async (username: string, password: string): Promise<string> => {
    const res = await fetch(`${service.url}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password, deviceName: 'm120c1-policy' })
    })
    const body = (await res.json()) as { accessToken?: string }
    assert.equal(res.status, 200, `login ${username} failed`)
    return body.accessToken!
  }
  adminToken = await login('admin', 'Adm1n!')
  devToken = await login('zhangsan', 'Passw0rd!')
})

after(async () => {
  await service?.stop()
})

describe('M120c1 项目级下载策略：explicit 读字段与 inherit 写参（真实平台进程）', () => {
  test('未覆盖的项目读出 explicit=false，effective 即全局默认', async () => {
    const policy = await getPolicy(adminToken)
    assert.equal(policy.downloadPolicy, 'deny')
    assert.equal(policy.globalDefault, 'deny')
    assert.equal(policy.effective, 'deny')
    assert.equal(await projectExplicitFlag(), false)
  })

  test('旧形态 PUT（无 inherit）置 explicit：响应形状与生效值零回归', async () => {
    const put = await callJson(adminToken, `/v1/projects/${PROJECT_ID}/policy`, 'PUT', {
      downloadPolicy: 'allow'
    })
    assert.equal(put.status, 200)
    // Response body shape is unchanged: exactly the three keys old clients read.
    assert.deepEqual(Object.keys(put.json).sort(), ['downloadPolicy', 'readRatePerHour', 'version'])

    const policy = await getPolicy(adminToken)
    assert.equal(policy.downloadPolicy, 'allow')
    assert.equal(policy.effective, 'allow')
    assert.equal(policy.globalDefault, 'deny')
    assert.equal(await projectExplicitFlag(), true)
    assert.deepEqual(policy.readRatePerHour, policy.globalReadRatePerHour)
    saveEvidence(EVIDENCE, 'explicit-allow.json', { put: put.json, policy })
  })

  test('旧形态 PUT 的审计 metadata 不带 inherited', async () => {
    const events = await policyAuditEvents('success')
    const last = events.at(-1)
    assert.ok(last, 'old-form PUT must leave a success event')
    assert.equal(last.actor, 'admin')
    assert.deepEqual(last.metadata, { downloadPolicy: 'allow' })
  })

  test('PUT {inherit:true} 清除覆盖：effective 回落全局，internal projectOverrides 收敛', async () => {
    const put = await callJson(adminToken, `/v1/projects/${PROJECT_ID}/policy`, 'PUT', {
      inherit: true,
      downloadPolicy: 'deny'
    })
    assert.equal(put.status, 200)
    assert.deepEqual(Object.keys(put.json).sort(), ['downloadPolicy', 'readRatePerHour', 'version'])

    const policy = await getPolicy(adminToken)
    // The raw stored value survives; only the pin is dropped.
    assert.equal(policy.downloadPolicy, 'allow')
    assert.equal(policy.effective, policy.globalDefault)
    assert.equal(policy.effective, 'deny')
    assert.equal(await projectExplicitFlag(), false)

    const internal = await internalPolicy()
    assert.equal(internal.downloadDefault, 'deny')
    assert.equal(
      Object.hasOwn(internal.projectOverrides, PROJECT_ID),
      false,
      'inherited project must leave projectOverrides'
    )
    saveEvidence(EVIDENCE, 'inherit-falls-back-to-global.json', { policy, internal })
  })

  test('inherit 后全局默认翻转即生效（钉住被撤销）', async () => {
    const flip = await callJson(adminToken, '/v1/policies/download', 'PUT', {
      downloadDefault: 'allow'
    })
    assert.equal(flip.status, 200)
    assert.equal((await getPolicy(adminToken)).effective, 'allow')

    const restore = await callJson(adminToken, '/v1/policies/download', 'PUT', {
      downloadDefault: 'deny'
    })
    assert.equal(restore.status, 200)
    assert.equal((await getPolicy(adminToken)).effective, 'deny')
  })

  test('inherit 请求仍可设置 readRatePerHour（语义不动）', async () => {
    const put = await callJson(adminToken, `/v1/projects/${PROJECT_ID}/policy`, 'PUT', {
      inherit: true,
      readRatePerHour: { calls: 100, bytes: 2048 }
    })
    assert.equal(put.status, 200)

    const policy = await getPolicy(adminToken)
    assert.deepEqual(policy.readRatePerHour, { calls: 100, bytes: 2048 })
    assert.equal(policy.effective, policy.globalDefault, 'inherit still clears the override')
    assert.equal(await projectExplicitFlag(), false)

    const internal = await internalPolicy()
    assert.deepEqual(internal.rateOverrides[PROJECT_ID], { calls: 100, bytes: 2048 })
    assert.equal(Object.hasOwn(internal.projectOverrides, PROJECT_ID), false)
  })

  test('旧形态清除 readRatePerHour 与非法限速 400 零回归', async () => {
    const clear = await callJson(adminToken, `/v1/projects/${PROJECT_ID}/policy`, 'PUT', {
      downloadPolicy: 'deny',
      readRatePerHour: null
    })
    assert.equal(clear.status, 200)
    const policy = await getPolicy(adminToken)
    assert.deepEqual(policy.readRatePerHour, policy.globalReadRatePerHour)
    const internal = await internalPolicy()
    assert.equal(Object.hasOwn(internal.rateOverrides, PROJECT_ID), false)

    const invalid = await callJson(adminToken, `/v1/projects/${PROJECT_ID}/policy`, 'PUT', {
      downloadPolicy: 'allow',
      readRatePerHour: { calls: 0, bytes: 0 }
    })
    assert.equal(invalid.status, 400)
    const body = invalid.json as { error?: { code?: string } }
    assert.equal(body.error?.code, 'POLICY_INVALID')
  })

  test('非 admin PUT 403 + denied 审计（新旧两种形态）', async () => {
    const oldForm = await callJson(devToken, `/v1/projects/${PROJECT_ID}/policy`, 'PUT', {
      downloadPolicy: 'allow'
    })
    const inheritForm = await callJson(devToken, `/v1/projects/${PROJECT_ID}/policy`, 'PUT', {
      inherit: true
    })
    assert.equal(oldForm.status, 403)
    assert.equal(inheritForm.status, 403)
    // The refusals change nothing: the pinned deny from the previous test stands.
    assert.equal((await getPolicy(adminToken)).downloadPolicy, 'deny')

    const denied = await policyAuditEvents('denied')
    const fromDeveloper = denied.filter((event) => event.actor === 'zhangsan')
    assert.equal(fromDeveloper.length, 2)
    for (const event of fromDeveloper) {
      assert.equal(event.result, 'denied')
      assert.equal(event.metadata?.requiredPermission, 'platform:admin')
    }
    saveEvidence(EVIDENCE, 'developer-denied.json', {
      statuses: { oldForm: oldForm.status, inheritForm: inheritForm.status },
      deniedEvents: fromDeveloper.map((event) => ({
        actor: event.actor,
        result: event.result,
        metadata: event.metadata
      }))
    })
  })

  test('inherit 事件审计 metadata 带 inherited 且不误记 downloadPolicy', async () => {
    const events = await policyAuditEvents('success')
    const inherited = events.filter((event) => event.metadata?.inherited === true)
    const pinned = events.filter((event) => event.metadata?.downloadPolicy !== undefined)
    assert.equal(inherited.length, 2)
    assert.equal(pinned.length, 2)
    for (const event of inherited) {
      assert.equal(
        Object.hasOwn(event.metadata ?? {}, 'downloadPolicy'),
        false,
        'inherit must not log the ignored downloadPolicy as if it applied'
      )
    }
    for (const event of pinned) {
      assert.equal(Object.hasOwn(event.metadata ?? {}, 'inherited'), false)
    }
    saveEvidence(EVIDENCE, 'audit-metadata.json', {
      inherited: inherited.map((event) => event.metadata),
      pinned: pinned.map((event) => event.metadata)
    })
  })
})
