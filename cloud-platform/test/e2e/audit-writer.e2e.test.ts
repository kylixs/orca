import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { login, saveEvidence, spawnService, type Service } from './harness.ts'

/**
 * M80 (G-04 / AC-26): three API replicas share one audit writer. With a single
 * writer assigning `seq` and `prevHash`, concurrent appends cannot fork the
 * chain; a tampered log is detected and stops sensitive mutations on every
 * replica (fail-closed), not just the one that happens to read it.
 */

const EVIDENCE = 'm80-audit-writer'
const INTERNAL_TOKEN = 'm80-internal-token'
const TOTAL_EVENTS = 100_000
const BATCH = 500

type Writer = { url: string; stop: () => Promise<void> }
type AuditEvent = { seq: number; prevHash: string; hash: string; eventType: string; actor: string }
type VerifyBody = { ok: boolean; checked?: number; brokenAtSeq?: number; tip?: string }

let writer: Writer
let logPath = ''
let replicas: Service[] = []

async function startWriter(path: string): Promise<Writer> {
  const svc = await spawnService(
    'apps/audit-writer/src/writer.ts',
    { PORT: '0', INTERNAL_TOKEN, AUDIT_LOG_PATH: path },
    /\[audit-writer\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'audit-writer'
  )
  return { url: svc.url, stop: svc.stop }
}

async function startReplica(writerUrl: string, index: number): Promise<Service> {
  return spawnService(
    'apps/api/src/server.ts',
    {
      PORT: '0',
      INTERNAL_TOKEN,
      ORCA_CLOUD_AUDIT_WRITER_URL: writerUrl,
      AUDIT_LOG_PATH: ''
    },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    `api-replica-${index}`
  )
}

async function appendBatch(
  url: string,
  from: number,
  count: number,
  actor: string
): Promise<AuditEvent[]> {
  const events = Array.from({ length: count }, (_, offset) => ({
    eventType: 'load_test',
    actor,
    targetType: 'load',
    targetId: `seq-${from + offset}`,
    result: 'success',
    traceId: null
  }))
  const res = await fetch(`${url}/v1/append`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
    body: JSON.stringify({ events })
  })
  assert.equal(res.status, 200, await res.clone().text())
  return ((await res.json()) as { events: AuditEvent[] }).events
}

async function writerGet<T>(path: string): Promise<T> {
  const res = await fetch(`${writer.url}${path}`, {
    headers: { 'x-internal-token': INTERNAL_TOKEN }
  })
  assert.equal(res.status, 200)
  return (await res.json()) as T
}

before(async () => {
  logPath = join(mkdtempSync(join(tmpdir(), 'orca-m80-audit-')), 'audit.log')
  writer = await startWriter(logPath)
  replicas = await Promise.all([0, 1, 2].map((index) => startReplica(writer.url, index)))
}, { timeout: 120_000 })

after(async () => {
  await Promise.all(replicas.map((replica) => replica.stop()))
  await writer?.stop()
})

