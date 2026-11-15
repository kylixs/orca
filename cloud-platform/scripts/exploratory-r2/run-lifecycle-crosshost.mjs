#!/usr/bin/env node
/**
 * U46 lifecycle / cross-host / permission-degradation exploration (r2).
 * Fresh browser contexts isolate the embed origin's persisted session so the
 * first-entry path and the re-entry path can both be measured.
 */
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const BASE = process.env.ORCA_QA_BASE || 'https://127.0.0.1:18787'
const OUT = path.resolve('cloud-platform/evidence/exploratory-r2')
const SHOTS = path.join(OUT, 'screenshots')
const WT1 = '/Users/gongdewei/orca-local-env/host/projects/demo-app/.orca-worktrees/admin/main-2'
const WT2 = '/Users/gongdewei/orca-local-env/host2/projects/infra-tools/.orca-worktrees/admin/main-3'
fs.mkdirSync(SHOTS, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const checks = []
const network = { handoffs: [], dialogs: [], consoleErrors: [], failures: [] }
let seq = 0
function check(area, name, ok, expected, actual, severity = 'P2', extra = {}) {
  const id = `L${String(++seq).padStart(3, '0')}`
  checks.push({ id, area, name, ok, expected, actual, severity: ok ? null : severity, ...extra })
  console.log(`${ok ? 'PASS' : 'FAIL'} [${area}] ${name} :: ${actual}`)
  return ok
}
const browser = await chromium.launch({ headless: true })
const frOf = (page) => page.frames().find((f) => f.url().includes('/cloud-admin.html'))
const tOf = (page, id) => frOf(page).locator(`[data-testid="${id}"]:visible`)

async function newSession(login, password) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } })
  const page = await context.newPage()
  page.setDefaultTimeout(20000)
  page.on('dialog', async (d) => {
    network.dialogs.push({ message: d.message(), type: d.type() })
    await d.accept().catch(() => {})
  })
  page.on('console', (m) => { if (m.type() === 'error') network.consoleErrors.push(m.text().slice(0, 200)) })
  page.on('pageerror', (e) => network.consoleErrors.push(`pageerror: ${e.message}`))
  page.on('request', (r) => { if (r.url().includes('/web-handoff')) network.handoffs.push({ url: r.url(), body: r.postData() }) })
  page.on('response', (r) => { if (r.status() >= 400) network.failures.push({ status: r.status(), url: r.url().slice(0, 160) }) })
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  if (await page.locator('#username').count()) {
    await page.fill('#username', login)
    await page.fill('#password', password)
    await page.click('button:has-text("登录")')
  }
  await page.waitForSelector('text=demo-app', { timeout: 20000 })
  return { context, page }
}

async function openProject(page, key) {
  await page.locator('tr', { hasText: key }).getByRole('button', { name: '打开', exact: true }).click()
  await page.locator('#workspaceOverlay iframe').waitFor({ timeout: 12000 })
  const started = Date.now()
  while (Date.now() - started < 25000) {
    const st = await page.evaluate(() => {
      const o = document.querySelector('#workspaceOverlay')
      return {
        ready: o?.querySelector('[data-workspace-status]')?.hidden === true,
        failure: !!o?.querySelector('[data-workspace-ready-failure]'),
        retry: !!o?.querySelector('[data-workspace-retry]'),
        route: o?.querySelector('[data-workspace-route]')?.textContent ?? '',
        dirty: o?.querySelector('[data-workspace-dirty]')?.textContent ?? ''
      }
    })
    if (st.ready || st.failure) {
      const f = frOf(page)
      const body = f ? await f.evaluate(() => document.body.innerText.slice(0, 300)).catch(() => '') : null
      return { ...st, body, frameUrl: f?.url() ?? null, ms: Date.now() - started }
    }
    await sleep(500)
  }
  return { timeout: true }
}

