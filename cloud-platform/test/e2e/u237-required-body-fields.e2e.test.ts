import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, type ApiHandle } from '../../apps/api/src/server.ts'

/**
 * U237 / D19 option A: the four endpoints whose missing semantic field used to
 * be silently applied must refuse the request instead. Every refusal is also
 * checked for zero side effects: no audit row, no project/host/policy change.
 */

const INTERNAL_TOKEN = 'u237-required-body-fields'
const PROJECT_ID = 'proj_payment'
const HOST_ID = 'host_dev001'

const NON_OBJECT_BODIES: readonly (readonly [string, string])[] = [
  ['null', 'null'],
  ['number', '42'],
  ['string', '"x"'],
  ['array', '[]'],
  ['boolean', 'true'],
  ['empty-object', '{}']
]

type Refusal = { status: number; code: string; message: string }

let app: ApiHandle
let base = ''
let adminToken = ''
let devToken = ''

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

async function callAt(
  origin: string,
  method: string,
  path: string,
  raw?: string,
  token?: string
): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(raw === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token === undefined ? {} : auth(token))
    },
    ...(raw === undefined ? {} : { body: raw })
  })
}

async function call(
  method: string,
  path: string,
  raw?: string,
  token?: string
): Promise<Response> {
  return callAt(base, method, path, raw, token)
}

async function loginAt(origin: string, username: string, password: string): Promise<string> {
  const res = await callAt(
    origin,
    'POST',
    '/v1/auth/login',
    JSON.stringify({ username, password, deviceName: 'u237-required-fields' })
  )
  assert.equal(res.status, 200, `login failed for ${username}`)
  const body = (await res.json()) as { accessToken?: string }
  assert.ok(body.accessToken)
  return body.accessToken
}

async function login(username: string, password: string): Promise<string> {
  return loginAt(base, username, password)
}

/**
 * Direct store snapshot: the authoritative state a handler would mutate.
 * Audit totals are included so a quiet write/denial elsewhere cannot hide.
 */
function storeSnapshot(): Record<string, unknown> {
  const project = app.store.projects.get(PROJECT_ID)
  const host = app.store.hosts.get(HOST_ID)
  assert.ok(project, 'seeded project must exist')
  assert.ok(host, 'seeded host must exist')
  const auditCounts: Record<string, number> = {}
  for (const event of app.store.audit) {
    auditCounts[event.eventType] = (auditCounts[event.eventType] ?? 0) + 1
  }
  return {
    project: {
      repoUrl: project.repoUrl,
      defaultBranch: project.defaultBranch,
      status: project.status,
      provisioningError: project.provisioningError ?? null,
      downloadPolicy: project.downloadPolicy,
      downloadPolicyExplicit: project.downloadPolicyExplicit ?? false,
      readRatePerHour: project.readRatePerHour ?? null
    },
    host: {
      status: host.status,
      maintenanceReason: host.maintenanceReason
    },
    policies: {
      downloadDefault: app.store.policies.downloadDefault,
      version: app.store.policies.version,
      readRatePerHour: app.store.policies.readRatePerHour
    },
    auditTotal: app.store.audit.length,
    auditCounts
  }
}

async function refuse(
  method: string,
  path: string,
  raw: string,
  expectedCode: string
): Promise<void> {
  const before = storeSnapshot()
  const res = await call(method, path, raw, adminToken)
  const body = (await res.json()) as { error?: { code?: string; message?: string } }
  assert.equal(
    res.status,
    400,
    `${method} ${path} body=${raw} must be refused, got ${res.status} ${JSON.stringify(body)}`
  )
  assert.equal(body.error?.code, expectedCode, `${method} ${path} body=${raw}`)
  assert.deepEqual(
    storeSnapshot(),
    before,
    `${method} ${path} body=${raw} changed store state or audit`
  )
}