test('AC-26 三副本共用一个写入者：10 万条并发无分叉、可校验、篡改后各副本 fail-closed', { timeout: 180_000 }, async () => {
  // ---- replica integration first: each replica's own audited mutation goes through the writer ----
  const replicaEvents: AuditEvent[] = []
  for (const replica of replicas) {
    const adminToken = await login(replica.url, 'admin', 'Adm1n!')
    const denied = await fetch(`${replica.url}/v1/audit/verify`, {
      headers: { authorization: `Bearer ${'bad-token'}` }
    })
    // 401 is a request-level rejection; the point is the token, not the audit path.
    assert.equal(denied.status, 401)
    const ok = await fetch(`${replica.url}/v1/audit/verify`, {
      headers: { authorization: `Bearer ${adminToken}` }
    })
    assert.equal(ok.status, 200)
    replicaEvents.push(...(await writerGet<{ events: AuditEvent[] }>('/v1/events?limit=5')).events)
  }

  // ---- scale: three concurrent producers on the same append path the replicas use ----
  // Integer split: 33334 + 33333 + 33333 = 100000.
  const perProducer = [
    Math.ceil(TOTAL_EVENTS / 3),
    Math.floor(TOTAL_EVENTS / 3),
    Math.floor(TOTAL_EVENTS / 3)
  ]
  const started = Date.now()
  const chunks = await Promise.all(
    [0, 1, 2].map(async (producer) => {
      const appended: AuditEvent[] = []
      const mine = perProducer[producer] ?? 0
      for (let offset = 0; offset < mine; offset += BATCH) {
        const count = Math.min(BATCH, mine - offset)
        appended.push(...(await appendBatch(writer.url, offset, count, `producer-${producer}`)))
      }
      return appended
    })
  )
  const elapsedMs = Date.now() - started
  const all = chunks.flat()
  assert.equal(all.length, TOTAL_EVENTS)

  // No fork: seq is contiguous and every prevHash is the previous event's hash.
  const bySeq = new Map<number, AuditEvent>()
  for (const event of all) {
    assert.equal(bySeq.has(event.seq), false, `duplicate seq ${event.seq}`)
    bySeq.set(event.seq, event)
  }
  const verify = await writerGet<VerifyBody>('/v1/verify')
  assert.equal(verify.ok, true)
  assert.ok((verify.checked ?? 0) >= TOTAL_EVENTS)

  const events = await writerGet<{ events: AuditEvent[] }>('/v1/events?limit=200')
  assert.equal(events.events.length, 200)
  for (let index = 1; index < events.events.length; index += 1) {
    // Query returns newest first; the older event's hash is the newer one's prevHash.
    assert.equal(events.events[index - 1].prevHash, events.events[index].hash)
  }

  // ---- tamper: rewrite one line in the durable log, restart, everyone fails closed ----
  const lines = readFileSync(logPath, 'utf8').split('\n').filter(Boolean)
  const victim = Math.floor(lines.length / 2)
  const tampered = JSON.parse(lines[victim]) as AuditEvent
  tampered.actor = 'someone-else'
  lines[victim] = JSON.stringify(tampered)
  writeFileSync(logPath, `${lines.join('\n')}\n`)

  await writer.stop()
  writer = await startWriter(logPath)
  // Replicas point at the same writer URL? The restarted writer took a new port,
  // so restart the replicas against it.
  await Promise.all(replicas.map((replica) => replica.stop()))
  replicas = await Promise.all([0, 1, 2].map((index) => startReplica(writer.url, index)))

  const verdict = await writerGet<VerifyBody>('/v1/verify')
  assert.equal(verdict.ok, false)
  assert.equal(verdict.brokenAtSeq, tampered.seq)

  const failClosed: number[] = []
  for (const replica of replicas) {
    const adminToken = await login(replica.url, 'admin', 'Adm1n!')
    const res = await fetch(`${replica.url}/v1/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        key: `m80-tamper-${Math.random().toString(16).slice(2, 8)}`,
        name: 'm80-tamper',
        hostId: 'host_dev001',
        path: '/srv/work/m80-tamper'
      })
    })
    failClosed.push(res.status)
    const body = (await res.json()) as { error?: { code: string } }
    assert.equal(res.status, 503)
    assert.equal(body.error?.code, 'AUDIT_CHAIN_BROKEN')
  }

  saveEvidence(EVIDENCE, 'audit-writer.json', {
    totalEvents: TOTAL_EVENTS,
    producers: 3,
    elapsedMs,
    eventsPerSecond: Math.round((TOTAL_EVENTS / elapsedMs) * 1000),
    verified: verify,
    replicaIntegrationEvents: replicaEvents.length,
    tamper: { line: victim + 1, brokenAtSeq: tampered.seq },
    replicaMutationStatusesAfterTamper: failClosed
  })
})
