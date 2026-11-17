import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  AuditExportJobStore,
  resolveAuditExportObjectPath
} from '../../apps/api/src/audit-export-jobs.ts'
import type { AuditQueryFilters } from '../../apps/api/src/audit-query.ts'
import { login, spawnService, type Service } from './harness.ts'

/**
 * U202 E8: `GET /v1/audit/exports/{jobId}/download` over the wire. Artifacts and
 * succeeded jobs are pre-seeded because the worker is out of scope here. The
 * link is self-contained: requests carry no Bearer, only the one-shot token.
 */

const READY = /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/

let api: Service
let exportDir = ''
let store: AuditExportJobStore
let adminToken = ''
let adminId = ''

type DownloadResponse = { status: number; headers: Headers; body: string }

type AuditEventBody = {
  events: {
    eventType: string
    actor: string | null
    targetId: string | null
    metadata?: Record<string, unknown>
  }[]
}

function baseQuery(): AuditQueryFilters {
  const nowMs = Date.now()
  return { limit: 50, since: nowMs - 60 * 60_000, until: nowMs }
}

function seedSucceededJob(options: {
  format: 'csv' | 'jsonl'
  content: string
  totalEvents: number
  deleteAfterDownload?: boolean
  root?: string
  ownerId?: string
  ownerName?: string
}): { jobId: string; artifactPath: string; jobStore: AuditExportJobStore } {
  const root = options.root ?? exportDir
  const jobStore = root === exportDir ? store : new AuditExportJobStore({ root })
  const job = jobStore.create({
    requestedBy: options.ownerId ?? adminId,
    requestedByUsername: options.ownerName ?? 'admin',
    query: baseQuery(),
    format: options.format,
    deleteAfterDownload: options.deleteAfterDownload ?? false
  })
  jobStore.markRunning(job.jobId)
  const artifactPath = resolveAuditExportObjectPath(root, job.jobId, options.format)
  assert.ok(artifactPath)
  mkdirSync(dirname(artifactPath), { recursive: true })
  writeFileSync(artifactPath, options.content)
  jobStore.markSucceeded(job.jobId, {
    totalEvents: options.totalEvents,
    bytes: Buffer.byteLength(options.content)
  })
  return { jobId: job.jobId, artifactPath, jobStore }
}

function tokenFromStatus(jobId: string): Promise<string> {
  return getStatus(jobId).then((res) => {
    assert.equal(res.status, 200)
    return tokenFromStatusFromUrl(res.body.downloadUrl)
  })
}

function tokenFromStatusFromUrl(downloadUrl: string | undefined): string {
  assert.ok(downloadUrl, 'status must return a downloadUrl')
  const token = new URL(downloadUrl, 'http://localhost').searchParams.get('token')
  assert.ok(token, 'downloadUrl must carry a token')
  return token
}

async function getStatus(jobId: string): Promise<{
  status: number
  body: { downloadUrl?: string; downloaded?: boolean }
}> {
  const res = await fetch(`${api.url}/v1/audit/exports/${jobId}`, {
    headers: { authorization: `Bearer ${adminToken}` }
  })
  return { status: res.status, body: await res.json() }
}

async function download(jobId: string, token?: string): Promise<DownloadResponse> {
  const query = token === undefined ? '' : `?token=${encodeURIComponent(token)}`
  const res = await fetch(`${api.url}/v1/audit/exports/${jobId}/download${query}`)
  return { status: res.status, headers: res.headers, body: await res.text() }
}

function errorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: string } }
    return parsed.error?.code
  } catch {
    return undefined
  }
}

const CSV = 'seq,eventType,actor\n1,login,admin\n2,logout,admin\n'
const JSONL = '{"seq":1,"eventType":"login"}\n{"seq":2,"eventType":"logout"}\n'

async function waitForDeletion(file: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (!existsSync(file)) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.fail(`artifact was not deleted: ${file}`)
}

