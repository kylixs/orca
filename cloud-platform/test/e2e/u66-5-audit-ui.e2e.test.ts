import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp, type ApiHandle } from '../../apps/api/src/server.ts'
import type { AuditEvent } from '../../apps/api/src/store.ts'
import { saveEvidence } from './harness.ts'
import { loadWebConsolePage } from './web-console-page.ts'

/**
 * U66-5: the audit page query form and result presentation, run as the real
 * web console against a real platform. Covers the combined four-condition
 * query, excerpt-off keyword semantics, denied badges, the 31-day gate, and
 * the non-admin 403 the page must never paper over.
 */

const EVIDENCE = 'u66-5-audit-ui'
const HOUR = 60 * 60_000
const DAY = 24 * HOUR

const now = Date.now()
let app: ApiHandle
let url = ''
let download: AuditEvent
let copyWithExcerpt: AuditEvent

before(async () => {
  app = createApp({ port: 0, now: () => now })
  const port = await app.listen()
  url = `http://127.0.0.1:${port}`

  download = app.audit.append({
    eventType: 'file_download',
    actor: 'alice',
    targetType: 'project',
    targetId: 'proj-alpha',
    result: 'success',
    traceId: 'tr_u66_5_download',
    metadata: {
      fileName: 'payment-report.pdf',
      path: '/srv/payments/reports/payment-report.pdf',
      sizeBytes: 4096,
      hostId: 'host-a',
      captureConfidence: 'host-attested',
      sha256: 'a'.repeat(64)
    }
  })
  copyWithExcerpt = app.audit.append({
    eventType: 'file_copy',
    actor: 'bob',
    targetType: 'project',
    targetId: 'proj-beta',
    result: 'success',
    traceId: 'tr_u66_5_copy',
    metadata: {
      fileName: 'PAYMENT_notes.md',
      path: '/srv/docs/PAYMENT_notes.md',
      copiedChars: 1240,
      copiedBytes: 3720,
      hostId: 'host-b',
      captureConfidence: 'client-declared',
      sha256: 'b'.repeat(64),
      excerpt: 'payment-secret-token'
    }
  })
  app.audit.append({
    eventType: 'download_blocked',
    actor: 'alice',
    targetType: 'project',
    targetId: 'proj-alpha',
    result: 'denied',
    traceId: 'tr_u66_5_blocked',
    metadata: {
      fileName: 'blocked.bin',
      path: '/srv/blocked.bin',
      hostId: 'host-a',
      captureConfidence: 'client-declared',
      policy: 'deny',
      reason: 'DOWNLOAD_DISABLED'
    }
  })
  app.audit.append({
    eventType: 'file_copy',
    actor: 'carol',
    targetType: 'project',
    targetId: 'proj-beta',
    result: 'success',
    traceId: 'tr_u66_5_copy_plain',
    metadata: {
      fileName: 'plain-copy.ts',
      path: '/srv/src/plain-copy.ts',
      copiedChars: 12,
      copiedBytes: 12,
      hostId: 'host-b'
    }
  })
})

after(async () => {
  await app?.close()
})

async function loginAdmin(): Promise<ReturnType<typeof loadWebConsolePage>> {
  const page = loadWebConsolePage(url)
  await page.settle()
  await page.submitLogin('admin', 'Adm1n!')
  await page.clickNav('audit')
  return page
}

function lastAuditQuery(page: ReturnType<typeof loadWebConsolePage>): URLSearchParams {
  const call = page
    .calls()
    .filter((entry) => entry.startsWith('GET /v1/audit/events'))
    .at(-1)
  assert.ok(call, 'the page must query the audit events endpoint')
  return new URL(call, 'https://console.local').searchParams
}

