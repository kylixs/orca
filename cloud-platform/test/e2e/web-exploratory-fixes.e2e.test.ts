import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { login, registerHost, saveEvidence, spawnService, type Service } from './harness.ts'
import { loadWebConsolePage, type WebConsolePage } from './web-console-page.ts'

/**
 * M116 exploratory QA round 1 (P1 batch): one regression per finding, driven
 * through the real console files against a real platform process.
 *
 * QA-002 audit shows a bounded page with a load-older control · QA-003 filter
 * controls keep their conditions · QA-004 full copyable traceId · QA-005 host
 * status derived from the heartbeat · QA-006 revoked hosts are labelled and
 * locked · QA-007 every offline open entry is disabled · QA-008 maintenance is
 * shown with its reason · QA-009 a failed policy save reports and rolls back ·
 * QA-010 an ungranted admin's permission column says so · QA-011 a failed load
 * shows an error state with retry · QA-012 empty login fields never reach the
 * platform.
 */

const EVIDENCE = 'w116-fixes'
const MAINTENANCE_REASON = '数据库主从切换'

let service: Service
let liveHostId = ''
let liveProjectId = ''
let beat: ReturnType<typeof setInterval> | undefined
const summary: Record<string, string> = {}

function record(qa: string, detail: string): void {
  summary[qa] = detail
}

