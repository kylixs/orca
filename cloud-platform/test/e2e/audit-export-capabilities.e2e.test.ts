import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnService, type Service } from './harness.ts'

/**
 * U201 E10: `GET /v1/audit/status` advertises export capabilities as an
 * additive field, so clients never probe the export routes with a 404 and the
 * old response keys keep their meaning. Limits reflect the live store config,
 * including env overrides.
 */

const READY = /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/

let api: Service
let adminToken = ''
let auditorToken = ''
let userToken = ''
let auditorUserId = ''

type AuditExportCapability = {
  formats?: string[]
  maxWindowDays?: number
  maxRows?: number
  maxBytes?: number
  jobTtlSeconds?: number
  downloadTokenTtlSeconds?: number
}

type StatusBody = {
  ok?: boolean
  persisted?: boolean
  eventTypes?: string[]
  auditExport?: AuditExportCapability
  error?: { code?: string }
}

async function login(username: string, password: string, deviceName: string): Promise<string> {
  const res = await fetch(`${api.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, deviceName })
  })
  const body = (await res.json()) as { accessToken?: string }
  assert.equal(res.status, 200, `login failed for ${username}`)
  return body.accessToken ?? ''
}

async function me(token: string): Promise<{ user?: { id?: string } }> {
  const res = await fetch(`${api.url}/v1/me`, { headers: { authorization: `Bearer ${token}` } })
  assert.equal(res.status, 200)
  return (await res.json()) as { user?: { id?: string } }
}

async function status(token: string): Promise<{ status: number; body: StatusBody }> {
  const res = await fetch(`${api.url}/v1/audit/status`, {
    headers: { authorization: `Bearer ${token}` }
  })
  return { status: res.status, body: (await res.json()) as StatusBody }
}

before(async () => {
  api = await spawnService(
    'apps/api/src/server.ts',
    // 15 minutes / 2 minutes: proves both advertised TTLs follow runtime overrides.
    {
      PORT: '0',
      ORCA_AUDIT_EXPORT_TTL_MS: '900000',
      ORCA_AUDIT_EXPORT_TOKEN_TTL_MS: '120000'
    },
    READY,
    'api'
  )
  adminToken = await login('admin', 'Adm1n!', 'capabilities-admin')
  auditorToken = await login('zhangsan', 'Passw0rd!', 'capabilities-auditor')
  userToken = await login('lisi', 'Passw0rd!', 'capabilities-user')

  // The fixture has no seeded auditor; promote zhangsan for the role gate.
  const auditor = await me(auditorToken)
  auditorUserId = auditor.user?.id ?? ''
  assert.ok(auditorUserId)
  const promoted = await fetch(`${api.url}/v1/users/${auditorUserId}/roles`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ role: 'auditor' })
  })
  assert.equal(promoted.status, 200)
})

after(async () => {
  if (auditorUserId) {
    await fetch(`${api.url}/v1/users/${auditorUserId}/roles`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ role: 'developer' })
    }).catch(() => undefined)
  }
  await api?.stop()
})

describe('审计状态导出能力字段（真实平台进程）', () => {
  test('E10-1 管理员可见 auditExport，值与运行时配置一致', async () => {
    const res = await status(adminToken)
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.auditExport, {
      formats: ['csv', 'jsonl'],
      maxWindowDays: 31,
      maxRows: 100000,
      maxBytes: 67108864,
      jobTtlSeconds: 900,
      downloadTokenTtlSeconds: 120
    })
  })

  test('E10-2 auditor 同样可见；旧字段仍在（新增为 additive）', async () => {
    const res = await status(auditorToken)
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.auditExport?.formats, ['csv', 'jsonl'])
    assert.equal(res.body.auditExport?.jobTtlSeconds, 900)
    // Pre-existing keys must survive the addition unchanged.
    assert.equal(typeof res.body.ok, 'boolean')
    assert.equal(typeof res.body.persisted, 'boolean')
    assert.ok(Array.isArray(res.body.eventTypes))
    assert.ok(res.body.eventTypes.includes('audit_export'))
  })

  test('E10-3 普通用户仍被拒绝，且不泄露能力信息', async () => {
    const res = await status(userToken)
    assert.equal(res.status, 403)
    assert.equal(res.body.error?.code, 'PERMISSION_DENIED')
    assert.equal(res.body.auditExport, undefined)
  })
})
