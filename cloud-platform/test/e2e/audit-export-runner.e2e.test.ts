import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnService, type Service } from './harness.ts'

/**
 * U201 E6b: the accept route (E5) schedules the export worker (E6) after the
 * 202, so a real process must turn a queued job into a readable artifact.
 * Status reads (E7) are the observable terminal state.
 */

const READY = /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/
const JOB_ID = /^exp_[0-9a-f]{24}$/
const POLL_BUDGET_MS = 10_000

let api: Service
let exportDir = ''
let adminToken = ''

type ExportBody = { jobId?: string; status?: string; format?: string }
type StatusBody = {
  jobId?: string
  status?: string
  totalEvents?: number
  bytes?: number
  startedAt?: number
  finishedAt?: number
  error?: { code?: string; message?: string }
}
type JsonlEvent = { seq?: number; eventType?: string }

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

async function postExport(body: Record<string, unknown>): Promise<ExportBody> {
  const res = await fetch(`${api.url}/v1/audit/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ confirm: true, format: 'jsonl', ...body })
  })
  const parsed: ExportBody = await res.json()
  assert.equal(res.status, 202, `export not accepted: ${JSON.stringify(parsed)}`)
  assert.match(parsed.jobId ?? '', JOB_ID)
  return parsed
}

async function status(jobId: string): Promise<StatusBody> {
  const res = await fetch(`${api.url}/v1/audit/exports/${jobId}`, {
    headers: { authorization: `Bearer ${adminToken}` }
  })
  assert.equal(res.status, 200)
  return await res.json()
}

/** Polls the status endpoint; the elapsed assertion keeps the budget honest. */
async function awaitSucceeded(jobId: string): Promise<{ body: StatusBody; elapsedMs: number }> {
  const started = Date.now()
  let last: StatusBody = {}
  while (Date.now() - started <= POLL_BUDGET_MS) {
    last = await status(jobId)
    if (last.status === 'succeeded') {
      return { body: last, elapsedMs: Date.now() - started }
    }
    if (last.status === 'failed') {
      assert.fail(`export failed: ${JSON.stringify(last.error)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.fail(`export ${jobId} did not succeed within ${POLL_BUDGET_MS}ms: ${JSON.stringify(last)}`)
}

function readArtifact(jobId: string): string {
  const file = join(exportDir, jobId, 'events.jsonl')
  assert.ok(existsSync(file), `artifact missing: ${file}`)
  return readFileSync(file, 'utf8')
}

before(async () => {
  exportDir = mkdtempSync(join(tmpdir(), 'orca-audit-export-runner-e2e-'))
  api = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', ORCA_AUDIT_EXPORT_DIR: exportDir },
    READY,
    'api'
  )
  assert.equal(api.env.ORCA_AUDIT_EXPORT_DIR, exportDir)
  adminToken = await login('admin', 'Adm1n!', 'runner-admin')
  // A few more audited actions so a non-empty window has real events to export.
  await login('zhangsan', 'Passw0rd!', 'runner-auditor')
  await login('lisi', 'Passw0rd!', 'runner-user')
  const res = await fetch(`${api.url}/v1/audit/events?limit=10`, {
    headers: { authorization: `Bearer ${adminToken}` }
  })
  assert.equal(res.status, 200)
})

after(async () => {
  await api?.stop()
  rmSync(exportDir, { recursive: true, force: true })
})

describe('审计导出执行器（真实平台进程）', () => {
  test('E6b-1 受理后台执行：succeeded、产物逐行可解析且 seq 升序', async () => {
    const since = new Date(Date.now() - 60 * 60_000).toISOString()
    const accepted = await postExport({ since })
    const jobId = accepted.jobId ?? ''

    const { body, elapsedMs } = await awaitSucceeded(jobId)
    assert.ok(elapsedMs <= POLL_BUDGET_MS, `export took ${elapsedMs}ms`)
    assert.equal(body.jobId, jobId)
    assert.ok((body.totalEvents ?? 0) > 0, 'window must contain the login/query events')
    assert.ok((body.bytes ?? 0) > 0, 'succeeded export must report its byte size')
    assert.equal(typeof body.startedAt, 'number')
    assert.equal(typeof body.finishedAt, 'number')

    const lines = readArtifact(jobId)
      .split('\n')
      .filter((line) => line !== '')
    assert.equal(lines.length, body.totalEvents)
    const seqs: number[] = []
    for (const line of lines) {
      const event: JsonlEvent = JSON.parse(line)
      assert.equal(typeof event.seq, 'number', `line is not an audit event: ${line}`)
      assert.equal(typeof event.eventType, 'string')
      seqs.push(event.seq ?? 0)
    }
    const ascending = [...seqs].sort((a, b) => a - b)
    assert.deepEqual(seqs, ascending, 'artifact must be chronological')
  })

  test('E6b-2 空结果集：仍生成空产物并以 succeeded 收尾', async () => {
    // An unknown event type matches nothing but is a valid filter, unlike a
    // future `since` (the route refuses an inverted 31-day window with 400).
    const accepted = await postExport({
      since: new Date(Date.now() - 60 * 60_000).toISOString(),
      eventTypes: ['u201_no_such_event_type']
    })
    const jobId = accepted.jobId ?? ''

    const { body } = await awaitSucceeded(jobId)
    assert.equal(body.totalEvents, 0)
    assert.equal(body.bytes, 0)
    assert.equal(readArtifact(jobId), '')
  })

  // A worker fault must not escape the accepted 202, but every synchronous
  // failure path here ends as `failed` in job.json; forcing one would require
  // corrupting the chain or disk mid-test, so that guard is asserted by code
  // review rather than an e2e fixture.
})