// ---------- Scenario 1: first entry, dirty close confirm, re-entry bug ----------
{
  const { context, page } = await newSession('admin', 'Adm1n!')
  const first = await openProject(page, 'demo-app')
  check('lifecycle', 'first entry reaches ready on the relay edge', first.ready === true && /直连|中继/.test(first.route), 'ready', JSON.stringify(first).slice(0, 400), 'P0')
  await page.screenshot({ path: path.join(SHOTS, 'r2-20-first-entry.png') })

  // terminal + dirty buffer so the close handshake and dirty confirm are live
  await tOf(page, 'cloud-simple-workspace-new-terminal').click()
  for (let i = 0; i < 60; i += 1) {
    const state = await frOf(page).evaluate(() => document.querySelector('[data-testid="cloud-terminal-state"]')?.textContent ?? '')
    if (state.includes('实时')) break
    await sleep(500)
  }
  const marker = path.join(WT1, 'docs/r2-terminal-marker')
  try { fs.unlinkSync(marker) } catch {}
  await frOf(page).locator('.xterm-screen:visible').first().click()
  await page.keyboard.type(`touch ${JSON.stringify(marker)}`, { delay: 5 })
  await page.keyboard.press('Enter')
  for (let i = 0; i < 30 && !fs.existsSync(marker); i += 1) await sleep(300)
  check('lifecycle', 'terminal runs a command on the host in the first entry', fs.existsSync(marker), 'marker file created', String(fs.existsSync(marker)), 'P1')

  await tOf(page, 'cloud-simple-workspace-right-tab-files').click()
  await frOf(page).evaluate(() => {
    const btn = document.querySelector('[data-testid="cloud-workspace-file-tree-node-README.md"]')
    btn?.click()
  })
  await frOf(page).locator('.monaco-editor:visible').first().waitFor({ timeout: 20000 })
  await sleep(500)
  await frOf(page).locator('.monaco-editor:visible .view-lines').first().click()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End')
  await page.keyboard.type('\nr2-close-confirm', { delay: 1 })
  await sleep(800)
  await page.waitForFunction(() => {
    const el = document.querySelector('#workspaceOverlay [data-workspace-dirty]')
    return el && el.hidden === false
  }, { timeout: 8000 }).catch(() => {})
  const dialogsBefore = network.dialogs.length
  await page.locator('#workspaceOverlay [data-workspace-close]').click()
  let removed = false
  for (let i = 0; i < 30; i += 1) {
    if ((await page.locator('#workspaceOverlay').count()) === 0) { removed = true; break }
    await sleep(200)
  }
  const dialogs = network.dialogs.slice(dialogsBefore)
  check('lifecycle', 'close with a dirty buffer asks before discarding', dialogs.some((d) => /未保存/.test(d.message)), 'confirm mentions unsaved files', JSON.stringify(dialogs), 'P1')
  check('lifecycle', 'close handshake removes the overlay', removed, 'overlay removed', String(removed), 'P0')
  execFileSync('git', ['checkout', '--', 'README.md'], { cwd: WT1 })

  // re-entry in the same browser profile (the persisted embed session remains)
  const second = await openProject(page, 'demo-app')
  check('lifecycle', 're-entry after close reaches ready again', second.ready === true, 'ready', JSON.stringify(second).slice(0, 400), 'P0')
  await page.screenshot({ path: path.join(SHOTS, 'r2-21-reentry.png') })
  if (second.failure) {
    const retryVisible = second.retry
    await page.locator('#workspaceOverlay [data-workspace-retry]').click()
    // the retry re-mints the handoff and rebuilds the iframe; only the outcome matters
    let retryState = null
    for (let i = 0; i < 50; i += 1) {
      const st = await page.evaluate(() => {
        const o = document.querySelector('#workspaceOverlay')
        return { ready: o?.querySelector('[data-workspace-status]')?.hidden === true, failure: !!o?.querySelector('[data-workspace-ready-failure]'), retry: !!o?.querySelector('[data-workspace-retry]') }
      })
      if (st.ready || st.failure) { retryState = st; break }
      await sleep(500)
    }
    check('lifecycle', 'failure-state retry recovers the workspace', retryState?.ready === true, 'retry reaches ready', JSON.stringify({ retryVisible, retryState }), 'P0')
    await page.screenshot({ path: path.join(SHOTS, 'r2-22-retry.png') })
  }
  await page.locator('#workspaceOverlay [data-workspace-close]').click().catch(() => {})
  await sleep(500)

  // second, different project in the same profile
  const other = await openProject(page, 'infra-tools')
  check('lifecycle', 'opening a different project after close reaches ready', other.ready === true, 'ready', JSON.stringify(other).slice(0, 400), 'P0')
  await page.screenshot({ path: path.join(SHOTS, 'r2-23-second-project.png') })

  // The documented escape hatch still works from the failure shell
  const failureOpen = (await page.locator('#workspaceOverlay [data-workspace-ready-failure]').count()) > 0
  if (failureOpen) {
    const popupPromise = page.waitForEvent('popup', { timeout: 10000 }).catch(() => null)
    await page.locator('#workspaceOverlay [data-workspace-new-tab]').click()
    const popup = await popupPromise
    check('lifecycle', 'failure shell still offers 在新标签打开 Orca Web', !!popup && (popup.url() || '').includes('web-index.html'), 'new tab web-index', popup?.url() ?? 'no popup', 'P1')
    await popup?.close().catch(() => {})
  }
  await context.close()
}