describe('U237 必填字段：空/缺字段请求不得写入', () => {
  before(async () => {
    app = createApp({
      port: 0,
      internalToken: INTERNAL_TOKEN,
      cookieMode: 'never',
      publicOrigin: ''
    })
    base = `http://127.0.0.1:${await app.listen()}`
    adminToken = await login('admin', 'Adm1n!')
    devToken = await login('zhangsan', 'Passw0rd!')
  })

  after(async () => {
    await app?.close()
  })

  test('D4 POST /v1/hosts/:id/maintenance 六种非对象 body 与 {} 均 400', async () => {
    for (const [form, raw] of NON_OBJECT_BODIES) {
      await refuse('POST', `/v1/hosts/${HOST_ID}/maintenance`, raw, 'HOST_MAINTENANCE_INVALID')
      assert.equal(app.store.hosts.get(HOST_ID)?.status, 'online', `${form} must not enter maintenance`)
    }
  })

  test('D4 缺少布尔 enabled（错误类型/null/0）均 400 且主机状态不变', async () => {
    for (const raw of [
      JSON.stringify({ enabled: 'false' }),
      JSON.stringify({ enabled: null }),
      JSON.stringify({ enabled: 0 }),
      JSON.stringify({ reason: 'maintenance window' })
    ]) {
      await refuse('POST', `/v1/hosts/${HOST_ID}/maintenance`, raw, 'HOST_MAINTENANCE_INVALID')
    }
    assert.equal(app.store.hosts.get(HOST_ID)?.status, 'online')
  })

  test('D2 PUT /v1/projects/:id/policy 六种非对象 body 与 {} 均 400', async () => {
    for (const [form, raw] of NON_OBJECT_BODIES) {
      await refuse('PUT', `/v1/projects/${PROJECT_ID}/policy`, raw, 'POLICY_INVALID')
      assert.equal(
        app.store.projects.get(PROJECT_ID)?.downloadPolicyExplicit ?? false,
        false,
        `${form} must not pin a project policy`
      )
    }
  })

  test('D2 缺 downloadPolicy 且无 inherit:true（含仅限速/非法值）均 400', async () => {
    for (const raw of [
      JSON.stringify({ downloadPolicy: 'banana' }),
      JSON.stringify({ readRatePerHour: { calls: 5, bytes: 5 } }),
      JSON.stringify({ expectedVersion: 1 }),
      JSON.stringify({ expectedVersion: 1, readRatePerHour: { calls: 5, bytes: 5 } })
    ]) {
      await refuse('PUT', `/v1/projects/${PROJECT_ID}/policy`, raw, 'POLICY_INVALID')
    }
    assert.equal(app.store.projects.get(PROJECT_ID)?.downloadPolicyExplicit ?? false, false)
  })

  test('D3 PUT /v1/policies/download 六种非对象 body 与 {} 均 400', async () => {
    for (const [form, raw] of NON_OBJECT_BODIES) {
      await refuse('PUT', '/v1/policies/download', raw, 'POLICY_INVALID')
      assert.equal(app.store.policies.downloadDefault, 'deny', `${form} must not flip the default`)
    }
  })

  test('D3 缺 downloadDefault（含仅限速/非法值）均 400 且版本不变', async () => {
    for (const raw of [
      JSON.stringify({ downloadDefault: 'banana' }),
      JSON.stringify({ readRatePerHour: { calls: 5, bytes: 5 } }),
      JSON.stringify({ expectedVersion: 1 })
    ]) {
      await refuse('PUT', '/v1/policies/download', raw, 'POLICY_INVALID')
    }
    assert.equal(app.store.policies.version, 1)
  })

  test('D1 PUT /v1/projects/:id 六种非对象 body 与 {} 均 400', async () => {
    for (const [form, raw] of NON_OBJECT_BODIES) {
      await refuse('PUT', `/v1/projects/${PROJECT_ID}`, raw, 'PROJECT_UPDATE_INVALID')
      assert.equal(app.store.projects.get(PROJECT_ID)?.status, 'ready', `${form}: status must hold`)
    }
  })

  test('D1 无可更新字段（name/未知字段）400，且不可变字段先于必填判定', async () => {
    for (const raw of [
      JSON.stringify({ name: 'renamed' }),
      JSON.stringify({ unknownField: 'x' })
    ]) {
      await refuse('PUT', `/v1/projects/${PROJECT_ID}`, raw, 'PROJECT_UPDATE_INVALID')
    }
    // Ordering contract: an immutable field must still win over the new rule.
    for (const raw of [
      JSON.stringify({ path: '/srv/work/other' }),
      JSON.stringify({ hostId: HOST_ID })
    ]) {
      await refuse('PUT', `/v1/projects/${PROJECT_ID}`, raw, 'PROJECT_FIELD_IMMUTABLE')
    }
  })

  /**
   * Priority pins: a caller who may not act must learn that, not which body
   * fields are required, and a broken audit chain stops the write before any
   * field validation runs.
   */
  test('优先级：D2/D3/D4 缺字段 + 无权限 → 403 而非 400', async () => {
    const policyBefore = app.store.policies.downloadDefault
    const project = app.store.projects.get(PROJECT_ID)
    const pinBefore = project?.downloadPolicyExplicit ?? false

    const attempts: readonly (readonly [string, string, string])[] = [
      ['PUT', `/v1/projects/${PROJECT_ID}/policy`, '{}'],
      ['PUT', '/v1/policies/download', '{}'],
      ['POST', `/v1/hosts/${HOST_ID}/maintenance`, '{}']
    ]
    for (const [method, path, raw] of attempts) {
      const res = await call(method, path, raw, devToken)
      const body = (await res.json()) as { error?: { code?: string } }
      assert.equal(
        res.status,
        403,
        `${method} ${path} must refuse the caller before validating fields`
      )
      assert.equal(body.error?.code, 'PERMISSION_DENIED')
    }

    assert.equal(app.store.projects.get(PROJECT_ID)?.downloadPolicyExplicit ?? false, pinBefore)
    assert.equal(app.store.policies.downloadDefault, policyBefore)
    assert.equal(app.store.hosts.get(HOST_ID)?.status, 'online')
  })

  test('优先级：全部 4 端点缺字段 + 审计链损坏 → 503 优先于 400', async () => {
    const logPath = join(mkdtempSync(join(tmpdir(), 'u237-audit-')), 'audit.jsonl')
    const options = {
      port: 0,
      internalToken: `${INTERNAL_TOKEN}-audit`,
      cookieMode: 'never' as const,
      publicOrigin: ''
    }

    // First boot writes a valid chain; login alone persists one event.
    const first = createApp({ ...options, auditLogPath: logPath })
    try {
      await loginAt(`http://127.0.0.1:${await first.listen()}`, 'admin', 'Adm1n!')
    } finally {
      await first.close()
    }
    const lines = readFileSync(logPath, 'utf8').split('\n').filter(Boolean)
    assert.ok(lines.length >= 1, 'first boot must persist an audit event')
    const tampered = JSON.parse(lines[0]!) as { actor: string }
    tampered.actor = 'ghost'
    lines[0] = JSON.stringify(tampered)
    writeFileSync(logPath, `${lines.join('\n')}\n`)

    // Booting on the tampered log latches health to chain_broken.
    const second = createApp({ ...options, auditLogPath: logPath })
    try {
      const origin = `http://127.0.0.1:${await second.listen()}`
      const token = await loginAt(origin, 'admin', 'Adm1n!')
      const attempts: readonly (readonly [string, string])[] = [
        ['PUT', `/v1/projects/${PROJECT_ID}`],
        ['PUT', `/v1/projects/${PROJECT_ID}/policy`],
        ['PUT', '/v1/policies/download'],
        ['POST', `/v1/hosts/${HOST_ID}/maintenance`]
      ]
      for (const [method, path] of attempts) {
        const res = await callAt(origin, method, path, '{}', token)
        const body = (await res.json()) as { error?: { code?: string } }
        assert.equal(res.status, 503, `${method} ${path} must fail closed on audit`)
        assert.equal(body.error?.code, 'AUDIT_CHAIN_BROKEN')
      }
    } finally {
      await second.close()
    }
  })

  test('正向：maintenance enabled true/false 仍按布尔值切换', async () => {
    const enabled = await call(
      'POST',
      `/v1/hosts/${HOST_ID}/maintenance`,
      JSON.stringify({ enabled: true, reason: 'u237 window' }),
      adminToken
    )
    assert.equal(enabled.status, 200)
    assert.deepEqual(await enabled.json(), { status: 'maintenance' })
    assert.equal(app.store.hosts.get(HOST_ID)?.status, 'maintenance')
    assert.equal(app.store.hosts.get(HOST_ID)?.maintenanceReason, 'u237 window')

    const disabled = await call(
      'POST',
      `/v1/hosts/${HOST_ID}/maintenance`,
      JSON.stringify({ enabled: false }),
      adminToken
    )
    assert.equal(disabled.status, 200)
    assert.deepEqual(await disabled.json(), { status: 'online' })
    assert.equal(app.store.hosts.get(HOST_ID)?.maintenanceReason, null)
  })

  test('正向：项目 policy downloadPolicy 与 inherit 语义不变', async () => {
    const versionBefore = app.store.policies.version
    const pinned = await call(
      'PUT',
      `/v1/projects/${PROJECT_ID}/policy`,
      JSON.stringify({ downloadPolicy: 'allow' }),
      adminToken
    )
    assert.equal(pinned.status, 200)
    const pinnedBody = (await pinned.json()) as Record<string, unknown>
    assert.deepEqual(Object.keys(pinnedBody).sort(), [
      'downloadPolicy',
      'readRatePerHour',
      'version'
    ])
    assert.equal(pinnedBody.downloadPolicy, 'allow')
    assert.equal(app.store.projects.get(PROJECT_ID)?.downloadPolicyExplicit, true)
    assert.equal(app.store.policies.version, versionBefore + 1)

    const inherited = await call(
      'PUT',
      `/v1/projects/${PROJECT_ID}/policy`,
      JSON.stringify({ inherit: true, downloadPolicy: 'deny' }),
      adminToken
    )
    assert.equal(inherited.status, 200)
    const inheritedBody = (await inherited.json()) as Record<string, unknown>
    assert.deepEqual(Object.keys(inheritedBody).sort(), [
      'downloadPolicy',
      'readRatePerHour',
      'version'
    ])
    assert.equal(
      app.store.projects.get(PROJECT_ID)?.downloadPolicyExplicit ?? false,
      false,
      'inherit must ignore downloadPolicy and clear the pin'
    )
  })

  test('正向：全局 policy allow/deny 仍写入并推进版本', async () => {
    const versionBefore = app.store.policies.version
    const allow = await call(
      'PUT',
      '/v1/policies/download',
      JSON.stringify({ downloadDefault: 'allow' }),
      adminToken
    )
    assert.equal(allow.status, 200)
    const allowBody = (await allow.json()) as { downloadDefault: string; version: number }
    assert.equal(allowBody.downloadDefault, 'allow')
    assert.equal(allowBody.version, versionBefore + 1)

    const deny = await call(
      'PUT',
      '/v1/policies/download',
      JSON.stringify({ downloadDefault: 'deny' }),
      adminToken
    )
    assert.equal(deny.status, 200)
    assert.equal(((await deny.json()) as { downloadDefault: string }).downloadDefault, 'deny')
  })

  test('正向：项目更新显式 repoUrl:null 与 defaultBranch 仍合法', async () => {
    const cleared = await call(
      'PUT',
      `/v1/projects/${PROJECT_ID}`,
      JSON.stringify({ repoUrl: null }),
      adminToken
    )
    assert.equal(cleared.status, 200, JSON.stringify(await cleared.clone().json()))
    const clearedBody = (await cleared.json()) as { repoUrl: string; status: string }
    assert.equal(clearedBody.repoUrl, '')
    assert.equal(clearedBody.status, 'ready')

    const branched = await call(
      'PUT',
      `/v1/projects/${PROJECT_ID}`,
      JSON.stringify({ defaultBranch: 'release' }),
      adminToken
    )
    assert.equal(branched.status, 200)
    const branchedBody = (await branched.json()) as { defaultBranch: string }
    assert.equal(branchedBody.defaultBranch, 'release')
    assert.equal(app.store.projects.get(PROJECT_ID)?.status, 'ready')
  })
})
