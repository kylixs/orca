import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { login, spawnService, type Service } from './harness.ts'

/**
 * U205 F3: with `auditWriterUrls` the sink's `query` is a promise. The worker
 * must await it, so an accepted export still runs to a readable artifact
 * instead of failing as `EXPORT_AUDIT_UNAVAILABLE`.
 */

const INTERNAL_TOKEN = 'u205-internal-token'
const READY_API = /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/
const READY_WRITER = /\[audit-writer\] listening on http:\/\/127\.0\.0\.1:(\d+)/
const POLL_BUDGET_MS = 10_000

let dir = ''
let exportDir = ''
let writer: Service
let api: Service
let adminToken = ''

type StatusBody = {
  status?: string
  totalEvents?: number
  bytes?: number
  error?: { code?: string; message?: string }
}
type AuditPage = { events?: { eventType?: string; metadata?: Record<string, unknown> }[] }

async function status(jobId: string): Promise<StatusBody> {
  const res = await fetch(`${api.url}/v1/audit/exports/${jobId}`, {
    headers: { authorization: `Bearer ${adminToken}` }
  })
  assert.equal(res.status, 200)
  return (await res.json()) as StatusBody
}

async function awaitSucceeded(jobId: string): Promise<StatusBody> {
  const deadline = Date.now() + POLL_BUDGET_MS
  for (;;) {
    const body = await status(jobId)
    if (body.status === 'succeeded') return body
    if (body.status === 'failed') {
      assert.fail(`export failed: ${JSON.stringify(body.error)}`)
    }
    if (Date.now() > deadline) {
      assert.fail(`export ${jobId} did not finish: ${JSON.stringify(body)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** The terminal event travels back through the remote writer's append path. */
async function finishedAuditEvent(jobId: string) {
  const deadline = Date.now() + POLL_BUDGET_MS
  for (;;) {
    const res = await fetch(`${api.url}/v1/audit/events?eventType=audit_export&limit=200`, {
      headers: { authorization: `Bearer ${adminToken}` }
    })
    assert.equal(res.status, 200)
    const page = (await res.json()) as AuditPage
    const found = page.events?.find(
      (event) => event.metadata?.jobId === jobId && event.metadata?.phase === 'finished'
    )
    if (found) return found
    if (Date.now() > deadline) assert.fail(`no finished audit event for ${jobId}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** Logins are appended best-effort; freezing at accept would otherwise export an empty set. */
async function awaitLoginEvents(): Promise<void> {
  const deadline = Date.now() + 5_000
  for (;;) {
    const res = await fetch(`${api.url}/v1/audit/events?eventType=login&limit=10`, {
      headers: { authorization: `Bearer ${adminToken}` }
    })
    assert.equal(res.status, 200)
    const page = (await res.json()) as AuditPage
    if ((page.events?.length ?? 0) > 0) return
    if (Date.now() > deadline) assert.fail('login events never became queryable')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orca-audit-export-remote-'))
  exportDir = join(dir, 'exports')
  writer = await spawnService(
    'apps/audit-writer/src/writer.ts',
    { PORT: '0', INTERNAL_TOKEN, AUDIT_LOG_PATH: join(dir, 'audit.log') },
    READY_WRITER,
    'audit-writer-export'
  )
  api = await spawnService(
    'apps/api/src/server.ts',
    {
      PORT: '0',
      INTERNAL_TOKEN,
      ORCA_CLOUD_AUDIT_WRITER_URL: writer.url,
      ORCA_AUDIT_EXPORT_DIR: exportDir
    },
    READY_API,
    'api-export-remote'
  )
  adminToken = await login(api.url, 'admin', 'Adm1n!')
  await login(api.url, 'zhangsan', 'Passw0rd!')
})

after(async () => {
  await api?.stop()
  await writer?.stop()
  rmSync(dir, { recursive: true, force: true })
})

test('远端写者查询下导出仍 succeeded，产物可读且终态审计入链', async () => {
  await awaitLoginEvents()
  const res = await fetch(`${api.url}/v1/audit/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      confirm: true,
      format: 'jsonl',
      since: new Date(Date.now() - 60 * 60_000).toISOString()
    })
  })
  const accepted = (await res.json()) as { jobId?: string }
  assert.equal(res.status, 202, JSON.stringify(accepted))
  const jobId = accepted.jobId ?? ''

  const body = await awaitSucceeded(jobId)
  assert.ok((body.totalEvents ?? 0) > 0, 'remote query must return the login events')
  assert.ok((body.bytes ?? 0) > 0, 'succeeded export must report bytes')

  const artifact = join(exportDir, jobId, 'events.jsonl')
  assert.ok(existsSync(artifact), `artifact missing: ${artifact}`)
  const seqs = readFileSync(artifact, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => (JSON.parse(line) as { seq: number }).seq)
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'artifact must be chronological')

  const terminal = await finishedAuditEvent(jobId)
  assert.equal(terminal.eventType, 'audit_export')
  assert.equal(terminal.metadata?.phase, 'finished')
  assert.equal(terminal.metadata?.totalEvents, body.totalEvents)
})
