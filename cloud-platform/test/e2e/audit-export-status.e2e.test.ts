import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuditExportJobStore } from '../../apps/api/src/audit-export-jobs.ts'
import type { AuditQueryFilters } from '../../apps/api/src/audit-query.ts'
import { spawnService, type Service } from './harness.ts'

/**
 * U202 E7: `GET /v1/audit/exports/{jobId}` over the wire. The route only reads
 * the file-backed job store; jobs are pre-seeded here because the worker (E6b)
 * is out of scope. Ownership is the creator only, and every succeeded read
 * rotates the download token.
 */

const READY = /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/
const JOB_ID = /^exp_[0-9a-f]{24}$/

let api: Service
let exportDir = ''
let store: AuditExportJobStore
let adminToken = ''
let auditorToken = ''
let userToken = ''
let adminId = ''
let auditorUserId = ''
let auditorId = ''

type StatusBody = {
  jobId?: string
  status?: string
  format?: string
  requestedAt?: number
  startedAt?: number
  finishedAt?: number
  expiresAt?: number
  totalEvents?: number
  bytes?: number
  error?: { code?: string; message?: string }
  downloadUrl?: string
  downloaded?: boolean
  downloadUnavailableReason?: string
}

type StatusResponse = { status: number; headers: Headers; body: StatusBody }

type Me = { user?: { id?: string; username?: string } }

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

async function me(token: string): Promise<Me> {
  const res = await fetch(`${api.url}/v1/me`, { headers: { authorization: `Bearer ${token}` } })
  assert.equal(res.status, 200)
  return await res.json()
}

async function getStatus(token: string, jobId: string): Promise<StatusResponse> {
  const res = await fetch(`${api.url}/v1/audit/exports/${jobId}`, {
    headers: { authorization: `Bearer ${token}` }
  })
  return { status: res.status, headers: res.headers, body: await res.json() }
}

function baseQuery(): AuditQueryFilters {
  const nowMs = Date.now()
  return { limit: 50, since: nowMs - 60 * 60_000, until: nowMs }
}

function createJob(ownerId: string, username: string, format: 'csv' | 'jsonl' = 'csv'): string {
  return store.create({
    requestedBy: ownerId,
    requestedByUsername: username,
    query: baseQuery(),
    format
  }).jobId
}

/** queued → running → succeeded; the store forbids skipping running. */
function succeededJob(
  ownerId: string,
  username: string,
  over: { deleteAfterDownload?: boolean } = {}
): string {
  const jobId = store.create({
    requestedBy: ownerId,
    requestedByUsername: username,
    query: baseQuery(),
    format: 'csv',
    deleteAfterDownload: over.deleteAfterDownload ?? false
  }).jobId
  store.markRunning(jobId)
  store.markSucceeded(jobId, { totalEvents: 12, bytes: 345 })
  return jobId
}

function tokenFromDownloadUrl(downloadUrl: string): string {
  const token = new URL(downloadUrl, 'http://localhost').searchParams.get('token')
  assert.ok(token, 'downloadUrl must carry a token')
  return token
}

before(async () => {
  exportDir = mkdtempSync(join(tmpdir(), 'orca-audit-export-status-e2e-'))
  api = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', ORCA_AUDIT_EXPORT_DIR: exportDir },
    READY,
    'api'
  )
  const dir = api.env.ORCA_AUDIT_EXPORT_DIR
  assert.equal(dir, exportDir)
  store = new AuditExportJobStore({ root: dir })
  adminToken = await login('admin', 'Adm1n!', 'status-admin')
  auditorToken = await login('zhangsan', 'Passw0rd!', 'status-auditor')
  userToken = await login('lisi', 'Passw0rd!', 'status-user')

  // The fixture has no seeded auditor; promote zhangsan so it passes the gate
  // and can serve as the "other identity" for ownership checks.
  const admin = await me(adminToken)
  const auditor = await me(auditorToken)
  adminId = admin.user?.id ?? ''
  auditorUserId = auditor.user?.id ?? ''
  assert.ok(adminId && auditorUserId)
  const promoted = await fetch(`${api.url}/v1/users/${auditorUserId}/roles`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ role: 'auditor' })
  })
  assert.equal(promoted.status, 200)
  const auditorAfter = await me(auditorToken)
  auditorId = auditorAfter.user?.id ?? ''
  assert.equal(auditorId, auditorUserId)
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
  rmSync(exportDir, { recursive: true, force: true })
})