before(async () => {
  exportDir = mkdtempSync(join(tmpdir(), 'orca-audit-export-download-e2e-'))
  api = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', ORCA_AUDIT_EXPORT_DIR: exportDir },
    READY,
    'api'
  )
  store = new AuditExportJobStore({ root: api.env.ORCA_AUDIT_EXPORT_DIR ?? exportDir })
  adminToken = await login(api.url, 'admin', 'Adm1n!')
  const me = await fetch(`${api.url}/v1/me`, {
    headers: { authorization: `Bearer ${adminToken}` }
  })
  const body = (await me.json()) as { user?: { id?: string } }
  adminId = body.user?.id ?? ''
  assert.ok(adminId)
})

after(async () => {
  await api?.stop()
  rmSync(exportDir, { recursive: true, force: true })
})

describe('审计导出下载（真实平台进程）', () => {
  test('E8-1 CSV 下载：字节与产物一致，头部齐全；同一 token 二次下载 404', async () => {
    const { jobId, artifactPath } = seedSucceededJob({
      format: 'csv',
      content: CSV,
      totalEvents: 2
    })
    const token = await tokenFromStatus(jobId)

    const res = await download(jobId, token)
    assert.equal(res.status, 200)
    assert.equal(res.body, CSV)
    assert.equal(res.headers.get('content-type'), 'text/csv; charset=utf-8')
    assert.equal(
      res.headers.get('content-disposition'),
      `attachment; filename="audit-export-${jobId}.csv"`
    )
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(Number(res.headers.get('content-length')), Buffer.byteLength(CSV))
    // The artifact stays because this job did not request deletion.
    assert.equal(existsSync(artifactPath), true)

    // Redemption clears the issuer hash, so the token is indistinguishable
    // from an unknown one (and cannot confirm the job exists).
    const again = await download(jobId, token)
    assert.equal(again.status, 404)
    assert.equal(again.headers.get('cache-control'), 'no-store')
    assert.equal(errorCode(again.body), 'EXPORT_NOT_FOUND')

    // A missing token always answers as unknown, never confirming the job.
    const noToken = await download(jobId)
    assert.equal(noToken.status, 404)
    assert.equal(errorCode(noToken.body), 'EXPORT_NOT_FOUND')
  })

  test('E8-2 JSONL 下载：ndjson content-type，行数与产物一致', async () => {
    const { jobId } = seedSucceededJob({ format: 'jsonl', content: JSONL, totalEvents: 2 })
    const token = await tokenFromStatus(jobId)

    const res = await download(jobId, token)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'application/x-ndjson; charset=utf-8')
    assert.equal(
      res.headers.get('content-disposition'),
      `attachment; filename="audit-export-${jobId}.jsonl"`
    )
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(res.body, JSONL)
    assert.equal(res.body.split('\n').filter(Boolean).length, 2)
  })

  test('E8-3 状态轮换：旧 token 404，新 token 下载成功，再次使用新 token 404', async () => {
    const { jobId } = seedSucceededJob({ format: 'csv', content: CSV, totalEvents: 2 })
    const first = await tokenFromStatus(jobId)
    const second = await tokenFromStatus(jobId)
    assert.notEqual(first, second)

    const stale = await download(jobId, first)
    assert.equal(stale.status, 404)
    assert.equal(errorCode(stale.body), 'EXPORT_NOT_FOUND')

    const fresh = await download(jobId, second)
    assert.equal(fresh.status, 200)
    assert.equal(fresh.body, CSV)

    const reused = await download(jobId, second)
    assert.equal(reused.status, 404)
    assert.equal(errorCode(reused.body), 'EXPORT_NOT_FOUND')
  })

  test('E8-4 token 缺失/错误 → 404，且不会烧掉有效 token', async () => {
    const { jobId } = seedSucceededJob({ format: 'csv', content: CSV, totalEvents: 2 })
    const token = await tokenFromStatus(jobId)

    const missing = await download(jobId)
    assert.equal(missing.status, 404)
    assert.equal(errorCode(missing.body), 'EXPORT_NOT_FOUND')

    const wrong = await download(jobId, 'not-the-token')
    assert.equal(wrong.status, 404)
    assert.equal(errorCode(wrong.body), 'EXPORT_NOT_FOUND')

    // Failed checks precede consumption, so the real token still works.
    const valid = await download(jobId, token)
    assert.equal(valid.status, 200)
  })

  test('E8-5 token 换 jobId → 404，原 job 的 token 仍可用', async () => {
    const a = seedSucceededJob({ format: 'csv', content: CSV, totalEvents: 2 })
    const b = seedSucceededJob({ format: 'jsonl', content: JSONL, totalEvents: 2 })
    const tokenForA = await tokenFromStatus(a.jobId)

    const swapped = await download(b.jobId, tokenForA)
    assert.equal(swapped.status, 404)
    assert.equal(errorCode(swapped.body), 'EXPORT_NOT_FOUND')

    const own = await download(a.jobId, tokenForA)
    assert.equal(own.status, 200)
  })

  test('E8-6 未知 job、非法 jobId、路径穿越形态 → 404', async () => {
    const unknown = await download(`exp_${'0'.repeat(24)}`, 'anything')
    assert.equal(unknown.status, 404)
    assert.equal(errorCode(unknown.body), 'EXPORT_NOT_FOUND')

    for (const bad of ['not-a-job', '..%2F..%2Fetc%2Fpasswd', '%2Fetc%2Fpasswd']) {
      const res = await download(bad, 'anything')
      assert.equal(res.status, 404, `${bad} must be rejected`)
      assert.equal(errorCode(res.body), 'EXPORT_NOT_FOUND')
    }
  })

  test('E8-7 过期任务 → 410 EXPORT_EXPIRED', async () => {
    const expiredStore = new AuditExportJobStore({ root: exportDir, ttlMs: -1 })
    const jobId = expiredStore.create({
      requestedBy: adminId,
      requestedByUsername: 'admin',
      query: baseQuery(),
      format: 'csv'
    }).jobId

    const res = await download(jobId, 'anything')
    assert.equal(res.status, 410)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.equal(errorCode(res.body), 'EXPORT_EXPIRED')
  })

  test('E8-8 已下载但产物保留：状态轮换出新 token，可再次下载成功', async () => {
    const { jobId } = seedSucceededJob({ format: 'csv', content: CSV, totalEvents: 2 })
    const first = await tokenFromStatus(jobId)
    assert.equal((await download(jobId, first)).status, 200)

    // downloadedAt no longer blocks reissue: the artifact is still on disk.
    const status = await getStatus(jobId)
    assert.equal(status.status, 200)
    assert.equal(status.body.downloaded, undefined)
    const second = tokenFromStatusFromUrl(status.body.downloadUrl)
    assert.notEqual(second, first)
    assert.equal(
      (await download(jobId, first)).status,
      404,
      'the redeemed token must not work again'
    )

    const again = await download(jobId, second)
    assert.equal(again.status, 200)
    assert.equal(again.body, CSV)
  })

  test('E8-9 deleteAfterDownload：产物删除、job.json 保留、不再签发，新 token 下载 410', async () => {
    const { jobId, artifactPath, jobStore } = seedSucceededJob({
      format: 'csv',
      content: CSV,
      totalEvents: 2,
      deleteAfterDownload: true
    })
    const token = await tokenFromStatus(jobId)

    const res = await download(jobId, token)
    assert.equal(res.status, 200)
    assert.equal(res.body, CSV)

    await waitForDeletion(artifactPath)
    assert.equal(existsSync(join(exportDir, jobId, 'job.json')), true)
    // The artifact is gone, so the store refuses to mint another link.
    assert.equal(jobStore.issueDownloadToken(jobId), null)

    const status = await getStatus(jobId)
    assert.equal(status.status, 200)
    assert.equal(status.body.downloaded, true)
    assert.equal(status.body.downloadUrl, undefined)

    // A valid token whose artifact vanished (e.g. deleted by a concurrent
    // download or an operator) still answers 410 rather than 404.
    const { jobId: vanishId, artifactPath: vanishPath } = seedSucceededJob({
      format: 'csv',
      content: CSV,
      totalEvents: 2
    })
    const vanishToken = await tokenFromStatus(vanishId)
    rmSync(vanishPath, { force: true })
    const gone = await download(vanishId, vanishToken)
    assert.equal(gone.status, 410)
    assert.equal(errorCode(gone.body), 'EXPORT_DOWNLOAD_GONE')
  })

  test('E8-10 审计链写入 audit_export_download：actor/metadata 正确且不含 token', async () => {
    const { jobId } = seedSucceededJob({ format: 'csv', content: CSV, totalEvents: 2 })
    const token = await tokenFromStatus(jobId)
    assert.equal((await download(jobId, token)).status, 200)

    const res = await fetch(
      `${api.url}/v1/audit/events?eventType=audit_export_download&limit=200`,
      { headers: { authorization: `Bearer ${adminToken}` } }
    )
    assert.equal(res.status, 200)
    const page = (await res.json()) as AuditEventBody
    const event = page.events.find((entry) => entry.targetId === jobId)
    assert.ok(event, 'audit_export_download event must be on the chain')
    assert.equal(event.eventType, 'audit_export_download')
    assert.equal(event.actor, 'admin')
    assert.equal(event.metadata?.jobId, jobId)
    assert.equal(event.metadata?.format, 'csv')
    assert.equal(event.metadata?.totalEvents, 2)
    assert.equal(event.metadata?.bytes, Buffer.byteLength(CSV))
    assert.equal(JSON.stringify(event).includes(token), false)
  })

  test('E8-11 审计不可写时 fail-closed：500 EXPORT_AUDIT_UNAVAILABLE，文件不发送', async () => {
    const failDir = mkdtempSync(join(tmpdir(), 'orca-audit-export-download-fail-'))
    let failApi: Service | undefined
    try {
      failApi = await spawnService(
        'apps/api/src/server.ts',
        {
          PORT: '0',
          ORCA_AUDIT_EXPORT_DIR: failDir,
          // Port 1 refuses fast, so the pre-body audit append throws.
          ORCA_CLOUD_AUDIT_WRITER_URL: 'http://127.0.0.1:1'
        },
        READY,
        'api-audit-down'
      )
      const failStore = new AuditExportJobStore({ root: failDir })
      const job = failStore.create({
        requestedBy: 'u_fail',
        requestedByUsername: 'admin',
        query: baseQuery(),
        format: 'csv'
      })
      failStore.markRunning(job.jobId)
      const artifactPath = resolveAuditExportObjectPath(failDir, job.jobId, 'csv')
      assert.ok(artifactPath)
      mkdirSync(dirname(artifactPath), { recursive: true })
      writeFileSync(artifactPath, CSV)
      failStore.markSucceeded(job.jobId, { totalEvents: 2, bytes: Buffer.byteLength(CSV) })
      const minted = failStore.issueDownloadToken(job.jobId)
      assert.ok(minted)

      const res = await fetch(
        `${failApi.url}/v1/audit/exports/${job.jobId}/download?token=${encodeURIComponent(minted.token)}`
      )
      assert.equal(res.status, 500)
      const body = await res.text()
      assert.equal(errorCode(body), 'EXPORT_AUDIT_UNAVAILABLE')
      assert.notEqual(body, CSV)
      assert.equal(existsSync(artifactPath), true)
    } finally {
      await failApi?.stop()
      rmSync(failDir, { recursive: true, force: true })
    }
  })
})
