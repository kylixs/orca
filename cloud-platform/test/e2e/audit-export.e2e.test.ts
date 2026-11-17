import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuditExportJobStore } from '../../apps/api/src/audit-export-jobs.ts'
import {
  AUDIT_RECENT_WINDOW_MS,
  AUDIT_WINDOW_MS
} from '../../apps/api/src/audit-query.ts'
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
    ts?: number
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
  totalEvents?: number
  query?: Record<string, unknown>
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

/** The worker starts after the 202 via setImmediate; poll the atomic job file. */
async function waitForTerminal(jobId: string): Promise<JobFile> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const job = readJob(jobId)
    if (job.status === 'succeeded' || job.status === 'failed') {
      return job
    }
    if (Date.now() > deadline) {
      throw new Error(`job ${jobId} did not finish (status=${job.status})`)
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
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

  test('E5-10 全部过滤字段生效：不存在的精确值导出 0 条，对照 >0', async () => {
    const filters = {
      eventType: 'no_such_event_type',
      actor: 'no_such_actor',
      result: 'no_such_result',
      traceId: 'no_such_trace',
      username: 'no_such_user',
      projectId: 'no_such_project',
      hostId: 'no_such_host'
    }
    const res = await postExport(adminToken, validBody(filters))
    assert.equal(res.status, 202)
    const jobId = res.body.jobId ?? ''
    const job = await waitForTerminal(jobId)
    assert.equal(job.status, 'succeeded')
    assert.equal(job.totalEvents, 0)
    assert.deepEqual(
      {
        eventType: job.query?.eventType,
        actor: job.query?.actor,
        result: job.query?.result,
        traceId: job.query?.traceId,
        username: job.query?.username,
        projectId: job.query?.projectId,
        hostId: job.query?.hostId
      },
      filters
    )

    const artifact = join(exportDir, jobId, 'events.csv')
    assert.equal(existsSync(artifact), true)
    // Empty export: CSV header only.
    assert.equal(
      readFileSync(artifact, 'utf8')
        .split('\r\n')
        .filter((line) => line !== '').length,
      1
    )

    // The acceptance audit event snapshots the same full filter set.
    const log = await auditEvents({ eventType: 'audit_export', result: 'success' })
    const accepted = log.events?.find(
      (entry) => entry.metadata?.jobId === jobId && entry.metadata?.phase === 'accepted'
    )
    assert.ok(accepted, 'accepted export must be audited with its jobId')
    assert.equal(accepted.metadata?.phase, 'accepted')
    const auditedQuery = accepted.metadata?.query
    assert.ok(isRecord(auditedQuery))
    assert.deepEqual(
      {
        eventType: auditedQuery.eventType,
        actor: auditedQuery.actor,
        result: auditedQuery.result,
        traceId: auditedQuery.traceId,
        username: auditedQuery.username,
        projectId: auditedQuery.projectId,
        hostId: auditedQuery.hostId
      },
      filters
    )

    const control = await postExport(adminToken, validBody())
    assert.equal(control.status, 202)
    const controlJob = await waitForTerminal(control.body.jobId ?? '')
    assert.equal(controlJob.status, 'succeeded')
    assert.ok((controlJob.totalEvents ?? 0) > 0, 'unfiltered export must see fixture events')
  })

  test('E5-11 默认窗口在受理时冻结：q/fileName 7 天，其余 31 天，until=受理时刻', async () => {
    const qBefore = Date.now()
    const qRes = await postExport(adminToken, {
      confirm: true,
      format: 'csv',
      q: 'no-such-keyword'
    })
    assert.equal(qRes.status, 202)
    const qJob = await waitForTerminal(qRes.body.jobId ?? '')
    const qSince = typeof qJob.query?.since === 'number' ? qJob.query.since : Number.NaN
    assert.ok(
      Math.abs(qSince - (qBefore - AUDIT_RECENT_WINDOW_MS)) <= 5_000,
      `q filter must default to 7 days, got ${qSince}`
    )
    const qUntil = typeof qJob.query?.until === 'number' ? qJob.query.until : Number.NaN
    assert.ok(
      Math.abs(qUntil - (qJob.createdAt ?? 0)) <= 5_000,
      `an absent until must freeze at acceptance, got ${qUntil}`
    )

    const defaultBefore = Date.now()
    const defaultRes = await postExport(adminToken, { confirm: true, format: 'csv' })
    assert.equal(defaultRes.status, 202)
    const defaultJob = await waitForTerminal(defaultRes.body.jobId ?? '')
    const defaultSince =
      typeof defaultJob.query?.since === 'number' ? defaultJob.query.since : Number.NaN
    assert.ok(
      Math.abs(defaultSince - (defaultBefore - AUDIT_WINDOW_MS)) <= 5_000,
      `an unfiltered export must keep the 31-day window, got ${defaultSince}`
    )
    const defaultUntil =
      typeof defaultJob.query?.until === 'number' ? defaultJob.query.until : Number.NaN
    assert.ok(
      Math.abs(defaultUntil - (defaultJob.createdAt ?? 0)) <= 5_000,
      `an unfiltered export must freeze until at acceptance, got ${defaultUntil}`
    )
  })

  test('E5-12 显式时间界原样冻结；未来 until 夹到受理时刻并写入受理审计', async () => {
    const since = Date.now() - 2 * 60 * 60_000
    const until = Date.now() - 60 * 60_000
    const explicit = await postExport(adminToken, {
      confirm: true,
      format: 'csv',
      since: new Date(since).toISOString(),
      until: new Date(until).toISOString()
    })
    assert.equal(explicit.status, 202)
    const explicitJob = await waitForTerminal(explicit.body.jobId ?? '')
    assert.equal(explicitJob.query?.since, since)
    assert.equal(explicitJob.query?.until, until)

    const log = await auditEvents({ eventType: 'audit_export', result: 'success' })
    const accepted = log.events?.find(
      (entry) =>
        entry.metadata?.jobId === explicit.body.jobId && entry.metadata?.phase === 'accepted'
    )
    assert.ok(accepted, 'accepted export must be audited')
    const auditedQuery = accepted.metadata?.query
    assert.ok(isRecord(auditedQuery))
    assert.equal(auditedQuery.since, since)
    assert.equal(auditedQuery.until, until)

    const futureBefore = Date.now()
    const future = await postExport(adminToken, {
      confirm: true,
      format: 'csv',
      until: new Date(Date.now() + 24 * 60 * 60_000).toISOString()
    })
    assert.equal(future.status, 202)
    const futureJob = await waitForTerminal(future.body.jobId ?? '')
    const futureUntil =
      typeof futureJob.query?.until === 'number' ? futureJob.query.until : Number.NaN
    assert.ok(
      Math.abs(futureUntil - (futureJob.createdAt ?? 0)) <= 5_000,
      `a future until must clamp to acceptance, got ${futureUntil}`
    )
    assert.ok(futureUntil < futureBefore + 5_000, `future until leaked: ${futureUntil}`)
  })

  test('E5-13 并发受理的任务串行执行且都会完成（drain 闸门）', async () => {
    const body = (keyword: string): Record<string, unknown> => ({
      confirm: true,
      format: 'csv',
      q: keyword,
      since: new Date(Date.now() - 60 * 60_000).toISOString()
    })
    const [first, second] = await Promise.all([
      postExport(auditorToken, body('no-such-keyword-a')),
      postExport(auditorToken, body('no-such-keyword-b'))
    ])
    assert.equal(first.status, 202)
    assert.equal(second.status, 202)

    const jobs = await Promise.all([
      waitForTerminal(first.body.jobId ?? ''),
      waitForTerminal(second.body.jobId ?? '')
    ])
    assert.deepEqual(
      jobs.map((job) => job.status),
      ['succeeded', 'succeeded']
    )
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
      return (
        entry.actor === 'admin' &&
        entry.metadata?.phase === 'accepted' &&
        typeof jobId === 'string' &&
        JOB_ID.test(jobId)
      )
    })
    assert.ok(event, 'accepted export event must carry its jobId')
    assert.equal(event.actor, 'admin')

    const metadata = event.metadata ?? {}
    assert.equal(metadata.phase, 'accepted')
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
    // F12: acceptance is on the chain no later than the directory that holds the job.
    assert.ok(
      typeof event.ts === 'number' && typeof job.createdAt === 'number' && event.ts <= job.createdAt,
      `acceptance audit (${event.ts}) must precede job.json (${job.createdAt})`
    )
  })
})