describe('审计导出状态（真实平台进程）', () => {
  test('E7-1 queued：返回请求时间与过期时间，无下载链接，no-store', async () => {
    const jobId = createJob(adminId, 'admin')
    const before = store.read(jobId)
    assert.ok(before)

    const res = await getStatus(adminToken, jobId)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.match(res.body.jobId ?? '', JOB_ID)
    assert.equal(res.body.jobId, jobId)
    assert.equal(res.body.status, 'queued')
    assert.equal(res.body.format, 'csv')
    assert.equal(res.body.requestedAt, before.createdAt)
    assert.equal(res.body.expiresAt, before.expiresAt)
    assert.equal(res.body.startedAt, undefined)
    assert.equal(res.body.finishedAt, undefined)
    assert.equal(res.body.downloadUrl, undefined)
  })

  test('E7-2 running：返回 startedAt，仍无下载链接', async () => {
    const jobId = createJob(adminId, 'admin', 'jsonl')
    store.markRunning(jobId)
    const job = store.read(jobId)
    assert.ok(job?.startedAt)

    const res = await getStatus(adminToken, jobId)
    assert.equal(res.status, 200)
    assert.equal(res.body.status, 'running')
    assert.equal(res.body.format, 'jsonl')
    assert.equal(res.body.startedAt, job.startedAt)
    assert.equal(res.body.downloadUrl, undefined)
  })

  test('E7-3 failed：返回 error 且无下载链接', async () => {
    const jobId = createJob(adminId, 'admin')
    store.markFailed(jobId, { code: 'EXPORT_WRITE_FAILED', message: '磁盘写入失败' })

    const res = await getStatus(adminToken, jobId)
    assert.equal(res.status, 200)
    assert.equal(res.body.status, 'failed')
    assert.equal(res.body.error?.code, 'EXPORT_WRITE_FAILED')
    assert.equal(res.body.error?.message, '磁盘写入失败')
    assert.equal(res.body.downloadUrl, undefined)
  })

  test('E7-4 succeeded：返回 totalEvents/bytes 与可验证的 downloadUrl', async () => {
    const jobId = succeededJob(adminId, 'admin')

    const res = await getStatus(adminToken, jobId)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.equal(res.body.status, 'succeeded')
    assert.equal(res.body.totalEvents, 12)
    assert.equal(res.body.bytes, 345)
    assert.equal(typeof res.body.finishedAt, 'number')
    assert.ok(res.body.downloadUrl?.startsWith(`/v1/audit/exports/${jobId}/download?token=`))

    const token = tokenFromDownloadUrl(res.body.downloadUrl ?? '')
    assert.deepEqual(store.verifyDownloadToken(jobId, token), { ok: true })
  })

  test('E7-5 每次状态读取轮换 token：旧 token 立即失效', async () => {
    const jobId = succeededJob(adminId, 'admin')

    const first = await getStatus(adminToken, jobId)
    const firstToken = tokenFromDownloadUrl(first.body.downloadUrl ?? '')
    assert.deepEqual(store.verifyDownloadToken(jobId, firstToken), { ok: true })

    const second = await getStatus(adminToken, jobId)
    const secondToken = tokenFromDownloadUrl(second.body.downloadUrl ?? '')
    assert.notEqual(secondToken, firstToken)
    assert.deepEqual(store.verifyDownloadToken(jobId, firstToken), {
      ok: false,
      reason: 'invalid'
    })
    assert.deepEqual(store.verifyDownloadToken(jobId, secondToken), { ok: true })
  })

  test('E7-6 已下载不设 deleteAfterDownload：仍下发新 downloadUrl', async () => {
    const jobId = succeededJob(adminId, 'admin')
    const issued = store.issueDownloadToken(jobId)
    assert.ok(issued)
    assert.equal(store.consumeDownloadToken(jobId, issued.token).ok, true)

    const res = await getStatus(adminToken, jobId)
    assert.equal(res.status, 200)
    assert.equal(res.body.status, 'succeeded')
    // The artifact survives, so status mints a replacement token.
    assert.ok(res.body.downloadUrl?.startsWith(`/v1/audit/exports/${jobId}/download?token=`))
    assert.equal(res.body.downloadUnavailableReason, undefined)
    const rotated = tokenFromDownloadUrl(res.body.downloadUrl ?? '')
    assert.deepEqual(store.verifyDownloadToken(jobId, rotated), { ok: true })
    // The redeemed token stays dead.
    assert.deepEqual(store.verifyDownloadToken(jobId, issued.token), {
      ok: false,
      reason: 'invalid'
    })
  })

  test('E7-6b 已下载且 deleteAfterDownload：不再下发 downloadUrl，提示产物已删除', async () => {
    const jobId = succeededJob(adminId, 'admin', { deleteAfterDownload: true })
    const issued = store.issueDownloadToken(jobId)
    assert.ok(issued)
    assert.equal(store.consumeDownloadToken(jobId, issued.token).ok, true)

    const res = await getStatus(adminToken, jobId)
    assert.equal(res.status, 200)
    assert.equal(res.body.status, 'succeeded')
    assert.equal(res.body.downloaded, true)
    assert.equal(res.body.downloadUnavailableReason, 'deleted_after_download')
    assert.equal(res.body.downloadUrl, undefined)
  })

  test('E7-7 过期任务 → 410 EXPORT_EXPIRED，no-store', async () => {
    // Negative TTL persists an already-expired window without waiting.
    const expiring = new AuditExportJobStore({ root: exportDir, ttlMs: -1 })
    const jobId = expiring.create({
      requestedBy: adminId,
      requestedByUsername: 'admin',
      query: baseQuery(),
      format: 'csv'
    }).jobId
    const expired = expiring.read(jobId)
    assert.ok(expired)
    assert.equal(expiring.isExpired(expired), true)

    const res = await getStatus(adminToken, jobId)
    assert.equal(res.status, 410)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.equal(res.body.error?.code, 'EXPORT_EXPIRED')
  })

  test('E7-8 未知/非法 jobId → 404 EXPORT_NOT_FOUND，不泄露存在性', async () => {
    const unknown = await getStatus(adminToken, `exp_${'0'.repeat(24)}`)
    assert.equal(unknown.status, 404)
    assert.equal(unknown.headers.get('cache-control'), 'no-store')
    assert.equal(unknown.body.error?.code, 'EXPORT_NOT_FOUND')

    for (const bad of ['not-a-job', 'exp_zzzz', 'exp_1234']) {
      const res = await getStatus(adminToken, bad)
      assert.equal(res.status, 404, `${bad} must be rejected`)
      assert.equal(res.body.error?.code, 'EXPORT_NOT_FOUND')
    }
  })

  test('E7-9 他人任务 → 404；本人查询同一任务 → 200', async () => {
    const jobId = createJob(auditorId, 'zhangsan')

    const foreign = await getStatus(adminToken, jobId)
    assert.equal(foreign.status, 404)
    assert.equal(foreign.body.error?.code, 'EXPORT_NOT_FOUND')

    const own = await getStatus(auditorToken, jobId)
    assert.equal(own.status, 200)
    assert.equal(own.body.jobId, jobId)
  })

  test('E7-10 普通用户 → 403 PERMISSION_DENIED，no-store', async () => {
    const jobId = createJob(adminId, 'admin')

    const res = await getStatus(userToken, jobId)
    assert.equal(res.status, 403)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.equal(res.body.error?.code, 'PERMISSION_DENIED')
  })
})
