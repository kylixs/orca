import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { login, saveEvidence, spawnService, startTcpDelayHop, type Service, type TcpDelayHop } from './harness.ts'

/**
 * M105 (requirements §5.1): an audit query over a 31-day window answers in
 * P95 ≤ 2s. Real writer process, real API process, real HTTP hops — the query
 * the auditor actually runs, over the corpus the window holds, not over a
 * handful of rows.
 *
 * The corpus is grown in place (50k → 200k) so the recorded numbers show what
 * the cost does with size, and a delayed hop proves the budget moves.
 */

const EVIDENCE = 'm105-audit-query-latency'
const INTERNAL_TOKEN = 'm105-internal-token'
const BUDGET_MS = 2_000
const SAMPLES = 30
const CONTROL_SAMPLES = 3
const INJECTED_DELAY_MS = 2_200
const BATCH = 1_000
const FIRST_MILESTONE = 50_000
const FINAL_CORPUS = 200_000
const DAY_MS = 24 * 60 * 60_000

type Stats = { samples: number; p50: number; p95: number; min: number; max: number }
type Page = { events: { seq: number; ts: number; eventType: string }[]; nextCursor: number | null }

let writer: Service
let api: Service
let hop: TcpDelayHop
let adminToken = ''
let appended = 0

function statsOf(values: number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (percent: number): number => {
    const index = Math.min(sorted.length - 1, Math.ceil((percent / 100) * sorted.length) - 1)
    return Math.round((sorted[Math.max(0, index)] ?? 0) * 100) / 100
  }
  return {
    samples: sorted.length,
    p50: at(50),
    p95: at(95),
    min: Math.round((sorted[0] ?? 0) * 100) / 100,
    max: Math.round((sorted.at(-1) ?? 0) * 100) / 100
  }
}

/** The acceptance check; the delayed run must make this throw. */
function assertQueryBudget(stats: Stats, budget: number): void {
  if (stats.p95 > budget) {
    throw new Error(`audit query P95 ${stats.p95}ms over budget ${budget}ms`)
  }
}

async function appendCorpus(target: number): Promise<void> {
  while (appended < target) {
    const count = Math.min(BATCH, target - appended)
    const events = Array.from({ length: count }, (_, offset) => ({
      eventType: offset % 4 === 0 ? 'project_connect' : offset % 4 === 1 ? 'file_read' : offset % 4 === 2 ? 'terminal_open' : 'path_denied',
      actor: `user-${(appended + offset) % 50}`,
      targetType: 'project',
      targetId: `proj-${(appended + offset) % 200}`,
      result: offset % 10 === 0 ? 'denied' : 'success',
      traceId: `trace-${appended + offset}`
    }))
    const res = await fetch(`${writer.url}/v1/append`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
      body: JSON.stringify({ events })
    })
    assert.equal(res.status, 200, await res.clone().text())
    appended += count
  }
}

function windowQuery(limit = 50): string {
  const since = new Date(Date.now() - 30 * DAY_MS).toISOString()
  return `since=${encodeURIComponent(since)}&limit=${limit}`
}

async function queryPage(limit = 50): Promise<{ page: Page; elapsed: number }> {
  const started = performance.now()
  const res = await fetch(`${api.url}/v1/audit/events?${windowQuery(limit)}`, {
    headers: { authorization: `Bearer ${adminToken}` }
  })
  const elapsed = performance.now() - started
  assert.equal(res.status, 200, await res.clone().text())
  return { page: (await res.json()) as Page, elapsed }
}

async function sample(count: number): Promise<Stats> {
  const values: number[] = []
  for (let index = 0; index < count; index += 1) {
    const { page, elapsed } = await queryPage()
    // A query that answers fast with the wrong page is not a passing query.
    assert.equal(page.events.length, 50)
    assert.ok(page.nextCursor !== null, 'a full page must offer a cursor')
    values.push(elapsed)
  }
  return statsOf(values)
}

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-m105-audit-'))
  writer = await spawnService(
    'apps/audit-writer/src/writer.ts',
    { PORT: '0', INTERNAL_TOKEN, AUDIT_LOG_PATH: join(dir, 'audit.log') },
    /\[audit-writer\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'audit-writer-m105'
  )
  // The API reaches the writer through a hop, so the control delays the real
  // query path rather than a simulated one.
  hop = await startTcpDelayHop(writer.port)
  api = await spawnService(
    'apps/api/src/server.ts',
    {
      PORT: '0',
      INTERNAL_TOKEN,
      ORCA_CLOUD_AUDIT_WRITER_URL: hop.url,
      AUDIT_LOG_PATH: ''
    },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-m105'
  )
  adminToken = await login(api.url, 'admin', 'Adm1n!')
}, 180_000)

after(async () => {
  await api?.stop()
  await hop?.close()
  await writer?.stop()
})

test('M105-1 31 天窗口审计查询 P95 ≤ 2s；注入 2.2s 延迟时同一断言转红', async () => {
  await appendCorpus(FIRST_MILESTONE)
  const small = await sample(SAMPLES)
  assertQueryBudget(small, BUDGET_MS)

  await appendCorpus(FINAL_CORPUS)
  const large = await sample(SAMPLES)
  assertQueryBudget(large, BUDGET_MS)

  // The window is real: the page is the newest events in it, and the chain that
  // holds them still verifies end to end.
  const { page } = await queryPage(5)
  const newest = page.events[0]
  assert.ok(newest !== undefined && newest.seq > FINAL_CORPUS - 10, JSON.stringify(page.events))
  const verifyRes = await fetch(`${writer.url}/v1/verify?limit=1`, {
    headers: { 'x-internal-token': INTERNAL_TOKEN }
  })
  const verify = (await verifyRes.json()) as { ok: boolean; checked: number }
  assert.equal(verify.ok, true)
  assert.ok(verify.checked >= FINAL_CORPUS)

  // Negative control: the same query, same budget check, a path that is 2.2s slower.
  hop.setDelayMs(INJECTED_DELAY_MS)
  const injected = await sample(CONTROL_SAMPLES)
  assert.throws(() => assertQueryBudget(injected, BUDGET_MS), /over budget/)

  hop.setDelayMs(0)
  const restored = await sample(CONTROL_SAMPLES)
  assertQueryBudget(restored, BUDGET_MS)

  saveEvidence(EVIDENCE, 'audit-query-latency.json', {
    budgetMs: BUDGET_MS,
    windowDays: 30,
    corpus: { first: FIRST_MILESTONE, final: FINAL_CORPUS, appended },
    first: small,
    final: large,
    injected: { delayMs: INJECTED_DELAY_MS, ...injected },
    restored,
    chainVerified: verify.ok,
    chainChecked: verify.checked,
    newestSeq: newest?.seq ?? null,
    platform: process.platform,
    node: process.version
  })
}, 300_000)
