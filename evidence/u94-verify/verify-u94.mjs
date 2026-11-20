// U94 final acceptance: U83 / U84 / U81b / U86 on the persistent 18787 environment.
// One browser, one session, serial; measurements + screenshots + console errors.
import { chromium } from 'playwright'
import path from 'node:path'
import fs from 'node:fs'

const BASE = 'https://127.0.0.1:18787'
const OUT = path.dirname(new URL(import.meta.url).pathname)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const result = { startedAt: new Date().toISOString(), checks: {}, consoleErrors: [] }

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1600, height: 1000 }
})
const page = await context.newPage()
page.setDefaultTimeout(25000)
page.on('console', (msg) => {
  if (msg.type() === 'error')
    result.consoleErrors.push({ frame: msg.location().url, text: msg.text() })
})
page.on('pageerror', (err) => result.consoleErrors.push({ frame: 'pageerror', text: err.message }))

const rolePuts = []
page.on('request', (req) => {
  if (req.method() === 'PUT' && req.url().includes('/roles')) rolePuts.push(req.url())
})

// ---------- login ----------
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
await page.fill('#username', 'admin')
await page.fill('#password', 'Adm1n!')
await page.click('#loginBtn')
await page.waitForSelector('text=demo-app', { timeout: 30000 })

// ================= U81b users page =================
await page.click('button[data-route="users"]')
await page.waitForSelector('#userSearch')
await sleep(600)
const rows = page.locator('#usersBody tr')
const countRows = () => rows.count()
const listRoleControls = await page.locator('#usersBody select').count()
const fullCount = await countRows()
const firstUsername = (
  await page.locator('#usersBody tr:first-child td:first-child .mono').first().textContent()
)?.trim()
const fullRoles = await page.locator('#usersBody tr td:nth-child(4)').allTextContents()

// keyword filter-as-you-type
const keyword = firstUsername.slice(0, 3)
await page.fill('#userSearch', keyword)
await sleep(300)
const keywordCount = await countRows()
const keywordRows = await page.locator('#usersBody tr').allTextContents()
const keywordAllMatch = keywordRows.every((t) => t.includes(keyword))

// role filter
await page.fill('#userSearch', '')
await page.selectOption('#userRoleFilter', 'admin')
await sleep(300)
const roleCount = await countRows()
const roleTexts = (await page.locator('#usersBody tr td:nth-child(4)').allTextContents()).map((t) =>
  t.trim()
)
const roleAll = roleTexts.every((t) => t === '管理员') && roleCount > 0

// status filter (disabled)
await page.selectOption('#userRoleFilter', 'all')
await page.selectOption('#userStatusFilter', 'disabled')
await sleep(300)
const disabledCount = await countRows()

// reset
await page.click('#userFilterReset')
await sleep(400)
const resetCount = await countRows()
const resetInputs = await page.evaluate(() => ({
  query: document.querySelector('#userSearch').value,
  role: document.querySelector('#userRoleFilter').value,
  status: document.querySelector('#userStatusFilter').value
}))
await page.screenshot({ path: path.join(OUT, 'u94-u81b-users.png') })

// detail modal
await page.locator('#usersBody tr:first-child button[data-user-detail]').click()
await page.waitForSelector('.dialog-backdrop .dialog')
const detailTitle = (await page.locator('.dialog-backdrop .dialog h2').last().textContent())?.trim()
const detailRoleOptions = await page
  .locator('.dialog-backdrop .dialog [data-detail-role] option')
  .allTextContents()
const detailRoleCount = await page.locator('.dialog-backdrop .dialog [data-detail-role]').count()
const detailFields = await page.locator('.dialog-backdrop .dialog dl.kv dt').allTextContents()

// role change -> confirm dialog, then cancel (no submit)
const currentRole = await page.locator('.dialog-backdrop .dialog [data-detail-role]').inputValue()
const nextRole = currentRole === 'admin' ? 'developer' : 'admin'
await page.selectOption('.dialog-backdrop .dialog [data-detail-role]', nextRole)
await page.waitForSelector('.dialog-backdrop .dialog h2:text-is("角色变更")')
const confirmDialogs = page.locator('.dialog-backdrop .dialog')
const confirmIdx = (await confirmDialogs.count()) - 1
const confirmTitle = (await confirmDialogs.nth(confirmIdx).locator('h2').textContent())?.trim()
const confirmBody = (await confirmDialogs.nth(confirmIdx).locator('.body').innerText())?.trim()
const confirmButtons = await confirmDialogs
  .nth(confirmIdx)
  .locator('.foot button')
  .allTextContents()
const confirmDanger =
  (await confirmDialogs
    .nth(confirmIdx)
    .locator('.foot button[data-action="0"]')
    .getAttribute('class')) ?? ''
await page.screenshot({ path: path.join(OUT, 'u94-u81b-confirm.png') })
await confirmDialogs.nth(confirmIdx).locator('button[data-action="close"]').click()
await sleep(400)
const confirmClosed =
  (await page.locator('.dialog-backdrop .dialog h2:text-is("角色变更")').count()) === 0