function localInput(ts: number): string {
  const date = new Date(ts)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function setValue(
  page: ReturnType<typeof loadWebConsolePage>,
  selector: string,
  value: string
): void {
  const element = page.window.document.querySelector<HTMLInputElement | HTMLSelectElement>(selector)
  assert.ok(element, `missing ${selector}`)
  element.value = value
}

function click(page: ReturnType<typeof loadWebConsolePage>, selector: string): void {
  const element = page.window.document.querySelector<HTMLElement>(selector)
  assert.ok(element, `missing ${selector}`)
  element.click()
}

test('U66-5-1 四条件组合（时间 + 事件族 + 用户 + 文件名）恰好命中', async () => {
  const page = await loginAdmin()

  setValue(page, '#auditKeyword', 'payment')
  setValue(page, '#auditType', 'family:download')
  setValue(page, '#auditActor', 'alice')
  setValue(page, '#auditFileName', 'report')
  setValue(page, '#auditRange', '168')
  click(page, '#auditApply')
  await page.settle()

  const text = page.text('#content')
  assert.match(text, /payment-report\.pdf/, 'the matching download must be shown')
  assert.doesNotMatch(text, /PAYMENT_notes\.md/, 'a copy by another user must not be shown')
  assert.doesNotMatch(text, /blocked\.bin/, 'the fileName condition must exclude other downloads')

  const query = lastAuditQuery(page)
  assert.equal(query.get('eventFamily'), 'download')
  assert.equal(query.get('username'), 'alice')
  assert.equal(query.get('fileName'), 'report')
  assert.equal(query.get('q'), 'payment')
  assert.ok(query.get('since'), 'the preset range must become an explicit since bound')

  saveEvidence(EVIDENCE, 'combined-query.json', {
    conditions: Object.fromEntries(query),
    downloadSeq: download.seq,
    copySeq: copyWithExcerpt.seq
  })
})

test('U66-5-2 摘录关闭时 q 不匹配正文；复制行展开有则示摘录与指纹', async () => {
  const page = await loginAdmin()

  // The server searches fileName/path/actor/project only while excerpt is off.
  setValue(page, '#auditKeyword', 'payment-secret-token')
  click(page, '#auditApply')
  await page.settle()
  assert.match(page.text('#content'), /没有符合筛选条件的审计事件/)
  assert.doesNotMatch(page.text('#content'), /PAYMENT_notes\.md/)

  // Show the copy family and expand both a with-excerpt and a without-excerpt row.
  click(page, '#auditReset')
  await page.settle()
  setValue(page, '#auditType', 'family:copy')
  click(page, '#auditApply')
  await page.settle()

  click(page, `[data-expand="${copyWithExcerpt.seq}"]`)
  const withExcerpt = page.window.document.querySelector<HTMLElement>(
    `[data-detail="${copyWithExcerpt.seq}"]`
  )
  assert.ok(withExcerpt, 'the copy row must render a detail row')
  assert.equal(withExcerpt.hidden, false, 'expanding must not re-query the page')
  assert.match(withExcerpt.textContent ?? '', /payment-secret-token/)
  assert.match(withExcerpt.textContent ?? '', /sha256:bbbb/)
  assert.match(withExcerpt.textContent ?? '', /1240 字符 \/ 3720 字节/)

  const plainSeq = app.store.audit.find((event) => event.traceId === 'tr_u66_5_copy_plain')?.seq
  assert.ok(plainSeq)
  click(page, `[data-expand="${plainSeq}"]`)
  const plain = page.window.document.querySelector<HTMLElement>(`[data-detail="${plainSeq}"]`)
  assert.match(plain?.textContent ?? '', /未记录内容摘录（仅保留指纹）/)

  saveEvidence(EVIDENCE, 'excerpt-and-q.json', {
    qOnExcerptBody: 'no-match',
    excerptShown: true,
    fingerprintShown: true,
    emptyExcerptShown: true
  })
})

test('U66-5-3 download_blocked 展示拦截与拒绝徽标', async () => {
  const page = await loginAdmin()
  setValue(page, '#auditType', 'download_blocked')
  click(page, '#auditApply')
  await page.settle()

  const text = page.text('#content')
  assert.match(text, /拦截/, 'download_blocked must carry an interception badge')
  assert.match(text, /拒绝/, 'a denied result must render as 拒绝')

  saveEvidence(EVIDENCE, 'denied-badge.json', {
    eventType: 'download_blocked',
    result: 'denied',
    badgeText: '拦截 / 拒绝'
  })
})

test('U66-5-4 时间窗上限 31 天：预设可选，超限在前端拦截且不发请求', async () => {
  const page = await loginAdmin()

  const range = page.window.document.querySelector<HTMLSelectElement>('#auditRange')
  assert.ok(range)
  assert.ok(
    [...range.options].some((option) => option.value === '744'),
    '31-day preset exists'
  )
  assert.match(page.text('#content'), /最大 31 天/)

  setValue(page, '#auditSince', localInput(now - 40 * DAY))
  setValue(page, '#auditUntil', localInput(now))
  const beforeCount = page
    .calls()
    .filter((entry) => entry.startsWith('GET /v1/audit/events')).length
  click(page, '#auditApply')
  await page.settle()

  const error = page.window.document.querySelector<HTMLElement>('#auditError')
  assert.equal(error?.hidden, false, 'the over-limit window must surface an error')
  assert.match(error?.textContent ?? '', /最大 31 天/)
  const afterCount = page.calls().filter((entry) => entry.startsWith('GET /v1/audit/events')).length
  assert.equal(afterCount, beforeCount, 'an invalid window must not reach the API')

  saveEvidence(EVIDENCE, 'time-window.json', {
    preset31Days: true,
    hint: '最大 31 天',
    error: error?.textContent,
    requestsBefore: beforeCount,
    requestsAfter: afterCount
  })
})

test('U66-5-6 31 天预设留缓冲可查询；服务端拒绝可见且不静默', async () => {
  const page = await loginAdmin()

  setValue(page, '#auditRange', '744')
  click(page, '#auditApply')
  await page.settle()

  const query = lastAuditQuery(page)
  const since = Date.parse(query.get('since') ?? '')
  const until = Date.parse(query.get('until') ?? '')
  assert.ok(!Number.isNaN(since) && !Number.isNaN(until), 'the preset must pin both bounds')
  assert.ok(
    until - since <= 31 * DAY - 60_000,
    'the preset window must leave headroom under the API gate'
  )
  assert.equal(page.hidden('#auditError'), true, 'a working preset must not show an error')
  assert.match(page.text('#content'), /已显示 \d+ 条/, 'the preset query must succeed')
  const rowsBefore = page.window.document.querySelectorAll('#content tbody tr').length
  assert.ok(rowsBefore > 0, 'the successful query must render rows')

  // The live API accepts this request, so only a platform rejection can exercise
  // the banner; replay one with the exact server text.
  page.fail('GET', '/v1/audit/events?*', {
    status: 400,
    body: { error: { code: 'TIME_WINDOW_TOO_LARGE', message: '查询时间窗最大 31 天。' } }
  })
  click(page, '#auditApply')
  await page.settle()

  const error = page.window.document.querySelector<HTMLElement>('#auditError')
  assert.equal(error?.hidden, false, 'a server rejection must be visible')
  assert.match(error?.textContent ?? '', /查询时间窗最大 31 天/)
  assert.match(error?.textContent ?? '', /上次查询结果/, 'stale rows must be labelled as such')
  assert.equal(
    page.window.document.querySelectorAll('#content tbody tr').length,
    rowsBefore,
    'the previous rows stay visible'
  )

  page.clearFails()
  click(page, '#auditApply')
  await page.settle()
  assert.equal(page.hidden('#auditError'), true, 'a later success clears the banner')

  saveEvidence(EVIDENCE, 'window-boundary.json', {
    since: query.get('since'),
    until: query.get('until'),
    windowHours: (until - since) / HOUR,
    rowsPreserved: rowsBefore,
    serverErrorVisible: true
  })
})

test('U66-5-7 事件表文件名可复制路径并提示', async () => {
  const page = await loginAdmin()
  const path = '/srv/payments/reports/payment-report.pdf'
  const button = page.window.document.querySelector<HTMLButtonElement>(
    `[data-copy-file="${path}"]`
  )
  assert.ok(button, 'the file cell must offer a copy action')
  assert.equal(button.title, '点击复制路径')
  assert.match(button.textContent ?? '', /payment-report\.pdf/, 'the file name is the click target')
  assert.match(button.textContent ?? '', /复制/, 'the copy label is visible')

  const copies: string[] = []
  Object.defineProperty(page.window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: (value: string) => (copies.push(value), Promise.resolve()) }
  })
  button.click()
  await page.settle()

  assert.deepEqual(copies, [path], 'the copy action writes the recorded path')
  assert.equal(
    page.window.document.querySelector('.toast')?.textContent,
    '已复制',
    'the copy is confirmed in the page'
  )

  saveEvidence(EVIDENCE, 'file-name-copy.json', {
    path,
    label: '复制',
    toast: '已复制'
  })
})

