import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuditExportJobStore } from '../../apps/api/src/audit-export-jobs.ts'
import { spawnService, type Service } from './harness.ts'

/**
 * U202 E5: `POST /v1/audit/export` acceptance over the wire. The route only
 * validates, checks quota, persists a queued `job.json` and records the
 * `audit_export` event; the worker and status/download endpoints are E6–E8.
 */

const READY = /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/
const JOB_ID = /^exp_[0-9a-f]{24}$/

let api: Service
let exportDir = ''
let adminToken = ''
let auditorToken = ''
let userToken = ''
let auditorUserId = ''
let adminUserId = ''

type ExportBody = {
  jobId?: string
  status?: string
  format?: string
  requestedAt?: number
  expiresAt?: number
  error?: { code?: string; message?: string; details?: Record<string, unknown> }
}

type AuditPage = {
  events?: {
    eventType?: string
    actor?: string
    result?: string
    metadata?: Record<string, unknown>
  }[]
}

type JobFile = {
  jobId?: string
  status?: string
  createdAt?: number
  expiresAt?: number
  format?: string
  requestedByUsername?: string
  deleteAfterDownload?: boolean
}

async function login(username: string, password: string, deviceName: string): Promise<string> {
  const res = await fetch(`${api.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, deviceName })
  })
  const body: { accessToken?: string } = await res.json()
  assert.equal(res.status, 200, `login failed for ${username}`)
  return body.accessToken ?? ''
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    confirm: true,
    format: 'csv',
    // An explicit recent window keeps the fixture independent of chain age.
    since: new Date(Date.now() - 60 * 60_000).toISOString(),
    ...overrides
  }
}

async function postExport(
  token: string,
  body: Record<string, unknown>
): Promise<{ status: number; headers: Headers; body: ExportBody }> {
  const res = await fetch(`${api.url}/v1/audit/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  })
  return { status: res.status, headers: res.headers, body: await res.json() }
}

async function auditEvents(params: Record<string, string>): Promise<AuditPage> {
  const query = new URLSearchParams({ limit: '100', ...params })
  const res = await fetch(`${api.url}/v1/audit/events?${query}`, {
    headers: { authorization: `Bearer ${adminToken}` }
  })
  assert.equal(res.status, 200)
  return await res.json()
}

/** Job dirs are the observable side effect: an invalid/refused request adds none. */
function jobDirs(): string[] {
  return existsSync(exportDir)
    ? readdirSync(exportDir).filter((name) => name.startsWith('exp_'))
    : []
}

function readJob(jobId: string): JobFile {
  const file = join(exportDir, jobId, 'job.json')
  assert.ok(existsSync(file), `job.json missing for ${jobId}`)
  return JSON.parse(readFileSync(file, 'utf8'))
}