const detailStillOpen = (await page.locator('.dialog-backdrop .dialog h2').count()) > 0
// close detail
await page.locator('.dialog-backdrop .dialog button[data-action="close"]').last().click()
await sleep(300)

result.checks.u81b = {
  accountCount: fullCount,
  listRoleControls,
  fullRoles,
  keyword: { keyword, count: keywordCount, allRowsMatch: keywordAllMatch },
  roleFilter: { value: 'admin', count: roleCount, allRowsAdmin: roleAll, roles: roleTexts },
  statusFilter: { value: 'disabled', count: disabledCount },
  reset: { count: resetCount, inputs: resetInputs },
  detail: {
    title: detailTitle,
    fieldLabels: detailFields,
    roleSelectCount: detailRoleCount,
    roleOptions: detailRoleOptions
  },
  changeFlow: {
    from: currentRole,
    to: nextRole,
    confirmTitle,
    confirmBody,
    confirmButtons,
    dangerClass: confirmDanger,
    cancelled: confirmClosed,
    detailStillOpen,
    rolePutsIssued: rolePuts.length
  }
}

// ================= U86 audit page =================
await page.click('button[data-route="audit"]')
await page.waitForSelector('.audit-filter')
await sleep(1200)
const audit = await page.evaluate(() => {
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
  const controls = ids.map((id) => {
    const el = document.getElementById(id)
    const r = el.getBoundingClientRect()
    return {
      id,
      top: +r.top.toFixed(2),
      bottom: +r.bottom.toFixed(2),
      height: +r.height.toFixed(2),
      left: +r.left.toFixed(2)
    }
  })
  const actions = document.querySelector('.audit-filter-actions')
  const ar = actions.getBoundingClientRect()
  const grid = document.querySelector('.audit-filter')
  const cs = getComputedStyle(grid)
  const head = document.querySelector('.page-head p')?.textContent ?? ''
  return {
    controls,
    actions: {
      top: +ar.top.toFixed(2),
      bottom: +ar.bottom.toFixed(2),
      height: +ar.height.toFixed(2),
      left: +ar.left.toFixed(2)
    },
    gridCSS: {
      display: cs.display,
      columnGap: cs.columnGap,
      rowGap: cs.rowGap,
      gridTemplateColumns: cs.gridTemplateColumns
    },
    headerText: head,
    bodyText: document.body.innerText,
    filterText: grid.innerText
  }
})
// group by top with 3px tolerance
const sorted = [
  ...audit.controls.map((c) => ({ id: c.id, top: c.top })),
  { id: 'actions', top: audit.actions.top }
].sort((a, b) => a.top - b.top)
const groups = []
for (const item of sorted) {
  const g = groups.find((g) => Math.abs(g.top - item.top) <= 3)
  if (g) g.items.push(item.id)
  else groups.push({ top: item.top, items: [item.id] })
}
const noHintBottom = !/默认最近/.test(audit.bodyText) && !/关键字 2/.test(audit.bodyText)
const headerHas31 = /31 天/.test(audit.headerText)
await page.screenshot({ path: path.join(OUT, 'u94-u86-audit.png'), fullPage: false })
await page.locator('.audit-filter').screenshot({ path: path.join(OUT, 'u94-u86-querybar.png') })

result.checks.u86 = {
  controls: audit.controls,
  actions: audit.actions,
  gridCSS: audit.gridCSS,
  rowGroups: groups,
  rowCount: groups.length,
  hintLineAbsent: noHintBottom,
  removedHintTokensInBody: {
    defaultRecent7d: /默认最近/.test(audit.bodyText),
    keyword2128: /关键字 2/.test(audit.bodyText)
  },
  headerHas31Days: headerHas31,
  headerText: audit.headerText,
  filterText: audit.filterText
}

// ================= U83 + U84 workspace terminal =================
await page.click('button[data-route="projects"]')
await page.waitForSelector('text=demo-app')
await page
  .locator('tr', { hasText: 'demo-app' })
  .getByRole('button', { name: '打开', exact: true })
  .click()
await page.locator('#workspaceOverlay iframe').waitFor({ timeout: 15000 })
for (let i = 0; i < 160; i += 1) {
  const state = await page.evaluate(() => {
    const o = document.querySelector('#workspaceOverlay')
    return {
      failure: !!o?.querySelector('[data-workspace-ready-failure]'),
      ready: o?.querySelector('[data-workspace-status]')?.hidden === true
    }
  })
  if (state.failure || state.ready) break
  await sleep(500)
}
const workspaceFailure = await page.locator('[data-workspace-ready-failure]').count()
const fr = () => page.frames().find((f) => f.url().includes('/cloud-admin.html'))
if (!fr()) throw new Error('cloud-admin iframe not found; failure=' + workspaceFailure)
await fr().evaluate(() =>
  document.querySelector('[data-testid="cloud-simple-workspace-new-terminal"]').click()
)
for (let i = 0; i < 60; i += 1) {
  const state = await fr().evaluate(
    () => document.querySelector('[data-testid="cloud-terminal-state"]')?.textContent ?? ''
  )
  if (state.includes('实时')) break
  await sleep(500)
}