test('U66-5-8 审计首屏失败显示加载失败并可重试恢复', async () => {
  const page = loadWebConsolePage(url)
  await page.settle()
  await page.submitLogin('admin', 'Adm1n!')

  page.fail('GET', '/v1/audit/events?*')
  await page.clickNav('audit')

  const failed = page.text('#content')
  assert.match(failed, /加载失败/, 'a first-load failure must show the error state')
  assert.match(failed, /模拟平台故障/, 'the platform error text must be visible')
  const retry = page.window.document.querySelector<HTMLButtonElement>('#retryContent')
  assert.ok(retry, 'the error state must offer a retry')
  assert.equal(retry.textContent, '重试')

  page.clearFails()
  retry.click()
  await page.settle()

  assert.match(page.text('#content'), /审计日志/, 'retry must recover the audit page')
  assert.match(page.text('#content'), /已显示 \d+ 条/, 'retry renders the real events')
  assert.equal(
    page.window.document.querySelector('#retryContent'),
    null,
    'the error state is replaced by the page'
  )

  saveEvidence(EVIDENCE, 'initial-load-retry.json', {
    failedText: '加载失败',
    errorText: '模拟平台故障',
    retry: '重试',
    recovered: true
  })
})

test('U66-5-9 宿主/入口缺口非零渲染 .note.warn 横幅', async () => {
  const page = await loginAdmin()
  assert.equal(
    page.window.document.querySelector('#auditGapWarning'),
    null,
    'no gap means no banner'
  )

  page.fail('GET', '/v1/audit/status', {
    status: 200,
    body: {
      gaps: { hostsWithGap: 2, droppedTotal: 3, suppressedTotal: 4, rateLimitedTotal: 5 },
      ingressGaps: { droppedTotal: 6, suppressedTotal: 7, rateLimitedTotal: 8 }
    }
  })
  click(page, '#auditApply')
  await page.settle()

  const banner = page.window.document.querySelector<HTMLElement>('#auditGapWarning')
  assert.ok(banner, 'a non-zero gap must render the banner')
  assert.ok(banner.classList.contains('note'), 'the banner uses the note style')
  assert.ok(banner.classList.contains('warn'), 'the banner uses the warn tone')
  assert.match(
    banner.textContent ?? '',
    /审计缺口：2 台主机有缺口；宿主上报 dropped 3 \/ suppressed 4 \/ rateLimited 5；平台入口 dropped 6 \/ suppressed 7 \/ rateLimited 8。/,
    'the banner reports both host and ingress counts'
  )
  assert.match(banner.textContent ?? '', /best-effort/, 'the banner keeps the best-effort caveat')

  saveEvidence(EVIDENCE, 'gap-banner.json', {
    className: banner.className,
    text: banner.textContent
  })
})

test('U66-5-5 非 admin 查询审计事件与缺口状态均为 403', async () => {
  const res = await fetch(`${url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'zhangsan',
      password: 'Passw0rd!',
      deviceName: 'u66-5-dev',
      devicePubKey: Buffer.from('u66-5-dev').toString('base64')
    })
  })
  assert.equal(res.status, 200)
  const token = ((await res.json()) as { accessToken?: string }).accessToken ?? ''
  assert.notEqual(token, '')

  const events = await fetch(`${url}/v1/audit/events?limit=10`, {
    headers: { authorization: `Bearer ${token}` }
  })
  const status = await fetch(`${url}/v1/audit/status`, {
    headers: { authorization: `Bearer ${token}` }
  })
  assert.equal(events.status, 403)
  assert.equal(status.status, 403)

  saveEvidence(EVIDENCE, 'non-admin.json', {
    events: events.status,
    status: status.status
  })
})
