import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnService, type Service } from './harness.ts'

/**
 * U207 F20: one export through the whole real pipeline — accept, worker, status,
 * download, delete — instead of pre-seeded job.json fixtures.
 */

const READY = /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/
const JOB_ID = /^exp_[0-9a-f]{24}$/
const POLL_BUDGET_MS = 10_000
const DELETE_BUDGET_MS = 5_000

let api: Service
let exportDir = ''
let adminToken = ''

/** Shared by the filter, chain and token tests: one export, several reads. */
let sharedJobId = ''
let sharedFirstToken = ''
let sharedTotalEvents = 0

type JsonObject = Record<string, unknown>
type ExportBody = { jobId?: string }
type StatusBody = {
  jobId?: string
  status?: string
  format?: string
  totalEvents?: number
  bytes?: number
  downloadUrl?: string
  downloaded?: boolean
  downloadUnavailableReason?: string
  error?: { code?: string; message?: string }
}
type JsonlEvent = { seq?: number; eventType?: string; result?: string }
type WireResponse = { status: number; headers: Headers; body: string }

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

async function postExport(body: JsonObject): Promise<WireResponse> {
  const res = await fetch(`${api.url}/v1/audit/export`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ confirm: true, format: 'jsonl', ...body })
  })
  return { status: res.status, headers: res.headers, body: await res.text() }
}

async function acceptExport(body: JsonObject): Promise<ExportBody> {
  const res = await postExport(body)
  const parsed = JSON.parse(res.body) as ExportBody
  assert.equal(res.status, 202, `export not accepted: ${res.body}`)
  assert.equal(res.headers.get('cache-control'), 'no-store')
  assert.match(parsed.jobId ?? '', JOB_ID)
  return parsed
}

async function getStatus(jobId: string): Promise<WireResponse> {
  const res = await fetch(`${api.url}/v1/audit/exports/${jobId}`, {
    headers: { authorization: `Bearer ${adminToken}` }
  })
  return { status: res.status, headers: res.headers, body: await res.text() }
}

function statusBody(response: WireResponse): StatusBody {
  assert.equal(response.status, 200, `status failed: ${response.body}`)
  return JSON.parse(response.body) as StatusBody
}

async function download(jobId: string, token: string): Promise<WireResponse> {
  const res = await fetch(
    `${api.url}/v1/audit/exports/${jobId}/download?token=${encodeURIComponent(token)}`
  )
  return { status: res.status, headers: res.headers, body: await res.text() }
}

function tokenFromUrl(downloadUrl: string | undefined): string {
  assert.ok(downloadUrl, 'status must return a downloadUrl')
  const token = new URL(downloadUrl, 'http://localhost').searchParams.get('token')
  assert.ok(token, 'downloadUrl must carry a token')
  return token
}

async function statusToken(jobId: string): Promise<string> {
  return tokenFromUrl(statusBody(await getStatus(jobId)).downloadUrl)
}