async function adminApi(
  path: string,
  init: RequestInit & { token?: string } = {}
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${service.url}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${init.token ?? adminToken}`,
      ...(init.headers ?? {})
    },
    body: init.body
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

let adminToken = ''

before(async () => {
  service = await spawnService(
    'apps/api/src/server.ts',
    // A short window: the seeded host stops beating once the test starts, so the
    // console has to derive liveness instead of trusting the stored status.
    { PORT: '0', INTERNAL_TOKEN: 'w116-internal-token', ORCA_CLOUD_HOST_OFFLINE_MS: '1500' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-web-qa-fixes'
  )
  adminToken = await login(service.url, 'admin', 'Adm1n!')

  // A second host that keeps beating: it stays online for the whole run, which is
  // what the QA-010 case needs (an openable project the admin was never granted).
  const host = await registerHost({
    apiUrl: service.url,
    adminToken,
    name: 'dev-live',
    directAddr: '127.0.0.1:16997',
    relayTarget: '127.0.0.1:16997'
  })
  liveHostId = host.hostId
  beat = setInterval(() => {
    void fetch(`${service.url}/v1/hosts/${liveHostId}/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${host.credential}` },
      body: JSON.stringify({ status: 'online' })
    }).catch(() => undefined)
  }, 400)

  const created = await adminApi('/v1/projects', {
    method: 'POST',
    body: JSON.stringify({
      key: 'order-service',
      name: 'order-service',
      hostId: liveHostId,
      path: '/srv/work/order-service'
    })
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  liveProjectId = (created.body as { id: string }).id
}, 120_000)

after(async () => {
  if (beat) clearInterval(beat)
  await service?.stop()
  saveEvidence(EVIDENCE, 'f2-summary.json', {
    qa: 'M116 exploratory QA round 1 (P1 batch)',
    regressions: summary
  })
})

/** The `tr` for the named project/host row in the main content table. */
function rowFor(page: WebConsolePage, name: string): HTMLElement {
  const row = [...page.window.document.querySelectorAll<HTMLElement>('#content tbody tr')].find(
    (candidate) => candidate.textContent?.includes(name)
  )
  assert.ok(row, `a row for ${name} must be rendered`)
  return row
}

function openButtons(page: WebConsolePage): HTMLButtonElement[] {
  return [...page.window.document.querySelectorAll<HTMLButtonElement>('#content [data-open]')]
}

test('M116-QA-012 空登录不发起请求、不计失败', async () => {
  const page = loadWebConsolePage(service.url)
  await page.settle()
  await page.submitLogin('', '')
  assert.equal(page.hidden('#view-app'), true, 'an empty submit must not enter the app')
  assert.equal(page.text('#loginError'), '请输入域账号和密码。')
  assert.equal(
    page.window.document
      .querySelector<HTMLInputElement>('#username')!
      .classList.contains('invalid'),
    true,
    'the empty account field must be marked'
  )
  assert.equal(
    page.calls().some((call) => call === 'POST /v1/auth/login'),
    false,
    'the login endpoint must not be called'
  )
  record('QA-012', 'empty submit shows 请输入域账号和密码，未发出 POST /v1/auth/login')
}, 120_000)

test('M116-QA-011 加载失败显示错误态并可重试', async () => {
  const page = loadWebConsolePage(service.url)
  await page.settle()
  await page.submitLogin('admin', 'Adm1n!')

  page.fail('GET', '/v1/relays')
  await page.clickNav('relays')
  assert.match(page.text('#content'), /加载失败/)
  assert.match(page.text('#content'), /模拟平台故障/, 'the error state must say what failed')
  const retry = page.window.document.querySelector<HTMLButtonElement>('#retryContent')
  assert.ok(retry, 'the error state must offer a retry')

  page.clearFails()
  retry!.click()
  await page.settle()
  assert.doesNotMatch(page.text('#content'), /加载失败/)
  assert.match(page.text('#content'), /中继/, 'retry must re-render the route')
  record('QA-011', 'GET /v1/relays 失败 → 加载失败 + 重试按钮，恢复后重试渲染中继页')
}, 120_000)

test('M116-QA-005 主机状态按心跳推导：静默主机不再显示在线', async () => {
  // The payload still carries the stale reported status; the console must not.
  const payload = await adminApi('/v1/hosts')
  const seeded = payload.body.hosts.find((h: { name: string }) => h.name === 'dev-001')
  assert.equal(seeded.status, 'online', 'precondition: the host last reported online')
  assert.equal(seeded.online, false, 'precondition: the heartbeat window has lapsed')

  const page = loadWebConsolePage(service.url)
  await page.settle()
  await page.submitLogin('admin', 'Adm1n!')
  await page.clickNav('hosts')
  const row = rowFor(page, 'dev-001')
  assert.match(row.textContent ?? '', /离线/)
  assert.doesNotMatch(row.textContent ?? '', /在线/, 'a silent host must not read as online')
  record('QA-005', 'dev-001 status=online 而 online=false → 主机页显示 离线')
}, 120_000)

test('M116-QA-008 维护中的主机在项目列表显示维护原因', async () => {
  const set = await adminApi('/v1/hosts/host_dev001/maintenance', {
    method: 'POST',
    body: JSON.stringify({ enabled: true, reason: MAINTENANCE_REASON })
  })
  assert.equal(set.status, 200)

  const page = loadWebConsolePage(service.url)
  await page.settle()
  await page.submitLogin('admin', 'Adm1n!')
  await page.clickNav('workbench')
  const row = rowFor(page, 'payment-service')
  assert.match(row.textContent ?? '', new RegExp(`维护中 · ${MAINTENANCE_REASON}`))
  const open = row.querySelector<HTMLButtonElement>('[data-open]')
  assert.equal(open?.disabled, true, 'a project under maintenance cannot be opened')
  assert.match(open?.title ?? '', /维护/)
  record('QA-008', `工作台项目行显示 维护中 · ${MAINTENANCE_REASON}，打开禁用`)
}, 120_000)

test('M116-QA-007 离线项目的三个打开入口全部禁用并带原因', async () => {
  // Ending maintenance writes the stored status back to online while the
  // heartbeat stays silent: exactly the state the old UI mislabelled as live.
  const ended = await adminApi('/v1/hosts/host_dev001/maintenance', {
    method: 'POST',
    body: JSON.stringify({ enabled: false })
  })
  assert.equal(ended.status, 200)

  const page = loadWebConsolePage(service.url)
  await page.settle()
  await page.submitLogin('admin', 'Adm1n!')
  await page.clickNav('workbench')

  // Card entry (最近项目) and table entry (全部项目) on the workbench.
  const card = openButtons(page).find((btn) =>
    btn.closest('.project-card')?.textContent?.includes('payment-service')
  )
  assert.ok(card, 'the recent-project card must render an open button')
  assert.equal(card.disabled, true, 'the card entry must be disabled')
  assert.match(card.title, /主机离线/)
  const row = rowFor(page, 'payment-service')
  assert.match(row.textContent ?? '', /主机离线/)
  const rowOpen = row.querySelector<HTMLButtonElement>('[data-open]')
  assert.equal(rowOpen?.disabled, true, 'the workbench row entry must be disabled')
  assert.match(rowOpen?.title ?? '', /主机离线/)

  // 我的项目 entry.
  await page.clickNav('projects')
  const projectsOpen = rowFor(page, 'payment-service').querySelector<HTMLButtonElement>(
    '[data-open]'
  )
  assert.equal(projectsOpen?.disabled, true, 'the projects page entry must be disabled')
  assert.match(projectsOpen?.title ?? '', /主机离线/)
  record('QA-007', '工作台卡片 + 工作台行 + 我的项目行 的打开按钮均禁用，title=主机离线')
}, 120_000)

test('M116-QA-010 无授权管理员的权限列如实展示，打开需先授权', async () => {
  const page = loadWebConsolePage(service.url)
  await page.settle()
  await page.submitLogin('admin', 'Adm1n!')
  await page.clickNav('workbench')

  const row = rowFor(page, 'order-service')
  assert.match(row.textContent ?? '', /管理员可见（未授权）/, 'the column must not read as empty')
  const open = row.querySelector<HTMLButtonElement>('[data-open]')
  assert.equal(open?.disabled, true, 'an ungranted admin cannot open the project')
  assert.match(open?.title ?? '', /未授权/)

  // Granting the admin's own group re-enables the entry: the gate is the grant.
  const granted = await adminApi(`/v1/projects/${liveProjectId}/grants`, {
    method: 'PUT',
    body: JSON.stringify({
      subjectType: 'group',
      subjectId: 'platform-admins',
      permissions: ['open', 'terminal', 'agent', 'file:read', 'file:write']
    })
  })
  assert.equal(granted.status, 200)

  await page.clickNav('workbench')
  const grantedRow = rowFor(page, 'order-service')
  assert.match(grantedRow.textContent ?? '', /open · terminal/, 'the column lists the real grants')
  assert.equal(grantedRow.querySelector<HTMLButtonElement>('[data-open]')?.disabled, false)
  record(
    'QA-010',
    'admin 无授权 → 管理员可见（未授权）+ 打开禁用；授予 platform-admins 后列出新权限且可打开'
  )
}, 120_000)

test('M116-QA-006 已吊销主机明确标识且不能再进入维护', async () => {
  const revoke = await adminApi('/v1/hosts/host_dev001', { method: 'DELETE' })
  assert.equal(revoke.status, 200)

  const guarded = await adminApi('/v1/hosts/host_dev001/maintenance', {
    method: 'POST',
    body: JSON.stringify({ enabled: true, reason: '迟到的开机维护' })
  })
  assert.equal(guarded.status, 409, 'maintenance on a revoked host must be refused')
  assert.equal(guarded.body.error?.code, 'HOST_REVOKED')

  const page = loadWebConsolePage(service.url)
  await page.settle()
  await page.submitLogin('admin', 'Adm1n!')
  await page.clickNav('hosts')
  const row = rowFor(page, 'dev-001')
  assert.match(row.textContent ?? '', /已吊销/)
  assert.doesNotMatch(row.textContent ?? '', /维护中/)

  row.querySelector<HTMLButtonElement>('[data-host]')!.click()
  await page.settle()
  assert.match(page.window.document.body.textContent ?? '', /已吊销（/)
  assert.equal(
    page.window.document.querySelector<HTMLButtonElement>('#maintenanceBtn')?.disabled,
    true,
    'the drawer must not offer maintenance for a revoked host'
  )
  assert.equal(
    page.window.document.querySelector<HTMLButtonElement>('#revokeHostBtn')?.disabled,
    true
  )
  record(
    'QA-006',
    '吊销后行与抽屉显示 已吊销（时间），按钮禁用；服务端对已吊销主机维护返回 409 HOST_REVOKED'
  )
}, 120_000)

test('M116-QA-002 审计超过一页时给出提示并可加载更早', async () => {
  // Cross the 50-per-page boundary with real audited events.
  for (let round = 0; round < 55; round += 1) {
    await login(service.url, 'admin', 'Adm1n!')
  }
  const page = loadWebConsolePage(service.url)
  await page.settle()
  await page.submitLogin('admin', 'Adm1n!')
  await page.clickNav('audit')

  // Taken after the page's own login: that login appended an event too, and the
  // comparison has to be against what the page is actually showing.
  const all = await adminApi('/v1/audit/events?limit=200')
  assert.ok(all.body.events.length > 50, `precondition: ${all.body.events.length} events`)
  assert.match(page.text('#content'), /已显示 50 条/, 'the page must say how much it shows')
  const more = page.window.document.querySelector<HTMLButtonElement>('#auditMore')
  assert.ok(more, 'a truncated list must offer older events')
  assert.match(page.text('#content'), /仅显示最近/)

  more!.click()
  await page.settle()
  assert.match(page.text('#content'), new RegExp(`已显示 ${all.body.events.length} 条`))
  assert.equal(
    page.window.document.querySelector('#auditMore'),
    null,
    'an exhausted list must not keep the control'
  )
  record('QA-002', `共 ${all.body.events.length} 条：首屏 50 条 + 「加载更早」后与 API 总数一致`)
}, 120_000)

test('M116-QA-003 审计筛选控件保持条件，支持一键重置', async () => {
  const page = loadWebConsolePage(service.url)
  await page.settle()
  await page.submitLogin('admin', 'Adm1n!')
  await page.clickNav('audit')

  const type = page.window.document.querySelector<HTMLSelectElement>('#auditType')!
  const result = page.window.document.querySelector<HTMLSelectElement>('#auditResult')!
  const actor = page.window.document.querySelector<HTMLInputElement>('#auditActor')!
  type.value = 'grant_update'
  result.value = 'success'
  actor.value = 'admin'
  page.window.document.querySelector<HTMLButtonElement>('#auditApply')!.click()
  await page.settle()

  // The controls survive the query they produced.
  assert.equal(
    page.window.document.querySelector<HTMLSelectElement>('#auditType')!.value,
    'grant_update'
  )
  assert.equal(
    page.window.document.querySelector<HTMLSelectElement>('#auditResult')!.value,
    'success'
  )
  assert.equal(page.window.document.querySelector<HTMLInputElement>('#auditActor')!.value, 'admin')
  const rows = [...page.window.document.querySelectorAll<HTMLElement>('#content tbody tr')]
  assert.ok(rows.length > 0, 'the filtered query must match the grant events from QA-010')
  for (const tr of rows) {
    assert.match(tr.textContent ?? '', /grant_update/)
  }

  // Narrowing one control re-sends every condition, not just the changed one.
  page.window.document.querySelector<HTMLSelectElement>('#auditResult')!.value = 'denied'
  page.window.document.querySelector<HTMLButtonElement>('#auditApply')!.click()
  await page.settle()
  const lastQuery = page
    .calls()
    .filter((call) => call.startsWith('GET /v1/audit/events'))
    .at(-1)
  assert.match(lastQuery ?? '', /eventType=grant_update/, 'the event type must survive a re-query')
  assert.match(lastQuery ?? '', /result=denied/)

  page.window.document.querySelector<HTMLButtonElement>('#auditReset')!.click()
  await page.settle()
  assert.equal(page.window.document.querySelector<HTMLSelectElement>('#auditType')!.value, '')
  const resetQuery = page
    .calls()
    .filter((call) => call.startsWith('GET /v1/audit/events'))
    .at(-1)
  assert.doesNotMatch(resetQuery ?? '', /eventType=/, 'reset must clear the conditions')
  record('QA-003', '查询后控件保持所选条件；二次查询同时携带 eventType 与 result；重置清空条件')
}, 120_000)

test('M116-QA-004 traceId 完整展示且可复制', async () => {
  const page = loadWebConsolePage(service.url)
  await page.settle()
  await page.submitLogin('admin', 'Adm1n!')
  await page.clickNav('audit')

  // After the page rendered, so the newest row and the newest API event agree.
  const latest = await adminApi('/v1/audit/events?limit=1')
  const traceId: string = latest.body.events[0]?.traceId ?? ''
  assert.ok(traceId.length > 12, `precondition: a traceId exists (${traceId})`)

  const cell = page.window.document.querySelector<HTMLElement>('#content tbody tr td:last-child')
  assert.ok(cell, 'the first row must render a trace cell')
  assert.match(cell.textContent ?? '', new RegExp(traceId), 'the full traceId must be displayed')
  const copy = cell.querySelector<HTMLButtonElement>('[data-trace]')
  assert.ok(copy, 'the trace cell must offer a copy action')
  assert.equal(copy?.dataset.trace, traceId, 'the copy action must carry the full id')
  assert.equal(cell.querySelector('span')?.title, traceId, 'the full id must be available on hover')
  record('QA-004', `traceId ${traceId} 完整渲染并带复制按钮（不再截断 12 位）`)
}, 120_000)

test('M116-QA-009 保存下载策略失败时提示并回滚', async () => {
  const before = await adminApi('/v1/policies/download')
  assert.equal(before.body.downloadDefault, 'deny')

  const page = loadWebConsolePage(service.url)
  await page.settle()
  await page.submitLogin('admin', 'Adm1n!')
  await page.clickNav('settings')

  page.fail('PUT', '/v1/policies/download')
  const allow = page.window.document.querySelector<HTMLInputElement>('input[name=dl][value=allow]')!
  allow.checked = true
  page.window.document.querySelector<HTMLButtonElement>('#savePolicy')!.click()
  await page.settle()

  const toast = page.window.document.querySelector('.toast')
  assert.match(toast?.textContent ?? '', /保存失败/, 'the failure must be reported in the page')
  assert.equal(
    page.window.document.querySelector<HTMLInputElement>('input[name=dl]:checked')?.value,
    'deny',
    'the form must fall back to the value the platform holds'
  )
  const afterFail = await adminApi('/v1/policies/download')
  assert.equal(
    afterFail.body.version,
    before.body.version,
    'a failed save must not bump the policy'
  )
  assert.equal(afterFail.body.downloadDefault, 'deny')
  page.clearFails()
  record('QA-009', 'PUT 失败 → toast 保存失败 + 单选回滚为 deny，策略版本不变')
}, 120_000)
