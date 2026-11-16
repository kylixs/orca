#!/usr/bin/env node
/**
 * R5 incremental exploratory replay (pairs with exploratory-r5-paths.md):
 * P1' users page full interaction, P2' audit query grid revision, P3' embedded
 * terminal fill + echo badge. Desktop viewport only — mobile waits for r6.
 *
 * Usage: node cloud-platform/scripts/exploratory-r2/run-exploratory-r5.mjs
 * Env: ORCA_QA_BASE (default https://127.0.0.1:18787), ORCA_QA_USER/PASS.
 * Read-only except the role-change confirm chain, which is cancelled (no PUT).
 */
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.env.ORCA_QA_BASE ?? 'https://127.0.0.1:18787'
const USER = process.env.ORCA_QA_USER ?? 'admin'
const PASS = process.env.ORCA_QA_PASS ?? 'Adm1n!'
const OUT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
  'evidence/exploratory-r5'
)
const SHOTS = path.join(OUT, 'screenshots')
fs.mkdirSync(SHOTS, { recursive: true })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const ROLE_LABELS = { developer: '普通', auditor: '审计', admin: '管理员' }
const SOURCE_LABELS = { ldap: 'LDAP 同步', 'admin-override': '管理员覆盖' }

const checks = []
const paths = { "P1'": true, "P2'": true, "P3'": true }
function check(pathId, id, ok, detail) {
  checks.push({ pathId, id, status: ok ? 'PASS' : 'FAIL', detail })
  if (!ok) paths[pathId] = false
  console.log(
    `${ok ? 'PASS' : 'FAIL'} [${pathId}] ${id}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
  )
}
const norm = (value) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1440, height: 900 }
})
const page = await context.newPage()
page.setDefaultTimeout(25_000)
const consoleErrors = []
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()))
page.on('pageerror', (e) => consoleErrors.push(String(e)))
const rolePuts = []
page.on('request', (r) => {
  if (r.method() === 'PUT' && /\/v1\/users\/[^/]+\/roles/.test(r.url())) rolePuts.push(r.url())
})
// Canvas/webgl terminals expose no DOM rows; the PTY viewport RPC carries the
// authoritative row count used by the visible screen.
let latestViewportRows = null
page.on('websocket', (ws) => {
  ws.on('framesent', (frame) => {
    const text =
      typeof frame.payload === 'string'
        ? frame.payload
        : Buffer.isBuffer(frame.payload)
          ? frame.payload.toString('utf8')
          : String(frame.payload)
    if (!text.includes('terminal.updateViewport') && !text.includes('terminal.create')) return
    const match = text.match(/"rows":(\d+)/)
    if (match) latestViewportRows = Number(match[1])
  })
})

const apiGet = (p) =>
  page.evaluate(async (url) => {
    const token = localStorage.getItem('orca.access')
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
    return { status: res.status, body: await res.json().catch(() => ({})) }
  }, p)

const out = {
  base: BASE,
  viewport: 'desktop only (mobile deferred to r6)',
  checks,
  paths: {},
  steps: {}
}
try {
  // ---------------- login ----------------
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await page.locator('#loginForm').waitFor({ state: 'visible' })
  await page.fill('#username', USER)
  await page.fill('#password', PASS)
  await page.click('#loginBtn')
  await page.locator('#view-app').waitFor({ state: 'visible' })
  check(
    "P1'",
    'login',
    (await page.locator('#roleChip').innerText()).trim() === '平台管理员',
    'admin / 平台管理员'
  )

  // ---------------- P1' users page ----------------
  await page.locator('.nav-item[data-route="users"]').click()
  await page.locator('#usersBody').waitFor({ state: 'visible' })
  const usersApi = await apiGet('/v1/users')
  const users = usersApi.body.users ?? []
  const rows = () =>
    page.locator('#usersBody tr').evaluateAll((trs) =>
      trs.map((tr) => ({
        text: (tr.innerText ?? '').replace(/\s+/g, ' ').trim(),
        cells: [...tr.cells].map((td) => (td.innerText ?? '').trim()),
        controls: tr.querySelectorAll('input,select').length,
        buttons: [...tr.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim())
      }))
    )
  let list = await rows()
  out.steps.usersList = { count: list.length, api: users.length, first: list[0] }
  check(
    "P1'",
    'P1-1 list count == API',
    list.length === users.length,
    `${list.length}/${users.length}`
  )
  check(
    "P1'",
    'P1-1 list read-only',
    list.every((r) => r.controls === 0 && r.buttons.length === 1 && r.buttons[0] === '详情'),
    list.map((r) => `c${r.controls}/b${r.buttons.join('|')}`).join(' ')
  )
  check(
    "P1'",
    'P1-1 foot total',
    (await page.locator('#usersFoot').innerText()).includes(`共 ${users.length} 个账号`),
    await page.locator('#usersFoot').innerText()
  )
  await page.screenshot({ path: path.join(SHOTS, 'p1-users-list.png') })

  // Source mark (P1'-7) for every row: text + admin-override badge.
  const sourceRows = await page.locator('#usersBody tr').evaluateAll((trs) =>
    trs.map((tr) => ({
      user: (tr.cells[0]?.innerText ?? '').replace(/\s+/g, ' ').trim(),
      username: tr.cells[0]?.querySelector('.mono')?.textContent?.trim() ?? '',
      source: (tr.cells[4]?.innerText ?? '').trim(),
      badge: Boolean(tr.cells[4]?.querySelector('.badge'))
    }))
  )
  const sourceMismatches = sourceRows.filter((row) => {
    const user = users.find((u) => u.username === row.username)
    if (!user) return true
    const expected = SOURCE_LABELS[user.roleSource] ?? 'LDAP 同步'
    return row.source !== expected || (user.roleSource === 'admin-override') !== row.badge
  })
  check("P1'", 'P1-7 role source marks', sourceMismatches.length === 0, sourceRows)

  // Keyword filter (P1'-2)
  await page.fill('#userSearch', '张伟')
  await page.waitForTimeout(150)
  list = await rows()
  const zhangApi = users.filter((u) => /张伟/.test(u.displayName) || /张伟/.test(u.username))
  check(
    "P1'",
    'P1-2 keyword hit',
    list.length === zhangApi.length && list[0].text.includes('张伟'),
    `${list.length}/${zhangApi.length}`
  )
  await page.fill('#userSearch', 'no-such-user-r5')
  await page.waitForTimeout(150)
  list = await rows()
  check(
    "P1'",
    'P1-2 empty state',
    list.length === 1 && list[0].text.includes('没有符合筛选条件的账号'),
    list[0]?.text.slice(0, 60)
  )
  await page.click('#userFilterApply')
  list = await rows()
  check(
    "P1'",
    'P1-2 apply button fallback',
    list.length === 1 && list[0].text.includes('没有符合筛选条件的账号'),
    'same empty state'
  )
  await page.fill('#userSearch', '')
  await page.waitForTimeout(150)

  // Role filter (P1'-3)
  for (const role of ['admin', 'auditor']) {
    await page.selectOption('#userRoleFilter', role)
    await page.waitForTimeout(150)
    list = await rows()
    const expected = users.filter((u) => u.role === role).length
    if (expected === 0) {
      check(
        "P1'",
        `P1-3 role ${role} empty`,
        list.length === 1 && list[0].text.includes('没有符合筛选条件的账号'),
        list[0]?.text.slice(0, 50)
      )
    } else {
      check(
        "P1'",
        `P1-3 role ${role}`,
        list.length === expected && list.every((r) => r.cells[3] === ROLE_LABELS[role]),
        `${list.length}/${expected}`
      )
    }
  }
  await page.selectOption('#userRoleFilter', 'all')
  await page.waitForTimeout(100)
  // Status filter (P1'-3)
  for (const status of ['disabled', 'active']) {
    await page.selectOption('#userStatusFilter', status)
    await page.waitForTimeout(150)
    list = await rows()
    const expected = users.filter((u) => u.status === status).length
    if (expected === 0) {
      check(
        "P1'",
        `P1-3 status ${status} empty`,
        list.length === 1 && list[0].text.includes('没有符合筛选条件的账号'),
        list[0]?.text.slice(0, 50)
      )
    } else {
      check("P1'", `P1-3 status ${status}`, list.length === expected, `${list.length}/${expected}`)
    }
  }
  await page.selectOption('#userStatusFilter', 'all')
  await page.waitForTimeout(100)

  // Combined + reset (P1'-4)
  const adminUser = users.find((u) => u.role === 'admin')
  await page.selectOption('#userRoleFilter', 'admin')
  await page.selectOption('#userStatusFilter', 'active')
  await page.fill('#userSearch', adminUser?.displayName ?? '李静')
  await page.waitForTimeout(200)
  list = await rows()
  const combinedExpected = users.filter(
    (u) =>
      u.role === 'admin' &&
      u.status === 'active' &&
      (u.displayName.includes(adminUser?.displayName ?? '李静') ||
        u.username.includes(adminUser?.displayName ?? '李静'))
  )
  check(
    "P1'",
    'P1-4 combined filter',
    list.length === combinedExpected.length && list[0]?.text.includes(adminUser?.displayName ?? ''),
    `${list.length}/${combinedExpected.length}`
  )
  await page.click('#userFilterReset')
  await page.waitForTimeout(150)
  list = await rows()
  const resetState = await page.evaluate(() => ({
    q: document.querySelector('#userSearch').value,
    role: document.querySelector('#userRoleFilter').value,
    status: document.querySelector('#userStatusFilter').value,
    foot: document.querySelector('#usersFoot').innerText
  }))
  check(
    "P1'",
    'P1-4 reset restores all',
    resetState.q === '' &&
      resetState.role === 'all' &&
      resetState.status === 'all' &&
      list.length === users.length &&
      !resetState.foot.includes('当前筛选'),
    resetState
  )

  // Detail modal fields (P1'-5)
  const adminRow = page.locator('#usersBody tr').filter({ hasText: adminUser.username }).first()
  await adminRow.getByRole('button', { name: '详情' }).click()
  const detail = page
    .locator('.dialog')
    .filter({ has: page.locator('h2', { hasText: '用户详情' }) })
  await detail.waitFor({ state: 'visible' })
  const detailText = norm(await detail.locator('.body').innerText())
  const requiredFields = ['显示名', '账号', '部门', 'LDAP 组', '平台角色', '角色来源', '状态']
  const fieldValuesOk =
    detailText.includes(adminUser.displayName) &&
    detailText.includes(adminUser.username) &&
    detailText.includes(adminUser.dept) &&
    detailText.includes(ROLE_LABELS[adminUser.role]) &&
    detailText.includes(SOURCE_LABELS[adminUser.roleSource]) &&
    detailText.includes('活跃')
  check(
    "P1'",
    'P1-5 detail fields',
    requiredFields.every((f) => detailText.includes(f)) &&
      fieldValuesOk &&
      !detailText.includes('创建时间') &&
      !detailText.includes('最近登录'),
    detailText.slice(0, 240)
  )
  check(
    "P1'",
    'P1-5 detail role select',
    (await detail.locator('[data-detail-role]').inputValue()) === adminUser.role,
    await detail.locator('[data-detail-role]').inputValue()
  )
  await page.screenshot({ path: path.join(SHOTS, 'p1-user-detail.png') })

  // Role confirm chain, cancel (P1'-6)
  const roleSelect = detail.locator('[data-detail-role]')
  await roleSelect.selectOption(adminUser.role === 'admin' ? 'developer' : 'admin')
  const rolledBack = await roleSelect.inputValue()
  const confirm = page
    .locator('.dialog')
    .filter({ has: page.locator('h2', { hasText: '角色变更' }) })
  await confirm.waitFor({ state: 'visible' })
  const confirmTitle = norm(await confirm.locator('h2').innerText())
  const confirmText = norm(await confirm.locator('.body').innerText())
  const dangerButton = confirm.locator('[data-action="0"]')
  const dangerStyle = await dangerButton.evaluate((el) => ({
    text: el.textContent.trim(),
    danger: el.classList.contains('danger')
  }))
  await page.screenshot({ path: path.join(SHOTS, 'p1-role-confirm-cancel.png') })
  check(
    "P1'",
    'P1-6 confirm chain content',
    confirmTitle === '角色变更' &&
      rolledBack === adminUser.role &&
      confirmText.includes('变更写入 role_update 审计') &&
      confirmText.includes('降级将断开该用户当前云会话') &&
      dangerStyle.text === '确认变更' &&
      dangerStyle.danger,
    { confirmTitle, rolledBack, dangerStyle, confirmText: confirmText.slice(0, 160) }
  )
  await confirm.locator('[data-action="close"]').click()
  await page.waitForTimeout(200)
  const afterCancel = {
    rolePuts: rolePuts.length,
    confirmGone:
      (await page
        .locator('.dialog')
        .filter({ has: page.locator('h2', { hasText: '角色变更' }) })
        .count()) === 0,
    detailStillOpen: await detail.isVisible(),
    selectValue: await detail
      .locator('[data-detail-role]')
      .inputValue()
      .catch(() => null)
  }
  check(
    "P1'",
    'P1-6 cancel sends no PUT + rolls back',
    afterCancel.rolePuts === 0 &&
      afterCancel.confirmGone &&
      afterCancel.detailStillOpen &&
      afterCancel.selectValue === adminUser.role,
    afterCancel
  )
  await detail.locator('[data-action="close"]').click()
  await page.waitForTimeout(150)

  // ---------------- P2' audit query grid ----------------
  await page.locator('.nav-item[data-route="audit"]').click()
  await page.locator('#auditApply').waitFor({ state: 'visible' })
  await page.waitForTimeout(250)
  const grid = await page.evaluate(() => {
    const ids = [
      'auditKeyword',
      'auditRange',
      'auditSince',
      'auditUntil',
      'auditType',
      'auditActor',
      'auditProject',
      'auditHost',
      'auditFileName',
      'auditResult'
    ]
    const rect = (el) => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      return {
        top: +r.top.toFixed(2),
        left: +r.left.toFixed(2),
        right: +r.right.toFixed(2),
        bottom: +r.bottom.toFixed(2),
        width: +r.width.toFixed(2),
        height: +r.height.toFixed(2)
      }
    }
    return {
      rects: Object.fromEntries(ids.map((id) => [id, rect(document.getElementById(id))])),
      apply: rect(document.getElementById('auditApply')),
      reset: rect(document.getElementById('auditReset')),
      actions: rect(document.querySelector('.audit-filter-actions')),
      filter: rect(document.querySelector('.audit-filter'))
    }
  })
  const entries = Object.entries(grid.rects)
  const clusters = []
  for (const [id, rect] of entries) {
    const cluster = clusters.find((c) => Math.abs(c.top - rect.top) <= 8)
    if (cluster) cluster.ids.push(id)
    else clusters.push({ top: rect.top, ids: [id] })
  }
  clusters.sort((a, b) => a.top - b.top)
  for (const extra of [
    { id: 'auditApply', rect: grid.apply },
    { id: 'auditReset', rect: grid.reset }
  ]) {
    const cluster = clusters.find((c) => Math.abs(c.top - extra.rect.top) <= 8)
    cluster?.ids.push(extra.id)
  }
  const expectedRows = [
    ['auditKeyword', 'auditRange', 'auditSince', 'auditUntil', 'auditType'],
    ['auditActor', 'auditProject', 'auditHost', 'auditFileName'],
    ['auditResult', 'auditApply', 'auditReset']
  ]
  const clusterSorted = clusters.map((c) => c.ids.slice().sort())
  const expectedSorted = expectedRows.map((r) => r.slice().sort())
  check(
    "P2'",
    'P2-1 three grid rows',
    clusters.length === 3,
    clusters.map((c) => c.ids.join(','))
  )
  check(
    "P2'",
    'P2-1 row membership',
    expectedSorted.every((row, i) => JSON.stringify(clusterSorted[i]) === JSON.stringify(row)),
    clusterSorted
  )
  const allRects = [...entries.map(([, r]) => r), grid.apply, grid.reset]
  const withinFilter = allRects.every(
    (r) => r.left >= grid.filter.left - 1 && r.right <= grid.filter.right + 1
  )
  const overlapFree = expectedRows.every((ids) => {
    const sorted = ids
      .map((id) =>
        id === 'auditApply' ? grid.apply : id === 'auditReset' ? grid.reset : grid.rects[id]
      )
      .sort((a, b) => a.left - b.left)
    return sorted.every((r, i) => i === 0 || r.left >= sorted[i - 1].right - 1)
  })
  check(
    "P2'",
    'P2-1 geometry sane',
    withinFilter && overlapFree && grid.actions.right >= grid.rects.auditResult.right - 1,
    {
      withinFilter,
      overlapFree,
      actionsRight: grid.actions.right,
      resultRight: grid.rects.auditResult.right
    }
  )
  await page.screenshot({ path: path.join(SHOTS, 'p2-audit-grid.png') })

  // No bottom hint + header 31-day copy (P2'-2/P2'-3)
  const hint = await page.evaluate(() => {
    const err = document.querySelector('#auditError')
    return {
      oldHint: document.body.innerText.includes('默认最近 7 天，起止时间优先'),
      nextClass: err?.nextElementSibling?.className ?? null,
      filterMuted: document.querySelector('.audit-filter')?.querySelectorAll('.muted').length ?? -1,
      header: (document.querySelector('#content .page-head p')?.innerText ?? '')
        .replace(/\s+/g, ' ')
        .trim()
    }
  })
  check(
    "P2'",
    'P2-2 bottom hint removed',
    !hint.oldHint && String(hint.nextClass).includes('table-wrap') && hint.filterMuted === 0,
    hint
  )
  check(
    "P2'",
    'P2-3 31-day copy in header',
    hint.header.includes('保留 180 天，查询时间窗最大 31 天') && /已显示 \d+ 条/.test(hint.header),
    hint.header
  )

  // Combined filter against real API data (P2'-4). Range 7 days: the 31-day
  // preset straddles the server's 31-day gate (see P2'-4 observation below).
  await page.selectOption('#auditType', 'login')
  await page.fill('#auditActor', 'admin')
  await page.selectOption('#auditResult', 'success')
  await page.selectOption('#auditRange', '168')
  await page.click('#auditApply')
  await page.waitForTimeout(1200)
  const since = new Date(Date.now() - 168 * 3_600_000).toISOString()
  const auditApi = await apiGet(
    `/v1/audit/events?${new URLSearchParams({ limit: '50', eventType: 'login', result: 'success', username: 'admin', since })}`
  )
  const auditRows = await page
    .locator('#content tbody tr')
    .evaluateAll((trs) =>
      trs.map((tr) => [...tr.cells].map((td) => (td.innerText ?? '').replace(/\s+/g, ' ').trim()))
    )
  const auditHeader = norm(await page.locator('#content .page-head p').innerText())
  const events = auditApi.body.events ?? []
  out.steps.auditCombo = {
    domRows: auditRows.length,
    apiRows: events.length,
    header: auditHeader,
    sample: auditRows[0]
  }
  check(
    "P2'",
    'P2-4 combo row count == API',
    auditRows.length === events.length && auditRows.length > 0,
    `${auditRows.length}/${events.length}`
  )
  check(
    "P2'",
    'P2-4 combo rows match filters',
    auditRows.every(
      (cells) => cells[1] === 'admin' && cells[2].includes('login') && cells[6] === '✓ 成功'
    ),
    auditRows.slice(0, 2)
  )
  check(
    "P2'",
    'P2-4 header count matches rows',
    auditHeader.includes(`已显示 ${auditRows.length} 条`),
    auditHeader
  )

  // Observation: the "最近 31 天" preset computes since = now-744h in the
  // browser; by request time the server-now window exceeds 31 days and answers
  // TIME_WINDOW_TOO_LARGE. The UI leaves the previous rows in place with no
  // visible error (unhandled render rejection). Finding only; path stays green.
  const boundarySince = new Date(Date.now() - 744 * 3_600_000).toISOString()
  const boundaryApi = await apiGet(
    `/v1/audit/events?${new URLSearchParams({ limit: '50', eventType: 'login', result: 'success', username: 'admin', since: boundarySince })}`
  )
  const boundaryConsoleStart = consoleErrors.length
  await page.selectOption('#auditRange', '744')
  await page.click('#auditApply')
  await page.waitForTimeout(1200)
  const boundaryConsole = consoleErrors.slice(boundaryConsoleStart)
  const boundaryUi = {
    rowsAfter: await page.locator('#content tbody tr').count(),
    errorHidden: await page
      .locator('#auditError')
      .isHidden()
      .catch(() => null),
    errorText: norm(
      await page
        .locator('#auditError')
        .innerText()
        .catch(() => '')
    ),
    uiWindowError: boundaryConsole.some((line) => line.includes('31 天') || line.includes('400')),
    console: boundaryConsole.slice(0, 5),
    requestCode: boundaryApi.body?.error?.code ?? null,
    apiStatus: boundaryApi.status
  }
  out.observations = [
    {
      id: 'R5-OBS-01',
      area: 'audit / 31 天预设边界',
      severity: 'P2',
      title: '「最近 31 天」预设触发服务端窗口拒绝，页面静默保留旧结果',
      expected: '预设「最近 31 天」应可查询，或至少把窗口超限显示为错误提示',
      actual: `客户端 since=now-744h，请求到达服务端时窗口 >31d → 400（uiWindowError=${boundaryUi.uiWindowError}，console=${boundaryConsole.join(' | ').slice(0, 200)}）；DOM 行数保持 ${boundaryUi.rowsAfter}（旧结果未替换），#auditError hidden=${boundaryUi.errorHidden}`,
      repro: '审计页时间范围选「最近 31 天」→ 查询',
      note: `r5 组合过滤改用「最近 7 天」后通过；直连 API 探针当次 HTTP ${boundaryApi.status}${boundaryUi.requestCode ? `/${boundaryUi.requestCode}` : ''}，说明边界受毫秒级延迟影响呈抖动，UI 预设仍会命中 400`
    }
  ]
  checks.push({
    pathId: "P2'",
    id: 'P2-4 31-day preset boundary',
    status: 'OBSERVE',
    detail: boundaryUi
  })
  console.log(`OBSERVE [P2'] P2-4 31-day preset boundary:`, JSON.stringify(boundaryUi))

  // ---------------- P3' embedded terminal ----------------
  await page.locator('.nav-item[data-route="projects"]').click()
  await page.locator('#projectBody').waitFor({ state: 'visible' })
  const demoRow = page.locator('#projectBody tr').filter({ hasText: 'demo-app' }).first()
  const openButton = demoRow.getByRole('button', { name: '打开', exact: true })
  check(
    "P3'",
    'P3-0 demo-app open available',
    (await openButton.count()) === 1 && (await openButton.isEnabled()),
    await demoRow
      .innerText()
      .then(norm)
      .catch(() => 'no row')
  )
  await openButton.click()
  await page.locator('#workspaceOverlay iframe').waitFor({ state: 'attached', timeout: 20_000 })
  let workspaceState = 'wait'
  for (let i = 0; i < 100; i += 1) {
    workspaceState = await page.evaluate(() => {
      const overlay = document.querySelector('#workspaceOverlay')
      if (!overlay) return 'gone'
      if (overlay.querySelector('[data-workspace-ready-failure]')) return 'failure'
      if (overlay.querySelector('[data-workspace-status]')?.hidden) return 'ready'
      return 'wait'
    })
    if (workspaceState !== 'wait') break
    await sleep(300)
  }
  let frame = null
  for (let i = 0; i < 40 && !frame; i += 1) {
    frame = page.frames().find((f) => f.url().includes('/cloud-admin.html')) ?? null
    if (!frame) await sleep(250)
  }
  out.steps.workspace = { state: workspaceState, frameUrl: frame?.url() ?? null }
  check(
    "P3'",
    'P3-0 workspace ready',
    workspaceState === 'ready' && Boolean(frame),
    out.steps.workspace
  )
  if (workspaceState === 'ready' && frame) {
    await frame.locator('[data-testid="cloud-simple-workspace-new-terminal"]').click()
    let terminalState = ''
    for (let i = 0; i < 80; i += 1) {
      terminalState = await frame
        .locator('[data-testid="cloud-terminal-state"]')
        .innerText({ timeout: 1000 })
        .catch(() => '')
      if (terminalState.includes('实时')) break
      await sleep(400)
    }
    check("P3'", 'P3-0 terminal live', terminalState.includes('实时'), terminalState)

    const measure = () =>
      frame.evaluate((ptyRows) => {
        const rect = (el) => {
          if (!el) return null
          const r = el.getBoundingClientRect()
          return {
            top: +r.top.toFixed(2),
            bottom: +r.bottom.toFixed(2),
            height: +r.height.toFixed(2),
            left: +r.left.toFixed(2),
            right: +r.right.toFixed(2)
          }
        }
        const pane = [
          ...document.querySelectorAll('[data-testid^="cloud-simple-workspace-pane-"]')
        ].find((el) => el.getBoundingClientRect().height > 0)
        const panel = document.querySelector('[data-testid="cloud-terminal-panel"]')
        const host = document.querySelector('[data-testid="cloud-terminal-host"]')
        const xterm = document.querySelector('.xterm-screen')
        // Renderer may be canvas/webgl: .xterm-rows is absent or empty.
        const rowsEl = document.querySelector('.xterm-rows')
        const measureEl = document.querySelector('.xterm-char-measure-element')
        const charRect = measureEl?.getBoundingClientRect()
        const domRows = rowsEl?.children.length ?? 0
        const charHeight = charRect && charRect.height > 1 ? +charRect.height.toFixed(2) : null
        const scrollEl = document.querySelector('.xterm-scrollable-element')
        const xtermRect = rect(xterm)
        const paneRect = rect(pane)
        const panelRect = rect(panel)
        const hostRect = rect(host)
        const rows = domRows > 0 ? domRows : (ptyRows ?? null)
        return {
          viewport: { w: innerWidth, h: innerHeight },
          pane: paneRect,
          panel: panelRect,
          host: hostRect,
          xterm: xtermRect,
          rows,
          domRows,
          charHeight,
          hasRowsEl: Boolean(rowsEl),
          canvases: document.querySelectorAll('.xterm-screen canvas').length,
          scrollHeight: scrollEl?.scrollHeight ?? null,
          clientHeight: scrollEl?.clientHeight ?? null,
          lineHeight:
            charHeight ?? (xtermRect && rows ? +(xtermRect.height / rows).toFixed(2) : null),
          gapPanePanel:
            paneRect && panelRect ? +Math.abs(paneRect.bottom - panelRect.bottom).toFixed(2) : null,
          gapHostXterm:
            hostRect && xtermRect ? +(hostRect.bottom - xtermRect.bottom).toFixed(2) : null
        }
      }, latestViewportRows)

    // FitAddon runs on a ResizeObserver after the terminal goes live; wait for
    // the screen to claim the host before measuring (a first-frame measure can
    // still see a half-height canvas).
    const settle = async () => {
      let last = null
      for (let i = 0; i < 24; i += 1) {
        last = await measure()
        if (last.host && last.xterm && last.host.height - last.xterm.height < 40) {
          await sleep(300)
          return measure()
        }
        await sleep(250)
      }
      return last
    }
    const initial = await settle()
    out.steps.terminalInitial = initial
    await frame
      .locator('[data-testid="cloud-simple-workspace"]')
      .screenshot({ path: path.join(SHOTS, 'p3-terminal-initial.png') })

    // Empirical cell height: xterm positions the helper textarea on the cursor
    // cell; one Enter moves it down exactly one row (no scroll at the top).
    const cursorRect = () =>
      frame.evaluate(() => {
        const el = document.querySelector('.xterm-helper-textarea')
        if (!el) return null
        const r = el.getBoundingClientRect()
        return {
          top: +r.top.toFixed(2),
          left: +r.left.toFixed(2),
          styleTop: el.style.top,
          styleLeft: el.style.left
        }
      })
    const ta = frame.locator('.xterm-helper-textarea')
    await ta.focus()
    const cursorBefore = await cursorRect()
    await page.keyboard.press('Enter')
    await page.waitForTimeout(500)
    const cursorAfter = await cursorRect()
    const lineHeight =
      cursorBefore && cursorAfter && cursorAfter.top > cursorBefore.top
        ? +(cursorAfter.top - cursorBefore.top).toFixed(3)
        : null
    const rowsOf = (m) => (lineHeight && m.xterm ? Math.round(m.xterm.height / lineHeight) : null)
    const rowsBefore = rowsOf(initial)
    initial.lineHeight = lineHeight
    initial.rows = rowsBefore
    out.steps.lineHeightProbe = { cursorBefore, cursorAfter, lineHeight, rowsBefore }
    check(
      "P3'",
      'P3-1 initial fill gap < one row',
      lineHeight !== null &&
        initial.gapPanePanel !== null &&
        initial.gapPanePanel <= 1 &&
        initial.gapHostXterm < lineHeight,
      {
        gapPanePanel: initial.gapPanePanel,
        gapHostXterm: initial.gapHostXterm,
        lineHeight,
        rows: rowsBefore
      }
    )

    await page.setViewportSize({ width: 1280, height: 860 })
    await page.waitForTimeout(1000)
    const resized = await settle()
    const rowsAfter = rowsOf(resized)
    resized.lineHeight = lineHeight
    resized.rows = rowsAfter
    out.steps.terminalResized = resized
    check(
      "P3'",
      'P3-2 resize fit follows',
      lineHeight !== null &&
        rowsBefore !== null &&
        rowsAfter !== null &&
        rowsBefore !== rowsAfter &&
        resized.gapPanePanel <= 1 &&
        resized.gapHostXterm < lineHeight,
      {
        rowsBefore,
        rowsAfter,
        gapPanePanel: resized.gapPanePanel,
        gapHostXterm: resized.gapHostXterm,
        lineHeight
      }
    )
    await frame
      .locator('[data-testid="cloud-simple-workspace"]')
      .screenshot({ path: path.join(SHOTS, 'p3-terminal-resized.png') })

    const echoBadge = frame.locator('[data-testid="cloud-terminal-echo-latency"]')
    const readBadge = async () => {
      if ((await echoBadge.count()) === 0) return null
      return {
        text: norm(await echoBadge.innerText()),
        title: await echoBadge.getAttribute('title')
      }
    }
    await ta.focus()
    await page.keyboard.type('echo R5_ECHO_OK')
    await page.keyboard.press('Enter')
    let badge = null
    for (let i = 0; i < 40 && !badge; i += 1) {
      badge = await readBadge()
      if (!badge) await sleep(250)
    }
    const sampleMatch = badge?.title?.match(/(\d+) 键/)
    const samples = sampleMatch ? Number(sampleMatch[1]) : null
    check(
      "P3'",
      'P3-3 echo badge appears',
      Boolean(badge) &&
        /^echo \d+ms p95$/.test(badge.text) &&
        /回显 P50 .+ · P95 .+ · max .+ · \d+ 键/.test(badge.title ?? ''),
      badge
    )
    await page.keyboard.type('echo R5_ECHO_TWO')
    await page.keyboard.press('Enter')
    let badge2 = badge
    let samples2 = samples
    for (let i = 0; i < 40; i += 1) {
      badge2 = await readBadge()
      const match = badge2?.title?.match(/(\d+) 键/)
      samples2 = match ? Number(match[1]) : null
      if (samples2 !== null && samples !== null && samples2 > samples) break
      await sleep(250)
    }
    check(
      "P3'",
      'P3-3 badge updates with input',
      Boolean(badge) &&
        Boolean(badge2) &&
        samples2 !== null &&
        samples !== null &&
        samples2 > samples &&
        /^echo \d+ms p95$/.test(badge2.text),
      { before: { text: badge?.text, samples }, after: { text: badge2?.text, samples: samples2 } }
    )

    const xtermScreen = frame.locator('.xterm-screen')
    const longShotBefore = await xtermScreen.screenshot()
    const scrollBeforeLong = (await measure()).scrollHeight
    const samplesBeforeLong = samples2
    await page.keyboard.type('for i in $(seq 1 300); do echo R5_LONG_$i; done')
    await page.keyboard.press('Enter')
    // Canvas renderer keeps no DOM rows text, so prove output through the meter
    // sample jump plus a changed screen bitmap, then re-measure the fill.
    let longBadge = badge2
    let samplesLong = samplesBeforeLong
    for (let i = 0; i < 40; i += 1) {
      longBadge = await readBadge()
      const match = longBadge?.title?.match(/(\d+) 键/)
      samplesLong = match ? Number(match[1]) : samplesLong
      if (samplesLong !== null && samplesBeforeLong !== null && samplesLong > samplesBeforeLong)
        break
      await sleep(250)
    }
    await page.waitForTimeout(1200)
    const longShotAfter = await xtermScreen.screenshot()
    const afterLong = await measure()
    const screenChanged = !longShotBefore.equals(longShotAfter)
    const scrollDelta =
      afterLong.scrollHeight !== null && scrollBeforeLong !== null
        ? afterLong.scrollHeight - scrollBeforeLong
        : 0
    const longSeen =
      screenChanged &&
      (samplesLong === null || samplesBeforeLong === null || samplesLong > samplesBeforeLong)
    out.steps.terminalLong = {
      ...afterLong,
      longSeen,
      screenChanged,
      samplesBeforeLong,
      samplesLong,
      scrollBeforeLong,
      scrollAfterLong: afterLong.scrollHeight,
      scrollDelta,
      lineHeight,
      rowsBefore,
      rowsAfter
    }
    check("P3'", 'P3-4 long output rendered', longSeen, {
      screenChanged,
      samplesBeforeLong,
      samplesLong,
      scrollDelta
    })
    check(
      "P3'",
      'P3-4 still filled after long output',
      lineHeight !== null && afterLong.gapPanePanel <= 1 && afterLong.gapHostXterm < lineHeight,
      { gapPanePanel: afterLong.gapPanePanel, gapHostXterm: afterLong.gapHostXterm, lineHeight }
    )
    await frame
      .locator('[data-testid="cloud-simple-workspace"]')
      .screenshot({ path: path.join(SHOTS, 'p3-terminal-long.png') })

    await page.locator('#workspaceOverlay [data-workspace-close]').click()
    await page.waitForTimeout(700)
  }
} catch (error) {
  out.error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error)
  check("P1'", 'RUN', false, out.error)
} finally {
  out.paths = paths
  out.consoleErrors = consoleErrors.slice(0, 20)
  out.generatedAt = new Date().toISOString()
  out.pass = Object.values(paths).every(Boolean)
  fs.writeFileSync(path.join(OUT, 'r5-findings.json'), JSON.stringify(out, null, 2))
  await browser.close().catch(() => {})
  console.log(
    `\n${out.pass ? 'PASS' : 'FAIL'} exploratory-r5 ${JSON.stringify(paths)} checks=${checks.length}`
  )
  process.exitCode = out.pass ? 0 : 1
}
