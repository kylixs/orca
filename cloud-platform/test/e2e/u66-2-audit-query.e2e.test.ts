import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp, type ApiHandle } from '../../apps/api/src/server.ts'
import type { AuditEvent } from '../../apps/api/src/store.ts'
import { saveEvidence } from './harness.ts'

/**
 * U66-2: audit query extensions (until/eventTypes/eventFamily/fileName/q),
 * reverse-scan semantics, and the /v1/audit/status gap + capacity summary.
 *
 * Events are appended through the real chain with an injected clock so time
 * bounds and the implicit keyword window are crossed by moving time, not waiting.
 */

const EVIDENCE = 'u66-2-query'
const DAY = 24 * 60 * 60_000
const T0 = 1_800_000_000_000
const NOW = T0 + 10_000

let clock = T0
let app: ApiHandle
let url = ''
let adminToken = ''
let events = new Map<string, AuditEvent>()

type Page = { events: AuditEvent[]; nextCursor: number | null }
type Status = {
  ok: boolean
  persisted: boolean
  chain?: { ok: boolean; lastSeq: number }
  gaps?: {
    hostsWithGap: number
    droppedTotal: number
    suppressedTotal: number
    rateLimitedTotal: number
    lastGapAt: number | null
  }
  capacity?: {
    fileEventsToday: number
    fileEventsTotal: number
    dailyEnvelope: number
    totalEnvelope: number
    overDailyEnvelope: boolean
    overTotalEnvelope: boolean
  }
  eventTypes?: string[]
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

async function login(username: string, password: string, device: string): Promise<string> {
  const res = await fetch(`${url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username,
      password,
      deviceName: device,
      devicePubKey: Buffer.from(`u66-${device}`).toString('base64')
    })
  })
  assert.equal(res.status, 200, await res.clone().text())
  return ((await res.json()) as { accessToken?: string }).accessToken ?? ''
}

function record(
  key: string,
  eventType: string,
  ts: number,
  actor: string,
  targetId: string,
  metadata: Record<string, unknown>
): void {
  clock = ts
  events.set(
    key,
    app.audit.append({
      eventType,
      actor,
      targetType: 'project',
      targetId,
      result: 'success',
      traceId: `trace-${key}`,
      metadata
    })
  )
}

function seqsOf(page: Page): number[] {
  return page.events.map((event) => event.seq)
}

async function query(params: Record<string, string | number | undefined>): Promise<Page> {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value))
  }
  const res = await fetch(`${url}/v1/audit/events?${search.toString()}`, {
    headers: auth(adminToken)
  })
  assert.equal(res.status, 200, await res.clone().text())
  return (await res.json()) as Page
}

async function queryStatus(token: string): Promise<{ status: number; body: Status | { error?: { code?: string } } }> {
  const res = await fetch(`${url}/v1/audit/status`, { headers: auth(token) })
  return { status: res.status, body: (await res.json()) as Status | { error?: { code?: string } } }
}

function iso(ts: number): string {
  return new Date(ts).toISOString()
}

before(async () => {
  clock = T0
  app = createApp({ port: 0, now: () => clock })
  const port = await app.listen()
  url = `http://127.0.0.1:${port}`
  adminToken = await login('admin', 'Adm1n!', 'u66-admin')
  assert.notEqual(adminToken, '')

  // The four-condition corpus: two actors, three file types, distinct names/paths.
  record('e1', 'file_download', T0 - 2 * DAY, 'alice', 'proj-alpha', {
    fileName: 'payment-report.pdf',
    path: '/srv/payment/reports/payment-report.pdf',
    projectKey: 'payments',
    subject: 'user:alice',
    hostId: 'host-a',
    branch: 'secret-branch'
  })
  record('e2', 'file_copy', T0 - 1 * DAY, 'bob', 'proj-beta', {
    fileName: 'PAYMENT_notes.md',
    path: '/srv/docs/PAYMENT_notes.md',
    projectKey: 'docs',
    hostId: 'host-b',
    excerpt: 'payment-secret-token'
  })
  record('e3', 'download_blocked', T0 + 1_000, 'alice', 'proj-alpha', {
    fileName: 'blocked.bin',
    path: '/srv/blocked.bin',
    hostId: 'host-a',
    reason: 'payment'
  })
  record('e4', 'file_download', T0 + 2_000, 'carol', 'proj-alpha', {
    fileName: '2026_payment.csv',
    path: '/srv/2026_payment.csv',
    projectKey: 'payments',
    hostId: 'host-c'
  })
  record('e5', 'file_copy', T0 + 3_000, 'dave', 'proj-beta', {
    fileName: 'a_b.csv',
    path: '/srv/a_b.csv',
    projectKey: 'docs',
    hostId: 'host-b'
  })
  record('e6', 'file_download', T0 + 4_000, 'user:erin', 'proj-gamma', {
    fileName: 'unrelated.txt',
    path: '/srv/unrelated.txt',
    projectKey: 'other',
    subject: 'user:erin',
    hostId: 'host-a'
  })
  record('e7', 'file_download', T0 - 10 * DAY, 'alice', 'proj-alpha', {
    fileName: 'payment-old.txt',
    path: '/srv/payment-old.txt',
    hostId: 'host-a'
  })
  record('e8', 'file_download', T0 + 7_000, 'frank', 'proj-beta', {
    fileName: 'notes.txt',
    path: '/srv/payment/notes.txt',
    projectKey: 'docs',
    hostId: 'host-b'
  })
  record('e9', 'file_download', T0 - 40 * DAY, 'alice', 'proj-alpha', {
    fileName: 'ancient.txt',
    path: '/srv/ancient.txt',
    hostId: 'host-a'
  })
  // Gap reports are counted by /v1/audit/status; zero-only reports are ignored.
  record('g1', 'host.audit_gap', T0 + 5_000, 'host-a', 'host-a', {
    hostId: 'host-a',
    bootId: 'boot-1',
    dropped: 2,
    suppressed: 1,
    rateLimited: 1
  })
  record('g2', 'host.audit_gap', T0 + 6_000, 'host-b', 'host-b', {
    hostId: 'host-b',
    bootId: 'boot-2',
    dropped: 1,
    suppressed: 0,
    rateLimited: 3
  })
  record('g3', 'host.audit_gap', T0 + 6_500, 'host-c', 'host-c', {
    hostId: 'host-c',
    bootId: 'boot-3',
    dropped: 0,
    suppressed: 0,
    rateLimited: 0
  })

  clock = NOW
}, { timeout: 30_000 })

after(async () => {
  await app?.close()
})

function seq(key: string): number {
  const event = events.get(key)
  assert.ok(event, `missing fixture ${key}`)
  return event.seq
}

test('U66-2-1 四条件组合矩阵：since/until + eventTypes + actor + fileName', async () => {
  const base = {
    since: iso(NOW - 3 * DAY),
    until: iso(NOW),
    eventTypes: 'file_download,download_blocked'
  }
  const hits = await query({ ...base, actor: 'alice', fileName: 'blocked' })
  assert.deepEqual(seqsOf(hits), [seq('e3')])

  const wrongActor = await query({ ...base, actor: 'bob', fileName: 'blocked' })
  assert.deepEqual(seqsOf(wrongActor), [])

  const wrongName = await query({ ...base, actor: 'alice', fileName: 'no-such-file' })
  assert.deepEqual(seqsOf(wrongName), [])

  const wrongType = await query({ ...base, actor: 'alice', eventTypes: 'file_copy', fileName: 'blocked' })
  assert.deepEqual(seqsOf(wrongType), [])

  // until is inclusive and drops the event just past it.
  const beforeE3 = await query({ ...base, since: iso(T0), actor: 'alice', until: iso(T0) })
  assert.deepEqual(seqsOf(beforeE3), [])

  // username matches actor and metadata.subject, `user:` prefix stripped.
  const bySubject = await query({ since: iso(T0), until: iso(NOW), username: 'erin' })
  assert.deepEqual(seqsOf(bySubject), [seq('e6')])
  const byActor = await query({ since: iso(T0), until: iso(NOW), username: 'carol' })
  assert.deepEqual(seqsOf(byActor), [seq('e4')])

  saveEvidence(EVIDENCE, 'query-matrix.json', {
    combined: { requested: { ...base, actor: 'alice', fileName: 'blocked' }, hits: seqsOf(hits) },
    negatives: {
      wrongActor: seqsOf(wrongActor),
      wrongName: seqsOf(wrongName),
      wrongType: seqsOf(wrongType),
      untilExclusive: seqsOf(beforeE3)
    },
    username: { subject: seqsOf(bySubject), actor: seqsOf(byActor) }
  })
})

test('U66-2-2 fileName/q：大小写不敏感、白名单、字面量、长度校验', async () => {
  const window = { since: iso(T0 - 3 * DAY), until: iso(NOW) }
  const expectedPayment = [seq('e8'), seq('e4'), seq('e2'), seq('e1')]

  assert.deepEqual(seqsOf(await query({ ...window, q: 'payment' })), expectedPayment)
  assert.deepEqual(seqsOf(await query({ ...window, q: 'PAYMENT' })), expectedPayment)
  assert.deepEqual(seqsOf(await query({ ...window, fileName: 'payment' })), expectedPayment)
  // Chained AND: both conditions must hold.
  assert.deepEqual(seqsOf(await query({ ...window, q: 'payment', fileName: 'notes' })), [seq('e8'), seq('e2')])

  // Whitelist: branch/reason/excerpt are not searched.
  assert.deepEqual(seqsOf(await query({ ...window, q: 'secret-branch' })), [])
  assert.deepEqual(seqsOf(await query({ ...window, q: 'payment-secret-token' })), [])
  // actor and projectKey are searched.
  assert.deepEqual(seqsOf(await query({ ...window, q: 'alice' })), [seq('e3'), seq('e1')])
  assert.deepEqual(seqsOf(await query({ ...window, q: 'payments' })), [seq('e4'), seq('e1')])

  // Regex/glob metacharacters are literal.
  assert.deepEqual(seqsOf(await query({ ...window, q: '%%' })), [])
  assert.deepEqual(seqsOf(await query({ ...window, q: '.*' })), [])
  assert.deepEqual(seqsOf(await query({ ...window, q: 'a_b' })), [seq('e5')])

  // Whitespace-only q is absent; it must not narrow the result.
  assert.deepEqual(seqsOf(await query({ ...window, q: '   ' })), seqsOf(await query(window)))

  const lengths = [
    ['q=a', 'q 至少 2'],
    [`q=${'x'.repeat(129)}`, 'q 最多 128'],
    [`fileName=${'x'.repeat(129)}`, 'fileName 最多 128'],
    [`eventTypes=${'x'.repeat(65)}`, 'eventTypes 最多 64']
  ] as const
  for (const [search, label] of lengths) {
    const res = await fetch(`${url}/v1/audit/events?${search}`, { headers: auth(adminToken) })
    assert.equal(res.status, 400, label)
    const body = (await res.json()) as { error?: { code?: string } }
    assert.equal(body.error?.code, 'INVALID_QUERY', label)
  }
  const tooMany = Array.from({ length: 21 }, (_, index) => `type_${index}`).join(',')
  const many = await fetch(`${url}/v1/audit/events?eventTypes=${tooMany}`, {
    headers: auth(adminToken)
  })
  assert.equal(many.status, 400)
  assert.equal(((await many.json()) as { error?: { code?: string } }).error?.code, 'INVALID_QUERY')

  saveEvidence(EVIDENCE, 'keyword-whitelist.json', {
    paymentHits: expectedPayment,
    nonWhitelisted: { branch: [], excerpt: [], reasonOnly: [] },
    literals: { percent: [], glob: [], underscore: [seq('e5')] },
    validation: lengths.map(([search, label]) => ({ search, label, status: 400 }))
  })
})

test('U66-2-3 eventTypes 多值 OR / eventFamily 快捷 / 显式集合优先', async () => {
  const window = { since: iso(T0 - 3 * DAY), until: iso(NOW) }

  assert.deepEqual(seqsOf(await query({ ...window, eventTypes: 'file_download,file_copy' })), [
    seq('e8'),
    seq('e6'),
    seq('e5'),
    seq('e4'),
    seq('e2'),
    seq('e1')
  ])
  assert.deepEqual(seqsOf(await query({ ...window, eventFamily: 'download' })), [
    seq('e8'),
    seq('e6'),
    seq('e4'),
    seq('e3'),
    seq('e1')
  ])
  assert.deepEqual(seqsOf(await query({ ...window, eventFamily: 'copy' })), [seq('e5'), seq('e2')])

  // Explicit eventTypes wins over both the family and the single eventType.
  assert.deepEqual(seqsOf(await query({ ...window, eventFamily: 'download', eventTypes: 'file_copy' })), [
    seq('e5'),
    seq('e2')
  ])
  assert.deepEqual(
    seqsOf(await query({ ...window, eventType: 'file_copy', eventTypes: 'file_download' })),
    [seq('e8'), seq('e6'), seq('e4'), seq('e1')]
  )
  // No explicit set: the family still replaces the single type.
  assert.deepEqual(
    seqsOf(await query({ ...window, eventType: 'file_download', eventFamily: 'copy' })),
    [seq('e5'), seq('e2')]
  )

  const invalid = await fetch(`${url}/v1/audit/events?eventFamily=terminal`, {
    headers: auth(adminToken)
  })
  assert.equal(invalid.status, 400)
  assert.equal(((await invalid.json()) as { error?: { code?: string } }).error?.code, 'INVALID_QUERY')

  saveEvidence(EVIDENCE, 'event-types-family.json', {
    multi: [seq('e8'), seq('e6'), seq('e5'), seq('e4'), seq('e2'), seq('e1')],
    downloadFamily: [seq('e8'), seq('e6'), seq('e4'), seq('e3'), seq('e1')],
    copyFamily: [seq('e5'), seq('e2')],
    explicitWins: [seq('e5'), seq('e2')]
  })
})

test('U66-2-4 until/since 边界、31 天窗口、关键字隐式 7 天', async () => {
  // Both bounds inclusive.
  const inclusive = await query({
    since: iso(T0 - 2 * DAY),
    until: iso(T0 - 1 * DAY),
    eventTypes: 'file_download,file_copy'
  })
  assert.deepEqual(seqsOf(inclusive), [seq('e2'), seq('e1')])

  // until only: implicit 31-day lower bound excludes the 40-day-old event.
  const untilOnly = await query({ until: iso(T0 - 1 * DAY), eventTypes: 'file_download' })
  assert.deepEqual(seqsOf(untilOnly), [seq('e7'), seq('e1')])

  const invalidUntil = await fetch(`${url}/v1/audit/events?until=not-a-date`, {
    headers: auth(adminToken)
  })
  assert.equal(invalidUntil.status, 400)
  assert.equal(((await invalidUntil.json()) as { error?: { code?: string } }).error?.code, 'INVALID_QUERY')

  // A bad since keeps the old client behavior: silently ignored.
  assert.deepEqual(seqsOf(await query({ since: 'not-a-date', eventTypes: 'file_download' })), [
    seq('e9'),
    seq('e8'),
    seq('e7'),
    seq('e6'),
    seq('e4'),
    seq('e1')
  ])

  for (const params of [
    { since: iso(T0), until: iso(T0 - DAY) },
    { since: iso(T0 - 40 * DAY), until: iso(T0) }
  ]) {
    const res = await fetch(`${url}/v1/audit/events?${new URLSearchParams(params)}`, {
      headers: auth(adminToken)
    })
    assert.equal(res.status, 400)
    assert.equal(
      ((await res.json()) as { error?: { code?: string } }).error?.code,
      'TIME_WINDOW_TOO_LARGE'
    )
  }

  // q/fileName without a window gets the documented implicit seven days (AC-13).
  assert.deepEqual(seqsOf(await query({ q: 'payment-old' })), [])
  assert.deepEqual(seqsOf(await query({ fileName: 'payment-old' })), [])
  assert.deepEqual(seqsOf(await query({ q: 'payment' })), [
    seq('e8'),
    seq('e4'),
    seq('e2'),
    seq('e1')
  ])

  saveEvidence(EVIDENCE, 'time-window.json', {
    inclusive: seqsOf(inclusive),
    untilOnly: seqsOf(untilOnly),
    implicitSevenDays: { old: [], payment: [seq('e8'), seq('e4'), seq('e2'), seq('e1')] },
    rejectedWindowCodes: ['TIME_WINDOW_TOO_LARGE', 'TIME_WINDOW_TOO_LARGE']
  })
})

test('U66-2-5 旧客户端零回归：无新参数时排序、分页、limit 钳制与旧行为一致', async () => {
  const first = await query({ eventType: 'file_download', limit: 2 })
  assert.deepEqual(seqsOf(first), [seq('e9'), seq('e8')])
  assert.equal(first.nextCursor, seq('e8'))
  assert.deepEqual(Object.keys(first).sort(), ['events', 'nextCursor'])

  const second = await query({
    eventType: 'file_download',
    limit: 2,
    cursor: first.nextCursor ?? undefined
  })
  assert.deepEqual(seqsOf(second), [seq('e7'), seq('e6')])
  assert.equal(second.nextCursor, seq('e6'))

  // No since means no lower bound: the 40-day-old event still appears.
  const all = await query({ eventType: 'file_download' })
  assert.deepEqual(seqsOf(all), [seq('e9'), seq('e8'), seq('e7'), seq('e6'), seq('e4'), seq('e1')])
  assert.equal(all.nextCursor, null)

  // Invalid limits keep falling back to the documented page size.
  for (const limit of ['0', '-1', 'abc', '']) {
    const page = await query({ eventType: 'file_download', limit })
    assert.deepEqual(seqsOf(page), seqsOf(all), `limit=${limit}`)
  }

  const byActor = await query({ actor: 'alice' })
  assert.deepEqual(seqsOf(byActor), [seq('e9'), seq('e7'), seq('e3'), seq('e1')])

  saveEvidence(EVIDENCE, 'old-client.json', {
    firstPage: seqsOf(first),
    secondPage: seqsOf(second),
    all: seqsOf(all),
    byActor: seqsOf(byActor),
    responseKeys: Object.keys(first).sort()
  })
})

test('U66-2-6 /v1/audit/status：admin/auditor-only，缺口摘要与容量水位', async () => {
  const devToken = await login('zhangsan', 'Passw0rd!', 'u66-dev')
  assert.notEqual(devToken, '')
  const denied = await queryStatus(devToken)
  assert.equal(denied.status, 403)

  const anonymous = await fetch(`${url}/v1/audit/status`)
  assert.equal(anonymous.status, 401)

  const admin = await queryStatus(adminToken)
  assert.equal(admin.status, 200)
  const body = admin.body as Status
  assert.equal(body.ok, true)
  assert.equal(body.persisted, false)
  assert.equal(body.chain?.ok, true)
  assert.equal(body.chain?.lastSeq, app.store.auditSeq)
  assert.deepEqual(body.gaps, {
    hostsWithGap: 2,
    droppedTotal: 3,
    suppressedTotal: 1,
    rateLimitedTotal: 4,
    lastGapAt: T0 + 6_000
  })
  assert.deepEqual(body.capacity, {
    fileEventsToday: 5,
    fileEventsTotal: 9,
    dailyEnvelope: 5_000,
    totalEnvelope: 1_000_000,
    overDailyEnvelope: false,
    overTotalEnvelope: false
  })

  saveEvidence(EVIDENCE, 'status.json', {
    denied: denied.body,
    anonymousStatus: anonymous.status,
    admin: body
  })
})

test('U78-1 接入类事件可检索：目录自服务端目录派生，q 命中事件类型与脚本路径', { timeout: 30_000 }, async () => {
  // Real access flows mint the events: a denied script fetch, an admin script
  // fetch, admin-only list refusals, and a registration token mint.
  const devToken = await login('zhangsan', 'Passw0rd!', 'u78-dev')
  assert.notEqual(devToken, '')
  const deniedScript = await fetch(`${url}/install/host.sh?token=missing`, {
    headers: auth(devToken)
  })
  assert.equal(deniedScript.status, 403)
  const relayScript = await fetch(`${url}/install/relay.sh`, { headers: auth(adminToken) })
  assert.equal(relayScript.status, 200)
  const hostListDenied = await fetch(`${url}/v1/hosts`, { headers: auth(devToken) })
  assert.equal(hostListDenied.status, 403)
  const relayListDenied = await fetch(`${url}/v1/relays`, { headers: auth(devToken) })
  assert.equal(relayListDenied.status, 403)
  const tokenCreate = await fetch(`${url}/v1/hosts/tokens`, {
    method: 'POST',
    headers: auth(adminToken)
  })
  assert.equal(tokenCreate.status, 201)

  // The console's 操作类型 source: /v1/audit/status carries the catalog.
  const status = await queryStatus(adminToken)
  assert.equal(status.status, 200)
  const catalog = (status.body as Status).eventTypes
  assert.ok(Array.isArray(catalog), 'status must list the authoritative event types')
  const listed = new Set(catalog)
  for (const required of [
    'install_script',
    'relay_list',
    'host_list',
    'host_token_create',
    'host_register',
    'file_download'
  ]) {
    assert.ok(listed.has(required), `catalog must list ${required}`)
  }
  // Anti-drift: everything actually in the chain is listed by the catalog.
  for (const event of app.store.audit) {
    assert.ok(listed.has(event.eventType), `catalog must list chain type ${event.eventType}`)
  }

  // Filtering by the previously-missing type hits both real script events.
  const byType = await query({ eventType: 'install_script' })
  assert.equal(seqsOf(byType).length, 2)
  assert.deepEqual(
    byType.events.map((event) => event.result),
    ['success', 'denied']
  )

  // q now matches the eventType itself.
  const window = { since: iso(NOW - 60_000) }
  const byKeyword = await query({ ...window, q: 'install_script' })
  assert.deepEqual(seqsOf(byKeyword), seqsOf(byType))
  // q matches the endpoint path carried in targetId (denied fetch only).
  const byPath = await query({ ...window, q: '/install/host.sh' })
  assert.equal(seqsOf(byPath).length, 1)
  assert.equal(byPath.events[0]?.result, 'denied')
  // q matches a type that has no metadata text at all.
  assert.equal(seqsOf(await query({ ...window, q: 'host_token_create' })).length, 1)
  // The whitelist holds: refusal reasons still stay out of the keyword scan.
  assert.deepEqual(seqsOf(await query({ ...window, q: 'PERMISSION_DENIED' })), [])

  saveEvidence(EVIDENCE, 'u78-access-events.json', {
    catalogSize: catalog?.length ?? 0,
    catalogCoversChain: true,
    installScriptByType: seqsOf(byType),
    qByEventType: seqsOf(byKeyword),
    qByScriptPath: seqsOf(byPath),
    qWhitelistHolds: { permissionDenied: [] }
  })
})

test('U66-2-7 性能抽测：大链 limit=50 关键字/文件名/四条件查询 P95', { timeout: 120_000 }, async () => {
  clock = NOW
  const bulkStart = T0 + 100_000
  for (let index = 0; index < 20_000; index += 1) {
    clock = bulkStart + index
    app.audit.append({
      eventType: 'file_download',
      actor: `bulk-user-${index % 50}`,
      targetType: 'project',
      targetId: 'proj-bulk',
      result: 'success',
      traceId: `bulk-${index}`,
      metadata: {
        fileName: `bulk-${index}.txt`,
        path: `/srv/bulk/${index}.txt`,
        projectKey: 'bulk',
        hostId: 'host-bulk'
      }
    })
  }
  clock = bulkStart + 20_000
  const since = iso(bulkStart)

  function stats(values: number[]): { p50: number; p95: number; samples: number } {
    const sorted = [...values].sort((a, b) => a - b)
    const at = (percent: number): number => {
      const index = Math.min(sorted.length - 1, Math.ceil((percent / 100) * sorted.length) - 1)
      return Math.round((sorted[Math.max(0, index)] ?? 0) * 100) / 100
    }
    return { p50: at(50), p95: at(95), samples: sorted.length }
  }

  async function sample(params: Record<string, string | number>): Promise<{
    stats: { p50: number; p95: number; samples: number }
    hits: number
  }> {
    const values: number[] = []
    let hits = 0
    for (let index = 0; index < 30; index += 1) {
      const started = performance.now()
      const page = await query(params)
      values.push(performance.now() - started)
      hits = page.events.length
      assert.equal(page.events.length, 50)
    }
    return { stats: stats(values), hits }
  }

  const keyword = await sample({ q: 'bulk-1', since, limit: 50 })
  const byName = await sample({ fileName: 'bulk-1', since, limit: 50 })
  const combined = await sample({
    since,
    until: iso(bulkStart + 20_000),
    eventTypes: 'file_download',
    actor: 'bulk-user-7',
    fileName: 'bulk-',
    limit: 50
  })
  for (const measured of [keyword, byName, combined]) {
    assert.ok(measured.stats.p95 <= 2_000, JSON.stringify(measured.stats))
  }

  saveEvidence(EVIDENCE, 'performance.json', {
    corpus: { bulk: 20_000, total: app.store.auditSeq },
    budgetMs: 2_000,
    keyword,
    fileName: byName,
    combined,
    platform: process.platform,
    node: process.version
  })
})