const measure = () =>
  fr().evaluate(() => {
    const rect = (el) => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { top: +r.top.toFixed(2), bottom: +r.bottom.toFixed(2), height: +r.height.toFixed(2) }
    }
    const pane = [
      ...document.querySelectorAll('[data-testid^="cloud-simple-workspace-pane-"]')
    ].find((el) => el.getBoundingClientRect().height > 0)
    const rowEl = document.querySelector('.xterm-rows > div')
    const viewport = document.querySelector('.xterm-viewport')
    return {
      viewport: { w: innerWidth, h: innerHeight },
      pane: rect(pane),
      panel: rect(document.querySelector('[data-testid="cloud-terminal-panel"]')),
      host: rect(document.querySelector('[data-testid="cloud-terminal-host"]')),
      xtermScreen: rect(document.querySelector('.xterm-screen')),
      xtermViewport: rect(viewport),
      rowHeight: rowEl ? +rowEl.getBoundingClientRect().height.toFixed(2) : null,
      rows: document.querySelector('.xterm-rows')?.children.length ?? null,
      terminalState:
        document.querySelector('[data-testid="cloud-terminal-state"]')?.textContent ?? null
    }
  })

const before = await measure()
const gapPane = +(before.pane.bottom - before.panel.bottom).toFixed(2)
const gapHostXterm = +(before.host.bottom - before.xtermScreen.bottom).toFixed(2)
await fr()
  .locator('[data-testid="cloud-simple-workspace"]')
  .screenshot({ path: path.join(OUT, 'u94-u83-terminal-1600x1000.png') })

// --- U84: type 20 keys, badge appears ---
const xtermBox = await fr().locator('.xterm-screen').boundingBox()
await fr().locator('.xterm-screen').click()
await page.keyboard.type('abcdefghijklmnopqrst', { delay: 40 })
let badge = null
for (let i = 0; i < 40; i += 1) {
  badge = await fr().evaluate(() => {
    const el = document.querySelector('[data-testid="cloud-terminal-echo-latency"]')
    return el ? { text: el.textContent?.trim(), title: el.getAttribute('title') } : null
  })
  if (badge) break
  await sleep(400)
}
const badgeSamples = (t) => Number(/(\d+)\s*键/.exec(t ?? '')?.[1] ?? -1)
const samplesFirst = badgeSamples(badge?.title)
await fr()
  .locator('[data-testid="cloud-terminal-panel"]')
  .screenshot({ path: path.join(OUT, 'u94-u84-echo-badge.png') })
await page.keyboard.type('abcdefghijklmnopqrst', { delay: 40 })
let badge2 = badge
for (let i = 0; i < 40; i += 1) {
  badge2 = await fr().evaluate(() => {
    const el = document.querySelector('[data-testid="cloud-terminal-echo-latency"]')
    return el ? { text: el.textContent?.trim(), title: el.getAttribute('title') } : null
  })
  if (badgeSamples(badge2?.title) > samplesFirst) break
  await sleep(400)
}

// --- U83 resize follows ---
await page.setViewportSize({ width: 1280, height: 860 })
await sleep(1800)
const after = await measure()
const gapPaneAfter = +(after.pane.bottom - after.panel.bottom).toFixed(2)
const gapHostXtermAfter = +(after.host.bottom - after.xtermScreen.bottom).toFixed(2)
await fr()
  .locator('[data-testid="cloud-simple-workspace"]')
  .screenshot({ path: path.join(OUT, 'u94-u83-terminal-1280x860.png') })

result.checks.u83 = {
  at1600x1000: {
    ...before,
    gapPaneToPanelBottom: gapPane,
    gapHostToXtermBottom: gapHostXterm,
    xtermBox
  },
  at1280x860: {
    ...after,
    gapPaneToPanelBottom: gapPaneAfter,
    gapHostToXtermBottom: gapHostXtermAfter
  },
  filled: gapPane < (before.rowHeight ?? 17) && gapHostXterm < (before.rowHeight ?? 17),
  filledAfterResize:
    gapPaneAfter < (after.rowHeight ?? 17) && gapHostXtermAfter < (after.rowHeight ?? 17)
}
result.checks.u84 = {
  badgeFirst: badge,
  samplesFirst,
  badgeAfterMoreKeys: badge2,
  badgePresent: !!badge,
  badgeMatchesFormat: /^echo \d+ms p95$/.test(badge?.text ?? ''),
  titleHasP50P95MaxSamples: ['P50', 'P95', 'max', '键'].every((k) =>
    (badge?.title ?? '').includes(k)
  ),
  samplesIncreased: badgeSamples(badge2?.title) > samplesFirst
}

result.finishedAt = new Date().toISOString()
fs.writeFileSync(path.join(OUT, 'u94-verify.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
await browser.close()