async function awaitSucceeded(jobId: string): Promise<{ body: StatusBody; elapsedMs: number }> {
  const started = Date.now()
  let last = ''
  while (Date.now() - started <= POLL_BUDGET_MS) {
    const response = await getStatus(jobId)
    last = response.body
    assert.equal(response.status, 200, `status failed: ${last}`)
    const body = JSON.parse(last) as StatusBody
    if (body.status === 'succeeded') {
      return { body, elapsedMs: Date.now() - started }
    }
    if (body.status === 'failed') {
      assert.fail(`export failed: ${last}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.fail(`export ${jobId} did not succeed within ${POLL_BUDGET_MS}ms: ${last}`)
}

function artifactPath(jobId: string): string {
  return join(exportDir, jobId, 'events.jsonl')
}

function readArtifact(jobId: string): string {
  const file = artifactPath(jobId)
  assert.ok(existsSync(file), `artifact missing: ${file}`)
  return readFileSync(file, 'utf8')
}

async function auditEvents(query: string): Promise<JsonObject[]> {
  const res = await fetch(`${api.url}/v1/audit/events?${query}`, {
    headers: { authorization: `Bearer ${adminToken}` }
  })
  const body = await res.text()
  assert.equal(res.status, 200, `audit query failed: ${body}`)
  return (JSON.parse(body) as { events?: JsonObject[] }).events ?? []
}

function metadata(event: JsonObject): JsonObject {
  const value = event.metadata
  return typeof value === 'object' && value !== null ? (value as JsonObject) : {}
}

async function waitForDeletion(file: string): Promise<void> {
  const deadline = Date.now() + DELETE_BUDGET_MS
  while (Date.now() < deadline) {
    if (!existsSync(file)) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.fail(`artifact was not deleted: ${file}`)
}

before(async () => {
  exportDir = mkdtempSync(join(tmpdir(), 'orca-audit-export-fullchain-e2e-'))
  api = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', ORCA_AUDIT_EXPORT_DIR: exportDir },
    READY,
    'api'
  )
  assert.equal(api.env.ORCA_AUDIT_EXPORT_DIR, exportDir)
  adminToken = await login('admin', 'Adm1n!', 'fullchain-admin')
  // Two more successful logins plus one audit query give the filter a mixed chain.
  await login('zhangsan', 'Passw0rd!', 'fullchain-auditor')
  await login('lisi', 'Passw0rd!', 'fullchain-user')
  const query = await fetch(`${api.url}/v1/audit/events?limit=10`, {
    headers: { authorization: `Bearer ${adminToken}` }
  })
  assert.equal(query.status, 200)
})

after(async () => {
  await api?.stop()
  rmSync(exportDir, { recursive: true, force: true })
})

describe('审计导出真实全链路（真实平台进程）', () => {
  test('F20-1 过滤生效：jsonl 只含 login 事件，条数=totalEvents，seq 升序', async () => {
    const since = new Date(Date.now() - 60 * 60_000).toISOString()
    const accepted = await acceptExport({ eventType: 'login', since })
    sharedJobId = accepted.jobId ?? ''

    const { body, elapsedMs } = await awaitSucceeded(sharedJobId)
    assert.ok(elapsedMs <= POLL_BUDGET_MS, `export took ${elapsedMs}ms`)
    assert.equal(body.jobId, sharedJobId)
    assert.equal(body.format, 'jsonl')
    assert.ok((body.totalEvents ?? 0) > 0, 'window must contain the login events')
    assert.ok((body.bytes ?? 0) > 0, 'succeeded export must report its byte size')
    sharedTotalEvents = body.totalEvents ?? 0

    const statusResponse = await getStatus(sharedJobId)
    assert.equal(statusResponse.headers.get('cache-control'), 'no-store')
    sharedFirstToken = tokenFromUrl(statusBody(statusResponse).downloadUrl)

    const downloaded = await download(sharedJobId, sharedFirstToken)
    assert.equal(downloaded.status, 200, `download failed: ${downloaded.body}`)
    assert.equal(downloaded.headers.get('cache-control'), 'no-store')
    assert.equal(downloaded.headers.get('content-type'), 'application/x-ndjson; charset=utf-8')
    assert.equal(downloaded.body, readArtifact(sharedJobId))

    const lines = downloaded.body.split('\n').filter((line) => line !== '')
    assert.equal(lines.length, body.totalEvents, 'every exported event must be on disk')
    // before() emitted exactly three successful logins; the audit query must not match.
    assert.equal(lines.length, 3)
    const seqs: number[] = []
    for (const line of lines) {
      const event: JsonlEvent = JSON.parse(line)
      assert.equal(typeof event.seq, 'number', `line is not an audit event: ${line}`)
      assert.equal(event.eventType, 'login', `filter leaked a non-login event: ${line}`)
      assert.equal(event.result, 'success')
      seqs.push(event.seq ?? 0)
    }
    const ascending = [...seqs].sort((a, b) => a - b)
    assert.deepEqual(seqs, ascending, 'artifact must be chronological')
    assert.equal(new Set(seqs).size, seqs.length, 'seqs must be unique')
  })

  test('F20-2 审计链完整性：accepted + finished，metadata 无 token，链校验 ok', async () => {
    assert.ok(sharedJobId, 'F20-1 must run first')
    const events = await auditEvents('eventType=audit_export&limit=200')
    const accepted = events.find(
      (event) => metadata(event).jobId === sharedJobId && metadata(event).phase === 'accepted'
    )
    const finished = events.find(
      (event) => metadata(event).jobId === sharedJobId && metadata(event).phase === 'finished'
    )
    assert.ok(accepted, `no accepted audit event for ${sharedJobId}`)
    assert.ok(finished, `no finished audit event for ${sharedJobId}`)
    assert.equal(accepted.eventType, 'audit_export')
    assert.equal(accepted.result, 'success')
    assert.equal(finished.result, 'success')
    assert.equal(metadata(finished).format, 'jsonl')
    assert.equal(metadata(finished).totalEvents, sharedTotalEvents)
    assert.equal(typeof metadata(finished).bytes, 'number')
    assert.equal(metadata(finished).deleteAfterDownload, undefined)

    for (const event of [accepted, finished]) {
      const serialized = JSON.stringify(event)
      assert.equal(serialized.includes('token'), false, `audit event leaked a token: ${serialized}`)
      assert.equal(serialized.includes(sharedFirstToken), false)
    }

    const verify = await fetch(`${api.url}/v1/audit/verify`, {
      headers: { authorization: `Bearer ${adminToken}` }
    })
    const verdict = (await verify.json()) as { ok?: boolean; checked?: number }
    assert.equal(verify.status, 200, `chain verify failed: ${JSON.stringify(verdict)}`)
    assert.equal(verdict.ok, true)
    assert.ok((verdict.checked ?? 0) > 0)
  })

  test('F20-3 token 语义：状态轮换新 URL 可下载，旧 token 再用 404，产物保留', async () => {
    assert.ok(sharedJobId && sharedFirstToken, 'F20-1 must run first')
    const secondToken = await statusToken(sharedJobId)
    assert.notEqual(secondToken, sharedFirstToken, 'every status read must rotate the token')

    const fresh = await download(sharedJobId, secondToken)
    assert.equal(fresh.status, 200, `rotated download failed: ${fresh.body}`)
    assert.equal(fresh.body, readArtifact(sharedJobId))

    const stale = await download(sharedJobId, sharedFirstToken)
    assert.equal(stale.status, 404, `redeemed token must not work: ${stale.body}`)
    assert.equal(stale.headers.get('cache-control'), 'no-store')
    assert.equal(
      (JSON.parse(stale.body) as { error?: { code?: string } }).error?.code,
      'EXPORT_NOT_FOUND'
    )

    // deleteAfterDownload was not requested, so the artifact stays and status
    // keeps rotating links instead of reporting a deletion.
    assert.equal(existsSync(artifactPath(sharedJobId)), true)
    const after = statusBody(await getStatus(sharedJobId))
    assert.equal(after.downloaded, undefined)
    assert.equal(after.downloadUnavailableReason, undefined)
    assert.ok(after.downloadUrl)
  })

  test('F20-4 删除语义：deleteAfterDownload 下载后产物删除、状态报告 downloaded', async () => {
    assert.equal(api.env.ORCA_AUDIT_EXPORT_DIR, exportDir)
    const since = new Date(Date.now() - 60 * 60_000).toISOString()
    const accepted = await acceptExport({
      eventType: 'login',
      since,
      deleteAfterDownload: true
    })
    const jobId = accepted.jobId ?? ''

    const { body } = await awaitSucceeded(jobId)
    assert.equal(body.totalEvents, 3)

    const token = await statusToken(jobId)
    const downloaded = await download(jobId, token)
    assert.equal(downloaded.status, 200, `download failed: ${downloaded.body}`)

    await waitForDeletion(artifactPath(jobId))
    assert.equal(existsSync(join(exportDir, jobId, 'job.json')), true)

    const afterResponse = await getStatus(jobId)
    assert.equal(afterResponse.headers.get('cache-control'), 'no-store')
    const after = statusBody(afterResponse)
    assert.equal(after.downloaded, true)
    assert.equal(after.downloadUnavailableReason, 'deleted_after_download')
    assert.equal(after.downloadUrl, undefined)
  })
})
