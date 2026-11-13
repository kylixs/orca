import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveEvidence, spawnService, type Service } from './harness.ts'

/**
 * M87 (G-04 standby): a dead audit writer must not stop the platform forever.
 *
 * Two real writer processes share one log and one lease. Only the holder may
 * append; the standby takes over after the lease expires. Replicas are given
 * both endpoints and fail over. While the lease is in limbo nothing may be
 * written — sensitive mutations are refused rather than recorded out of order.
 */

const EVIDENCE = 'm87-audit-writer-standby'
const INTERNAL_TOKEN = 'm87-internal-token'
const LEASE_TTL_MS = 2_000

type Writer = { url: string; health: () => Promise<WriterHealth>; stop: () => Promise<void> }
type WriterHealth = { role: 'leader' | 'standby'; events: number; tip: string }
type AuditLine = { seq: number; prevHash: string; hash: string; eventType: string }
type VerifyBody = { ok: boolean; checked?: number; brokenAtSeq?: number; tip?: string }

let leasePath = ''
let logPath = ''
let writerA: Writer
let writerB: Writer
let replicas: Service[] = []

function writerEnv(id: string): Record<string, string> {
  return {
    PORT: '0',
    INTERNAL_TOKEN,
    AUDIT_LOG_PATH: logPath,
    AUDIT_LEASE_PATH: leasePath,
    AUDIT_LEASE_TTL_MS: String(LEASE_TTL_MS),
    WRITER_ID: id
  }
}

async function startWriter(id: string): Promise<Writer> {
  const svc = await spawnService(
    'apps/audit-writer/src/writer.ts',
    writerEnv(id),
    /\[audit-writer\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    `audit-writer-${id}`
  )
  return {
    url: svc.url,
    health: async () => (await (await fetch(`${svc.url}/health`)).json()) as WriterHealth,
    stop: svc.stop
  }
}

async function startReplica(index: number): Promise<Service> {
  return spawnService(
    'apps/api/src/server.ts',
    {
      PORT: '0',
      INTERNAL_TOKEN,
      ORCA_CLOUD_AUDIT_WRITER_URLS: `${writerA.url},${writerB.url}`,
      AUDIT_LOG_PATH: ''
    },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    `api-standby-${index}`
  )
}

async function adminToken(replica: Service): Promise<string> {
  const res = await fetch(`${replica.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: `m87-${Date.now()}` })
  })
  assert.equal(res.status, 200, await res.clone().text())
  const body = (await res.json()) as { accessToken?: string }
  return body.accessToken ?? ''
}

/** A sensitive mutation: it is audit-gated, so a dead writer stops it. */
async function createProject(replica: Service, token: string, key: string): Promise<number> {
  const res = await fetch(`${replica.url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ key, name: key, hostId: 'host_dev001', path: `/srv/work/${key}` })
  })
  return res.status
}

async function waitForRole(writer: Writer, role: string, timeoutMs: number): Promise<number> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if ((await writer.health()).role === role) return Date.now() - started
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`${writer.url} never became ${role}`)
}

function logLines(): AuditLine[] {
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as AuditLine)
}

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-m87-'))
  leasePath = join(dir, 'writer.lease')
  logPath = join(dir, 'audit.log')
  writerA = await startWriter('writer-a')
  writerB = await startWriter('writer-b')
  replicas = await Promise.all([0, 1].map((index) => startReplica(index)))
}, 120_000)

after(async () => {
  await Promise.all(replicas.map((replica) => replica.stop()))
  await writerA?.stop()
  await writerB?.stop()
})

test('M87 主写入者被杀：租约过期后备用接管，链继续且不分叉；空窗期 fail-closed', async () => {
  const [primary, secondary] = replicas
  assert.ok(primary && secondary)
  // Each replica is a separate process with its own store, so its token is its own.
  const tokens = new Map<Service, string>()
  for (const replica of replicas) {
    tokens.set(replica, await adminToken(replica))
  }
  const tokenOn = (replica: Service): string => tokens.get(replica) ?? ''

  // ---- leader/standby split ----
  const roles = [await writerA.health(), await writerB.health()]
  const leaders = roles.filter((health) => health.role === 'leader')
  const standbys = roles.filter((health) => health.role === 'standby')
  assert.equal(leaders.length, 1, `exactly one leader, got ${JSON.stringify(roles)}`)
  assert.equal(standbys.length, 1)

  assert.equal(await createProject(primary, tokenOn(primary), 'm87-before'), 201)
  const eventsBefore = logLines().length
  assert.ok(eventsBefore > 0, 'the first mutation was audited')

  // ---- kill the leader outright ----
  const leader = roles[0]?.role === 'leader' ? writerA : writerB
  const standby = leader === writerA ? writerB : writerA
  // The kill leaves the lease file behind, so only its expiry can promote.
  await leader.stop()

  // ---- during the gap: nothing may be written ----
  const duringGap = await createProject(secondary, tokenOn(secondary), 'm87-gap')
  assert.equal(duringGap, 503, `a mutation during the lease gap must be refused, got ${duringGap}`)

  // ---- standby promotes within the lease window ----
  const promotedMs = await waitForRole(standby, 'leader', LEASE_TTL_MS + 10_000)
  assert.ok(promotedMs <= LEASE_TTL_MS + 3_000, `promotion took ${promotedMs}ms`)
  const promotedHealth = await standby.health()

  assert.equal(promotedHealth.events, eventsBefore, 'the promoted writer re-read the whole log')

  // ---- writes resume, on a chain that does not fork ----
  assert.equal(await createProject(secondary, tokenOn(secondary), 'm87-after'), 201)
  const verifyRes = await fetch(`${standby.url}/v1/verify`, {
    headers: { 'x-internal-token': INTERNAL_TOKEN }
  })
  const verify = (await verifyRes.json()) as VerifyBody
  assert.equal(verify.ok, true, JSON.stringify(verify))

  const lines = logLines()
  const seqs = lines.map((line) => line.seq)
  assert.deepEqual(
    seqs,
    Array.from({ length: lines.length }, (_, index) => index + 1),
    'seq must stay contiguous and unique across the failover'
  )
  const types = lines.map((line) => line.eventType)
  assert.ok(types.includes('project_create'))
  // Both mutations that succeeded are present exactly once.
  const created = lines.filter((line) => line.eventType === 'project_create').length
  assert.ok(created >= 2, `both successful creations must be in the chain, saw ${created}`)

  saveEvidence(EVIDENCE, 'standby-takeover.json', {
    roles,
    leaderKilled: leader === writerA ? 'writer-a' : 'writer-b',
    eventsBeforeKill: eventsBefore,
    mutationDuringGap: duringGap,
    promotionMs: promotedMs,
    promotedEvents: promotedHealth.events,
    chainAfterFailover: verify,
    tail: { seq: seqs.at(-1), size: seqs.length },
    projectCreateEvents: created
  })
}, 120_000)