// ---------- Scenario 2: cross-host first entry (dev-local-03) ----------
{
  const { context, page } = await newSession('admin', 'Adm1n!')
  const first = await openProject(page, 'infra-tools')
  check('cross-host', 'first entry on dev-local-03 reaches ready', first.ready === true, 'ready', JSON.stringify(first).slice(0, 400), 'P0')
  const status = await tOf(page, 'cloud-simple-workspace-status-bar').innerText()
  check('cross-host', 'status bar names infra-tools and the host2 checkout', /infra-tools/.test(status) && /host2/.test(status), 'infra-tools + host2 path', status.replaceAll('\n', ' | '), 'P1')
  // open runbook
  await frOf(page).evaluate(() => {
    document.querySelector('[data-testid="cloud-workspace-file-tree-node-docs"]')?.click()
  })
  await sleep(600)
  await frOf(page).evaluate(() => {
    document.querySelector('[data-testid="cloud-workspace-file-tree-node-docs/runbook.md"]')?.click()
  })
  await frOf(page).locator('.monaco-editor:visible').first().waitFor({ timeout: 20000 })
  const editorPath = await tOf(page, 'cloud-workspace-file-tab-path').innerText()
  check('cross-host', 'host2 file opens in the editor', editorPath === 'docs/runbook.md', 'docs/runbook.md', editorPath, 'P1')
  // terminal on host2
  await tOf(page, 'cloud-simple-workspace-new-terminal').click()
  for (let i = 0; i < 60; i += 1) {
    const state = await frOf(page).evaluate(() => document.querySelector('[data-testid="cloud-terminal-state"]')?.textContent ?? '')
    if (state.includes('实时')) break
    await sleep(500)
  }
  const marker = path.join(WT2, 'docs/r2-terminal-marker')
  try { fs.unlinkSync(marker) } catch {}
  await frOf(page).locator('.xterm-screen:visible').first().click()
  await page.keyboard.type(`touch ${JSON.stringify(marker)}`, { delay: 5 })
  await page.keyboard.press('Enter')
  for (let i = 0; i < 30 && !fs.existsSync(marker); i += 1) await sleep(300)
  check('cross-host', 'host2 terminal runs a command', fs.existsSync(marker), 'marker created on host2', String(fs.existsSync(marker)), 'P1')
  const branch = await tOf(page, 'cloud-simple-workspace-status-branch').innerText()
  check('cross-host', 'host2 branch reported by workspace.info', branch.length > 0, 'branch text', branch, 'P2')
  await page.screenshot({ path: path.join(SHOTS, 'r2-24-crosshost-first.png') })
  await context.close()
}

// ---------- Scenario 3: read-only viewer (lisi: open + file:read, no terminal) ----------
{
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } })
  const page = await context.newPage()
  page.setDefaultTimeout(20000)
  page.on('dialog', (d) => d.accept())
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await page.fill('#username', 'lisi')
  await page.fill('#password', 'Passw0rd!')
  await page.click('button:has-text("登录")')
  await page.waitForSelector('text=demo-app', { timeout: 20000 })
  await page.locator('tr', { hasText: 'demo-app' }).getByRole('button', { name: '打开', exact: true }).click()
  await page.waitForTimeout(9000)
  const state = await page.evaluate(() => {
    const o = document.querySelector('#workspaceOverlay')
    return { overlay: !!o, body: o?.querySelector('.workspace-body')?.innerText?.slice(0, 400) ?? '', failure: !!o?.querySelector('[data-workspace-ready-failure]') }
  })
  const f = frOf(page)
  const frameBody = f ? await f.evaluate(() => document.body.innerText.slice(0, 400)).catch(() => '') : ''
  check('permissions', 'viewer without terminal gets an explicit degradation page', /未授予终端权限|无法创建工作区|NOT_AUTHORIZED|NOT_CONNECTED|permission/i.test(`${state.body} ${frameBody}`), 'explicit permission copy', JSON.stringify({ state, frameBody }).slice(0, 500), 'P1')
  await page.screenshot({ path: path.join(SHOTS, 'r2-25-lisi-viewer.png') })
  await context.close()
}

// ---------- Scenario 4: rapid first-entry clicks ----------
{
  const { context, page } = await newSession('admin', 'Adm1n!')
  const before = network.handoffs.length
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('tr')].find((tr) => tr.innerText.includes('demo-app'))
    const btn = [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === '打开')
    for (let i = 0; i < 5; i += 1) btn.click()
  })
  await sleep(6000)
  const overlays = await page.locator('#workspaceOverlay').count()
  const handoffs = network.handoffs.length - before
  const state = await page.evaluate(() => {
    const o = document.querySelector('#workspaceOverlay')
    return { iframes: o ? o.querySelectorAll('iframe').length : 0, ready: o?.querySelector('[data-workspace-status]')?.hidden === true }
  })
  check('boundary', 'five rapid clicks keep a single overlay', overlays === 1 && state.iframes === 1, 'one overlay/one iframe', JSON.stringify({ overlays, handoffs, state }), 'P1')
  check('boundary', 'five rapid clicks mint only one handoff code', handoffs === 1, '1 POST', String(handoffs), 'P2')
  await page.screenshot({ path: path.join(SHOTS, 'r2-26-rapid-click.png') })
  await context.close()
}

fs.writeFileSync(path.join(OUT, 'workspace-lifecycle.json'), JSON.stringify({
  feature: 'U46 embedded simple workspace — lifecycle / cross-host / permission (r2)',
  generatedAt: new Date().toISOString(),
  checks,
  network,
  findings: checks.filter((c) => !c.ok).map((c) => ({ checkId: c.id, severity: c.severity, area: c.area, title: c.name, expected: c.expected, actual: c.actual }))
}, null, 2))
console.log(`written lifecycle json; checks=${checks.length} failures=${checks.filter((c) => !c.ok).length}`)
await browser.close()