before(async () => {
  exportDir = mkdtempSync(join(tmpdir(), 'orca-audit-export-e2e-'))
  api = await spawnService(
    'apps/api/src/server.ts',
    {
      PORT: '0',
      ORCA_AUDIT_EXPORT_DIR: exportDir,
      ORCA_AUDIT_EXPORT_PER_USER_LIMIT: '2',
      ORCA_AUDIT_EXPORT_GLOBAL_LIMIT: '8'
    },
    READY,
    'api'
  )
  adminToken = await login('admin', 'Adm1n!', 'export-admin')
  auditorToken = await login('zhangsan', 'Passw0rd!', 'export-auditor')
  userToken = await login('lisi', 'Passw0rd!', 'export-user')

  // The fixture has no seeded auditor; promote zhangsan. Roles are read live
  // from the store on every request, so the existing token gains the role.
  const usersRes = await fetch(`${api.url}/v1/users`, {
    headers: { authorization: `Bearer ${adminToken}` }
  })
  const users: { users?: { id?: string; username?: string }[] } = await usersRes.json()
  const admin = users.users?.find((user) => user.username === 'admin')
  if (!admin?.id) {
    throw new Error('seeded admin must exist')
  }
  adminUserId = admin.id
  const zhangsan = users.users?.find((user) => user.username === 'zhangsan')
  if (!zhangsan?.id) {
    throw new Error('seeded user zhangsan must exist')
  }
  auditorUserId = zhangsan.id
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

describe('审计导出受理（真实平台进程）', () => {
  test('E5-1 admin 得到 202 与任务落盘；响应字段齐全且 no-store', async () => {
    const dirsBefore = jobDirs().length
    const res = await postExport(adminToken, validBody())

    assert.equal(res.status, 202)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    const jobId = res.body.jobId ?? ''
    assert.match(jobId, JOB_ID)
    assert.equal(res.body.status, 'queued')
    assert.equal(res.body.format, 'csv')
    assert.equal(typeof res.body.requestedAt, 'number')
    assert.equal(typeof res.body.expiresAt, 'number')
    assert.ok((res.body.expiresAt ?? 0) > (res.body.requestedAt ?? 0))

    const job = readJob(jobId)
    assert.equal(job.jobId, jobId)
    // E6b: the worker starts after the 202, so the file may already be running/succeeded.
    assert.ok(['queued', 'running', 'succeeded'].includes(job.status ?? ''), job.status)
    assert.equal(job.format, 'csv')
    assert.equal(job.requestedByUsername, 'admin')
    assert.equal(job.deleteAfterDownload, false)
    assert.equal(jobDirs().length, dirsBefore + 1)
  })

  test('E5-2 platform:auditor 同样可以受理（jsonl）', async () => {
    const res = await postExport(auditorToken, validBody({ format: 'jsonl' }))
    assert.equal(res.status, 202)
    assert.equal(res.body.format, 'jsonl')
    const job = readJob(res.body.jobId ?? '')
    assert.ok(['queued', 'running', 'succeeded'].includes(job.status ?? ''), job.status)
    assert.equal(job.format, 'jsonl')
    assert.equal(job.requestedByUsername, 'zhangsan')
  })

  test('E5-3 普通用户 403，拒绝入链且不创建任务', async () => {
    const dirsBefore = jobDirs().length
    const res = await postExport(userToken, validBody())

    assert.equal(res.status, 403)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.equal(res.body.error?.code, 'PERMISSION_DENIED')
    assert.equal(jobDirs().length, dirsBefore)

    const log = await auditEvents({ eventType: 'audit_export', result: 'denied' })
    assert.ok(
      log.events?.some((event) => event.actor === 'lisi'),
      'a refused export attempt must be audited'
    )
  })

  test('E5-4 confirm 缺失或 false → 400 EXPORT_CONFIRM_REQUIRED，不创建目录', async () => {
    const dirsBefore = jobDirs().length
    const missing = await postExport(adminToken, { format: 'csv' })
    assert.equal(missing.status, 400)
    assert.equal(missing.body.error?.code, 'EXPORT_CONFIRM_REQUIRED')

    const falsy = await postExport(adminToken, validBody({ confirm: false }))
    assert.equal(falsy.status, 400)
    assert.equal(falsy.body.error?.code, 'EXPORT_CONFIRM_REQUIRED')
    assert.equal(jobDirs().length, dirsBefore)
  })

  test('E5-5 format 非法 → 400 INVALID_QUERY', async () => {
    const res = await postExport(adminToken, validBody({ format: 'xml' }))
    assert.equal(res.status, 400)
    assert.equal(res.body.error?.code, 'INVALID_QUERY')
  })

  test('E5-6 超过 31 天窗口 → 400 TIME_WINDOW_TOO_LARGE', async () => {
    const res = await postExport(
      adminToken,
      validBody({ since: new Date(Date.now() - 40 * 86_400_000).toISOString() })
    )
    assert.equal(res.status, 400)
    assert.equal(res.body.error?.code, 'TIME_WINDOW_TOO_LARGE')
  })

  test('E5-7 eventTypes 21 个 → 400 INVALID_QUERY', async () => {
    const eventTypes = Array.from({ length: 21 }, (_, index) => `event_${index}`)
    const res = await postExport(adminToken, validBody({ eventTypes }))
    assert.equal(res.status, 400)
    assert.equal(res.body.error?.code, 'INVALID_QUERY')
  })

  test('E5-8 并发上限：活动任务达上限时 → 429 EXPORT_BUSY', async () => {
    // E6b consumes accepted jobs immediately, so accepted requests cannot hold
    // the quota open. Seed two queued jobs for the admin directly instead.
    const store = new AuditExportJobStore({
      root: exportDir,
      perUserActiveLimit: 2,
      globalActiveLimit: 8
    })
    for (let index = 0; index < 2; index += 1) {
      store.create({
        requestedBy: adminUserId,
        requestedByUsername: 'admin',
        query: { limit: 50 },
        format: 'csv'
      })
    }

    const dirsBefore = jobDirs().length
    const third = await postExport(adminToken, validBody())
    assert.equal(third.status, 429)
    assert.equal(third.headers.get('cache-control'), 'no-store')
    assert.equal(third.body.error?.code, 'EXPORT_BUSY')
    assert.equal(jobDirs().length, dirsBefore)
  })

  test('E5-9 受理事件入链：metadata 含 jobId 与过滤条件，不含 token', async () => {
    const log = await auditEvents({ eventType: 'audit_export', result: 'success' })
    const events = log.events ?? []
    assert.ok(events.length > 0, 'at least one accepted export must be audited')

    const event = events.find((entry) => {
      const jobId = entry.metadata?.jobId
      return entry.actor === 'admin' && typeof jobId === 'string' && JOB_ID.test(jobId)
    })
    assert.ok(event, 'accepted export event must carry its jobId')
    assert.equal(event.actor, 'admin')

    const metadata = event.metadata ?? {}
    assert.equal(metadata.format, 'csv')
    assert.equal(typeof metadata.query, 'object')
    assert.ok(metadata.limits !== undefined, 'event must state the row/byte caps')
    assert.equal(
      JSON.stringify(metadata).toLowerCase().includes('token'),
      false,
      'audit metadata must never carry a download token'
    )

    const jobId = typeof metadata.jobId === 'string' ? metadata.jobId : ''
    const job = readJob(jobId)
    assert.ok(['queued', 'running', 'succeeded'].includes(job.status ?? ''), job.status)
  })
})
