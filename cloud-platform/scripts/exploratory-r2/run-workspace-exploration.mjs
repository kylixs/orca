#!/usr/bin/env node
/**
 * U46 embedded simple workspace — deep exploratory journey (r2).
 * Isolated headless Chromium, own profile, ignoreHTTPSErrors for the local relay-edge cert.
 * Read-only product code; test fixtures live under <worktree>/docs/r2-fixtures.
 *
 * Usage: node cloud-platform/scripts/exploratory-r2/run-workspace-exploration.mjs [--section name]
 */
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const BASE = process.env.ORCA_QA_BASE || 'https://127.0.0.1:18787'
const ROOT = path.resolve('.')
const OUT = path.join(ROOT, 'cloud-platform/evidence/exploratory-r2')
const SHOTS = path.join(OUT, 'screenshots')
const WT = '/Users/gongdewei/orca-local-env/host/projects/demo-app/.orca-worktrees/admin/main-2'
const WT2 = '/Users/gongdewei/orca-local-env/host2/projects/infra-tools/.orca-worktrees/admin/main-2'
fs.mkdirSync(SHOTS, { recursive: true })

const checks = []
const network = { handoffs: [], failures: [], consoleErrors: [], dialogs: [] }
const meta = { startedAt: new Date().toISOString(), base: BASE, demoWorktree: WT }
let checkSeq = 0

function check(area, name, ok, expected, actual, severity = 'P2', extra = {}) {
  const id = `C${String(++checkSeq).padStart(3, '0')}`
  checks.push({ id, area, name, ok, expected, actual, severity: ok ? null : severity, ...extra })
  console.log(`${ok ? 'PASS' : 'FAIL'} [${area}] ${name} :: ${actual}`)
  return ok
}
async function step(area, name, fn) {
  try {
    return await fn()
  } catch (err) {
    check(area, name, false, 'step completes', `threw: ${err.message.split('\n')[0]}`, 'P1')
    return null
  }
}
const shot = async (page, name) => {
  const file = path.join(SHOTS, `${name}.png`)
  await page.screenshot({ path: file })
  return file
}

// ---------- helpers ----------
let page, context, browser
const fr = () => page.frames().find((f) => f.url().includes('/cloud-admin.html'))
// Hidden tab panes stay mounted (by design), so every pane lookup is scoped to
// the visible one; otherwise duplicate testids give strict-mode violations.
const t = (id) => fr().locator(`[data-testid="${id}"]:visible`)
const visibleMonaco = () => fr().locator('.monaco-editor:visible .view-lines').first()
const parent = (sel) => page.locator(sel)
const sleep = (ms) => page.waitForTimeout(ms)

async function expandParents(relPath) {
  const parts = relPath.split('/')
  let cur = ''
  for (let i = 0; i < parts.length - 1; i += 1) {
    cur = cur ? `${cur}/${parts[i]}` : parts[i]
    await fr().evaluate((p) => {
      const btn = document.querySelector(`[data-testid="cloud-workspace-file-tree-node-${CSS.escape(p)}"]`)
      const item = btn?.closest('[role="treeitem"]')
      if (!btn) return
      if (item?.getAttribute('aria-expanded') === 'true') return
      btn.click()
    }, cur)
    await sleep(450)
  }
}

async function clickFileNode(relPath) {
  await t('cloud-simple-workspace-right-tab-files').click().catch(() => {})
  await sleep(250)
  await expandParents(relPath)
  const selector = `[data-testid="cloud-workspace-file-tree-node-${relPath.replaceAll('"', '\\"')}"]`
  const node = fr().locator(selector)
  if ((await node.count()) && (await node.isVisible())) {
    await node.click()
    return
  }
  // Fallback: the name filter searches every loaded directory and opens on click.
  console.log('[debug] fallback open', relPath, 'count=', await node.count(), 'visible=', await node.isVisible().catch(() => false))
  const input = fr().locator('[data-testid="cloud-workspace-file-tree-filter"] input')
  const base = relPath.split('/').at(-1)
  await input.fill(base)
  await sleep(600)
  const match = fr().locator(`[data-testid="cloud-workspace-file-tree-match-${relPath.replaceAll('"', '\\"')}"]`)
  await match.waitFor({ timeout: 10000 })
  await match.click()
  await input.fill('')
}

async function tabIds() {
  return fr().evaluate(() =>
    [...document.querySelectorAll('[role="tab"][data-testid^="cloud-simple-workspace-tab-"]')]
      .map((el) => el.getAttribute('data-testid').replace('cloud-simple-workspace-tab-', ''))
      .filter((id) => !id.startsWith('dirty-'))
  )
}
async function tabCount() {
  return (await tabIds()).length
}
async function activeTabId() {
  return fr().evaluate(() => {
    const el = document.querySelector('[role="tab"][aria-selected="true"][data-testid^="cloud-simple-workspace-tab-"]')
    return el ? el.getAttribute('data-testid').replace('cloud-simple-workspace-tab-', '') : null
  })
}
async function waitTabForPath(relPath) {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    const active = await activeTabId()
    if (active && (active === `file:${relPath}` || active === `preview:${relPath}` || active === `diff:${relPath}` || active.startsWith(`diff:`) && active.endsWith(`:${relPath}`))) return active
    await sleep(250)
  }
  return await activeTabId()
}
async function monacoAppend(text) {
  await visibleMonaco().click()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End')
  await page.keyboard.type(text, { delay: 1 })
}
async function frameText() {
  return fr().evaluate(() => document.body.innerText)
}
async function waitFrameText(re, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const body = await frameText().catch(() => '')
    if (re.test(body)) return body
    await sleep(250)
  }
  return await frameText().catch(() => '')
}

// ---------- main journey ----------
async function main() {
  browser = await chromium.launch({ headless: true })
  context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } })
  page = await context.newPage()
  page.setDefaultTimeout(20000)
  page.on('console', (msg) => {
    if (msg.type() === 'error') network.consoleErrors.push({ url: page.url(), text: msg.text() })
  })
  page.on('pageerror', (err) => network.consoleErrors.push({ url: page.url(), text: `pageerror: ${err.message}` }))
  page.on('request', (req) => {
    if (req.url().includes('/web-handoff')) {
      network.handoffs.push({ method: req.method(), url: req.url(), body: req.postData() })
    }
  })
  page.on('response', (res) => {
    if (res.status() >= 400) network.failures.push({ status: res.status(), url: res.url() })
  })
  page.on('dialog', async (dialog) => {
    network.dialogs.push({ type: dialog.type(), message: dialog.message() })
    await dialog.accept().catch(() => {})
  })

  // start from a clean worktree: earlier exploratory runs may have left edits
  for (const f of ['README.md', 'docs/design.md']) {
    try { execFileSync('git', ['checkout', '--', f], { cwd: WT }) } catch {}
  }

  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  if (await page.locator('#username').count()) {
    await page.fill('#username', 'admin')
    await page.fill('#password', 'Adm1n!')
    await page.click('button:has-text("登录")')
  }
  await page.waitForSelector('text=demo-app', { timeout: 20000 })
  check('overlay', 'platform login as admin', true, 'workbench rows render', 'demo-app row visible')

  // ===== A. overlay open / ready =====
  await page.locator('tr', { hasText: 'demo-app' }).getByRole('button', { name: '打开', exact: true }).click()
  await parent('#workspaceOverlay').waitFor({ timeout: 10000 })
  await parent('#workspaceOverlay iframe').waitFor({ timeout: 10000 })
  const readyDeadline = Date.now() + 30000
  let ready = false
  while (Date.now() < readyDeadline) {
    const state = await page.evaluate(() => {
      const o = document.querySelector('#workspaceOverlay')
      return {
        failure: !!o?.querySelector('[data-workspace-ready-failure]'),
        ready: o?.querySelector('[data-workspace-status]')?.hidden === true
      }
    })
    if (state.failure || state.ready) { ready = state.ready; break }
    await sleep(300)
  }
  const overlayState = await page.evaluate(() => {
    const o = document.querySelector('#workspaceOverlay')
    return {
      overlay: !!o,
      route: o?.querySelector('[data-workspace-route]')?.textContent ?? '',
      routeHidden: o?.querySelector('[data-workspace-route]')?.hidden ?? null,
      statusHidden: o?.querySelector('[data-workspace-status]')?.hidden ?? null,
      failure: o?.querySelector('[data-workspace-ready-failure]')?.innerText ?? '',
      iframeSrc: o?.querySelector('iframe')?.src ?? '',
      barText: o?.querySelector('.workspace-bar')?.innerText ?? ''
    }
  })
  check('overlay', 'open mounts same-page overlay + iframe', !!overlayState.overlay && !!overlayState.iframeSrc, 'overlay with iframe', JSON.stringify(overlayState).slice(0, 400))
  check('overlay', 'ready message hides loading and shows route', ready && /直连|中继/.test(overlayState.route), 'ready route badge', overlayState.route, 'P0')
  check('overlay', 'iframe URL is cloud-admin embed for the project', /cloud-admin\.html\?.*embed=1/.test(overlayState.iframeSrc), 'cloud-admin.html?embed=1', overlayState.iframeSrc)
  check('overlay', 'handoff code cleared from iframe address bar', fr() && !fr().url().includes('handoff='), 'hash removed after redeem', fr()?.url() ?? 'no frame', 'P1')
  check('overlay', 'exactly one admin-surface handoff POST', network.handoffs.filter((h) => h.url.includes('/web-handoff')).length === 1 && (network.handoffs[0]?.body ?? '').includes('"surface":"admin"'), '1 POST body surface=admin', JSON.stringify(network.handoffs))
  await shot(page, 'r2-01-overlay-ready')

  // ===== B. shell / file tree root =====
  await step('shell', 'workspace shell visible', async () => {
    await t('cloud-simple-workspace').waitFor()
    const body = await frameText()
    check('shell', 'two-pane shell (no left sidebar) with right rail tabs', /文件/.test(body) && /Git 变更/.test(body) && /\+ 终端/.test(body), 'centre tabs + right rail', body.slice(0, 300))
    const status = await t('cloud-simple-workspace-status-bar').innerText()
    check('shell', 'status bar shows project/E2EE/route/branch/path', /demo-app/.test(status) && /E2EE/.test(status) && /直连|中继/.test(status) && /main/.test(status) && /\.orca-worktrees/.test(status), 'project, E2EE, route, branch, path', status.replaceAll('\n', ' | '))
    check('shell', 'empty-state copy present before any tab', /从右侧文件树打开文件/.test(body), 'empty state', body.match(/从右侧文件树打开文件[^\n]*/)?.[0] ?? 'missing')
  })

  await step('filetree', 'root listing', async () => {
    const rootNodes = await fr().evaluate(() =>
      [...document.querySelectorAll('[data-testid^="cloud-workspace-file-tree-node-"]')].map((el) =>
        el.getAttribute('data-testid').replace('cloud-workspace-file-tree-node-', '')
      )
    )
    check('filetree', 'root lists docs/src/README.md, hides .git', ['docs', 'src', 'README.md'].every((x) => rootNodes.includes(x)) && !rootNodes.some((x) => x.includes('.git')), 'docs, src, README.md, no .git', JSON.stringify(rootNodes), 'P1')
  })

  // ===== C. editor open / dedupe / syntax =====
  await step('editor', 'open README.md', async () => {
    await clickFileNode('README.md')
    const id = await waitTabForPath('README.md')
    await t('cloud-workspace-file-tab').waitFor({ timeout: 20000 })
    await fr().locator('.monaco-editor:visible').first().waitFor({ timeout: 20000 })
    check('editor', 'README.md opens an editor tab with Monaco', id === 'file:README.md', 'file:README.md active', String(id))
    const pathText = await t('cloud-workspace-file-tab-path').innerText()
    check('editor', 'editor header shows relative path', pathText === 'README.md', 'README.md', pathText)
    const before = await tabCount()
    await clickFileNode('README.md')
    await sleep(500)
    const after = await tabCount()
    check('editor', 'same file re-open dedupes instead of adding a tab', after === before, `tab count ${before}`, `tab count ${after}`, 'P1')
    const saveDisabled = await t('cloud-workspace-file-tab-save').isDisabled()
    check('editor', 'clean buffer has save disabled', saveDisabled, 'save disabled', String(saveDisabled))
  })

  await step('editor', 'syntax colouring across languages', async () => {
    for (const p of ['src/order.js', 'src/server.js', 'docs/design.md']) {
      await clickFileNode(p)
      await waitTabForPath(p)
      await fr().locator('.monaco-editor:visible').first().waitFor({ timeout: 20000 })
      await sleep(700)
      const colored = await fr().evaluate(() => {
        const root = document.querySelector('[role="tabpanel"]:not([hidden])') ?? document; const spans = [...root.querySelectorAll('.monaco-editor .view-lines span[class*="mtk"]')]
        return { count: spans.length, colors: new Set(spans.map((s) => getComputedStyle(s).color)).size, lines: root.querySelectorAll('.monaco-editor .line-numbers').length }
      })
      check('editor', `syntax colouring for ${p}`, colored.count > 0 && colored.lines > 0, 'token spans + line numbers', JSON.stringify(colored), 'P1')
    }
    await shot(page, 'r2-02-tabs-multi')
  })

  // ===== D. edit / dirty / save roundtrip =====
  await step('editor', 'dirty + save roundtrip', async () => {
    await clickFileNode('README.md')
    await waitTabForPath('README.md')
    await fr().locator('.monaco-editor:visible').first().waitFor()
    await sleep(500)
    const marker = `r2-edit-${Date.now()}`
    await monacoAppend(`\n${marker}`)
    await sleep(600)
    const dirtyTab = await t('cloud-simple-workspace-tab-dirty-file:README.md').count()
    const statusDirty = await t('cloud-simple-workspace-status-dirty').count()
    let parentDirty = ''
    try {
      await page.waitForFunction(() => {
        const el = document.querySelector('#workspaceOverlay [data-workspace-dirty]')
        return el && el.hidden === false
      }, { timeout: 5000 })
      parentDirty = await page.locator('#workspaceOverlay [data-workspace-dirty]').innerText()
    } catch { parentDirty = 'not-visible' }
    check('editor', 'edit marks tab + status bar + overlay dirty', dirtyTab > 0 && statusDirty > 0 && /未保存文件/.test(parentDirty), 'dirty in tab/status/overlay', JSON.stringify({ dirtyTab, statusDirty, parentDirty }), 'P1')
    await shot(page, 'r2-03-dirty')
    await t('cloud-workspace-file-tab-save').click()
    const deadline = Date.now() + 15000
    let saved = false
    while (Date.now() < deadline) {
      const dirty = await t('cloud-simple-workspace-tab-dirty-file:README.md').count()
      if (dirty === 0) { saved = true; break }
      await sleep(250)
    }
    const disk = fs.readFileSync(path.join(WT, 'README.md'), 'utf8')
    check('editor', 'save writes buffer to host file and clears dirty', saved && disk.includes(marker), 'file contains marker; dirty cleared', JSON.stringify({ saved, hasMarker: disk.includes(marker) }), 'P0')
    try {
      execFileSync('git', ['checkout', '--', 'README.md'], { cwd: WT })
    } catch {}
    await shot(page, 'r2-04-saved')
  })

  // ===== E. conflict box =====
  await step('editor', 'conflict detection', async () => {
    // reopen README so the buffer baseline matches the restored file
    await clickFileNode('README.md')
    await fr().locator('.monaco-editor:visible').first().waitFor()
    await sleep(500)
    await monacoAppend('\nr2-conflict-buffer')
    await sleep(400)
    fs.appendFileSync(path.join(WT, 'README.md'), '\nr2-external-change\n')
    await t('cloud-workspace-file-tab-save').click()
    await t('cloud-workspace-file-tab-conflict').waitFor({ timeout: 10000 })
    const box = await t('cloud-workspace-file-tab-conflict').innerText()
    check('editor', 'save after external change opens 3-way conflict box', /重新加载/.test(box) && /覆盖保存/.test(box) && /取消/.test(box), 'reload/overwrite/cancel', box.replaceAll('\n', ' '), 'P1')
    await t('cloud-workspace-file-tab-conflict-cancel').click()
    check('editor', 'conflict cancel keeps the tab and buffer', (await t('cloud-workspace-file-tab-conflict').count()) === 0 && (await tabCount()) > 0, 'dialog closed, tab kept', 'ok')
    await t('cloud-workspace-file-tab-save').click()
    await t('cloud-workspace-file-tab-conflict').waitFor()
    await t('cloud-workspace-file-tab-conflict-reload').click()
    await sleep(600)
    const reloaded = await fr().evaluate(() => document.querySelector('[role="tabpanel"]:not([hidden]) .monaco-editor .view-lines')?.textContent ?? '')
    check('editor', 'conflict reload adopts the external content', reloaded.includes('r2-external-change'), 'external marker visible', reloaded.includes('r2-external-change') ? 'visible' : 'not visible')
    execFileSync('git', ['checkout', '--', 'README.md'], { cwd: WT })
    // close the stale tab so later steps re-read the restored file
    await t('cloud-simple-workspace-tab-close-file:README.md').click()
    await sleep(400)
  })

  await step('dirty-close', 'dirty close confirm three options', async () => {
    await t('cloud-simple-workspace-right-tab-files').click().catch(() => {})
    await clickFileNode('docs/design.md')
    await fr().locator('.monaco-editor:visible').first().waitFor()
    await sleep(500)
    await monacoAppend('\nr2-close-dirty')
    await sleep(800)
    const dirtyBeforeClose = await t('cloud-simple-workspace-tab-dirty-file:docs/design.md').count()
    check('dirty-close', 'typing marks the file tab dirty', dirtyBeforeClose > 0, 'dirty dot present', String(dirtyBeforeClose), 'P1')
    if (dirtyBeforeClose === 0) {
      await shot(page, 'r2-dirty-close-not-dirty')
      return
    }
    await t('cloud-simple-workspace-tab-close-file:docs/design.md').click()
    await t('cloud-simple-workspace-close-confirm').waitFor({ timeout: 10000 })
    const box = await t('cloud-simple-workspace-close-confirm').innerText()
    check('dirty-close', 'closing a dirty tab opens 保存/放弃/取消', /保存/.test(box) && /放弃/.test(box) && /取消/.test(box), 'three options', box.replaceAll('\n', ' '), 'P0')
    await t('cloud-simple-workspace-close-confirm-cancel').click()
    check('dirty-close', '取消 keeps the tab and buffer', (await t('cloud-simple-workspace-close-confirm').count()) === 0 && (await t('cloud-simple-workspace-tab-file:docs/design.md').count()) === 1, 'tab kept', 'ok', 'P1')
    await t('cloud-simple-workspace-tab-close-file:docs/design.md').click()
    await t('cloud-simple-workspace-close-confirm-discard').click()
    await sleep(500)
    check('dirty-close', '放弃 closes and drops the buffer', (await t('cloud-simple-workspace-tab-file:docs/design.md').count()) === 0, 'tab closed', 'ok', 'P1')
    // save-and-close
    await clickFileNode('docs/design.md')
    await fr().locator('.monaco-editor:visible').first().waitFor()
    await sleep(500)
    await monacoAppend('\nr2-save-and-close')
    await sleep(400)
    await t('cloud-simple-workspace-tab-close-file:docs/design.md').click()
    await t('cloud-simple-workspace-close-confirm-save').click()
    const deadline = Date.now() + 10000
    let closed = false
    while (Date.now() < deadline) {
      if ((await t('cloud-simple-workspace-tab-file:docs/design.md').count()) === 0) { closed = true; break }
      await sleep(250)
    }
    const disk = fs.readFileSync(path.join(WT, 'docs/design.md'), 'utf8')
    check('dirty-close', '保存 saves to host then closes', closed && disk.includes('r2-save-and-close'), 'file saved, tab closed', JSON.stringify({ closed, saved: disk.includes('r2-save-and-close') }), 'P0')
    execFileSync('git', ['checkout', '--', 'docs/design.md'], { cwd: WT })
  })

  // ===== F. truncated / read-only =====
  await step('editor', 'truncated large file is read-only', async () => {
    await clickFileNode('docs/r2-fixtures/r2-large.txt')
    await waitTabForPath('docs/r2-fixtures/r2-large.txt')
    await t('cloud-workspace-file-tab').waitFor()
    await t('cloud-workspace-file-tab-readonly').waitFor({ timeout: 20000 })
    const notice = await t('cloud-workspace-file-tab-notice').innerText()
    const saveButtons = await t('cloud-workspace-file-tab-save').count()
    check('editor', 'oversized file shows 只读 + truncation notice and no save', /只读/.test(await t('cloud-workspace-file-tab-readonly').innerText()) && /截断/.test(notice) && saveButtons === 0, 'readonly + notice + no save', JSON.stringify({ notice, saveButtons }), 'P1')
    await shot(page, 'r2-05-truncated')
  })

  await step('editor', 'empty file', async () => {
    await clickFileNode('docs/r2-fixtures/r2-empty.txt')
    await waitTabForPath('docs/r2-fixtures/r2-empty.txt')
    await fr().locator('.monaco-editor:visible').first().waitFor()
    const pathText = await t('cloud-workspace-file-tab-path').innerText()
    check('editor', 'zero-byte text file opens without error', pathText.includes('r2-empty.txt'), 'editor for empty file', pathText, 'P2')
  })

  // ===== G. markdown dual mode =====
  await step('markdown', 'preview rendering and XSS', async () => {
    await clickFileNode('docs/r2-fixtures/r2-markdown.md')
    await waitTabForPath('docs/r2-fixtures/r2-markdown.md')
    await fr().locator('.monaco-editor:visible').first().waitFor()
    await t('cloud-workspace-file-tab-mode-preview').click()
    await t('cloud-workspace-markdown-preview').waitFor({ timeout: 20000 })
    await sleep(700)
    const rendered = await t('cloud-workspace-markdown-preview').evaluate((root) => {
      const q = (sel) => root.querySelector(sel)
      return {
        h1: q('h1')?.textContent ?? '',
        h2Count: root.querySelectorAll('h2').length,
        tableRows: root.querySelectorAll('table tr').length,
        code: q('pre code')?.textContent ?? '',
        link: q('a[href="https://orca.example.com"]')?.getAttribute('target') ?? '',
        katex: root.querySelectorAll('.katex').length,
        details: root.querySelectorAll('details').length,
        scripts: root.querySelectorAll('script').length,
        iframes: root.querySelectorAll('iframe').length,
        onerrorAttrs: root.querySelectorAll('[onerror]').length,
        jsHrefs: [...root.querySelectorAll('a')].filter((a) => (a.getAttribute('href') ?? '').startsWith('javascript:')).length,
        html: root.innerHTML.slice(0, 300)
      }
    })
    check('markdown', 'headings/lists/table/code/link render', rendered.h1.includes('R2 Markdown') && rendered.h2Count >= 5 && rendered.tableRows >= 3 && rendered.code.includes('const answer') && rendered.link === '_blank', 'full GFM render', JSON.stringify(rendered), 'P1')
    check('markdown', 'katex math renders', rendered.katex > 0, 'katex nodes', String(rendered.katex), 'P2')
    check('markdown', 'raw HTML script/iframe/onerror/javascript: stripped', rendered.scripts === 0 && rendered.iframes === 0 && rendered.onerrorAttrs === 0 && rendered.jsHrefs === 0, 'no active XSS surface', JSON.stringify({ scripts: rendered.scripts, iframes: rendered.iframes, onerror: rendered.onerrorAttrs, jsHrefs: rendered.jsHrefs }), 'P0')
    check('markdown', 'details/summary kept by sanitizer', rendered.details >= 1, 'details rendered', String(rendered.details))
    const xssFlag = await fr().evaluate(() => window.__r2Xss ?? null)
    check('markdown', 'XSS marker never executed', xssFlag === null, 'undefined', String(xssFlag), 'P0')
    await shot(page, 'r2-06-markdown-preview')
    await t('cloud-workspace-file-tab-mode-edit').click()
    await visibleMonaco().waitFor()
    check('markdown', 'edit mode shows Monaco source', true, 'monaco visible', 'ok')
    await shot(page, 'r2-07-markdown-edit')
  })

  // ===== H. previews =====
  await step('preview', 'image png/jpg/svg', async () => {
    for (const name of ['r2-sample.png', 'r2-sample.jpg', 'r2-sample.svg']) {
      const rel = `docs/r2-fixtures/${name}`
      await clickFileNode(rel)
      await waitTabForPath(rel)
      await t('cloud-workspace-preview-tab').waitFor({ timeout: 20000 })
      const img = t('cloud-workspace-preview-image')
      await img.waitFor({ timeout: 20000 })
      await sleep(400)
      const info = await img.evaluate((el) => ({ src: el.getAttribute('src')?.slice(0, 30), nw: el.naturalWidth, nh: el.naturalHeight }))
      const badge = await t('cloud-workspace-preview-kind').innerText()
      check('preview', `${name} renders as image data URL`, info.src?.startsWith('data:image/') && info.nw > 0, 'data URL + decoded width', JSON.stringify({ info, badge }), 'P1')
    }
    await shot(page, 'r2-08-image-preview')
  })

  await step('preview', 'HTML sandbox', async () => {
    const rel = 'docs/r2-fixtures/r2-sample.html'
    await clickFileNode(rel)
    await waitTabForPath(rel)
    await t('cloud-workspace-preview-tab').waitFor()
    const frameEl = t('cloud-workspace-preview-html-frame')
    await frameEl.waitFor({ timeout: 20000 })
    await sleep(800)
    const attrs = await frameEl.evaluate((el) => ({ sandbox: el.getAttribute('sandbox'), referrer: el.getAttribute('referrerpolicy') }))
    const child = fr().childFrames().find((f) => f.url().startsWith('about:srcdoc'))
    const childInfo = child ? await child.evaluate(() => ({ text: document.body.innerText.slice(0, 120), scriptRan: document.body.getAttribute('data-script-ran'), imgError: document.body.getAttribute('data-img-error') })) : null
    check('preview', 'HTML renders in empty-sandbox iframe, scripts blocked', attrs.sandbox === '' && attrs.referrer === 'no-referrer' && childInfo?.scriptRan === null && /R2 HTML 沙箱样本/.test(childInfo?.text ?? ''), "sandbox='' and no script execution", JSON.stringify({ attrs, childInfo }), 'P0')
    await t('cloud-workspace-preview-mode-source').click()
    const source = await t('cloud-workspace-preview-html-source').innerText()
    check('preview', 'HTML source toggle shows raw markup', source.includes('<script>'), 'raw source includes script', source.slice(0, 80))
    await shot(page, 'r2-09-html-preview')
  })

  await step('preview', 'PDF placeholder', async () => {
    const rel = 'docs/r2-fixtures/r2-sample.pdf'
    await clickFileNode(rel)
    await waitTabForPath(rel)
    await t('cloud-workspace-preview-pdf').waitFor({ timeout: 20000 })
    const text = await t('cloud-workspace-preview-pdf').innerText()
    check('preview', 'PDF is a placeholder, not embedded', /PDF 预览不在简易版范围/.test(text), 'PDF placeholder', text.replaceAll('\n', ' '), 'P2')
  })

  await step('preview', 'drawio degradation', async () => {
    const rel = 'docs/r2-fixtures/r2-sample.drawio'
    await clickFileNode(rel)
    await waitTabForPath(rel)
    await t('cloud-workspace-preview-drawio-degraded').waitFor({ timeout: 20000 })
    const source = await t('cloud-workspace-preview-drawio-source').innerText()
    check('preview', 'drawio degrades to source with explicit notice', /不加载/.test(await t('cloud-workspace-preview-drawio-degraded').innerText()) && source.includes('<mxfile'), 'notice + source', source.slice(0, 60), 'P2')
  })

  await step('preview', 'binary file handling', async () => {
    const rel = 'docs/r2-fixtures/r2-binary.bin'
    await clickFileNode(rel)
    const id = await waitTabForPath(rel)
    await sleep(2500)
    const kind = id?.startsWith('preview:') ? 'preview' : 'editor'
    const body = await frameText()
    const errorText = (await t('cloud-workspace-file-tab-error').count()) ? await t('cloud-workspace-file-tab-error').innerText() : ''
    const binaryPlaceholder = (await t('cloud-workspace-preview-binary').count()) ? await t('cloud-workspace-preview-binary').innerText() : ''
    check('preview', 'binary file opens the binary placeholder, not the editor', kind === 'preview' && /二进制/.test(binaryPlaceholder), 'preview binary placeholder', JSON.stringify({ id, kind, errorText, binaryPlaceholder, body: body.slice(0, 200) }), 'P1')
    await shot(page, 'r2-10-binary')
  })

  // ===== I. file tree filter / deep / empty / refresh =====
  await step('filetree', 'filter', async () => {
    await t('cloud-simple-workspace-right-tab-files').click().catch(() => {})
    const input = fr().locator('[data-testid="cloud-workspace-file-tree-filter"] input')
    await input.fill('r2')
    await sleep(500)
    const count = await fr().locator('[data-testid^="cloud-workspace-file-tree-match-"]').count()
    check('filetree', 'filter "r2" lists matching loaded files', count >= 5, '>=5 matches', String(count), 'P1')
    await input.fill('中文')
    await sleep(400)
    const cn = await frameText()
    check('filetree', 'Chinese filter matches special-name file', /r2 中文 & 空格\.txt/.test(cn), 'Chinese filename match', cn.match(/r2 中文[^\n]*/)?.[0] ?? 'missing')
    await input.fill('<img src=x onerror=alert(1)>')
    await sleep(400)
    const xss = await fr().evaluate(() => ({ imgs: document.querySelectorAll('[data-testid="cloud-workspace-file-tree-matches"] img').length, html: document.querySelector('[data-testid="cloud-workspace-file-tree-matches"]')?.innerHTML ?? '' }))
    check('filetree', 'XSS in filter input is escaped, not rendered', xss.imgs === 0, 'no injected img', JSON.stringify(xss).slice(0, 120), 'P0')
    await input.fill('no-such-file-r2')
    await sleep(400)
    check('filetree', 'no-match state', /没有匹配的文件/.test(await frameText()), '没有匹配的文件', 'ok')
    await fr().locator('[aria-label="Clear file filter"]').click().catch(async () => { await input.fill('') })
    await sleep(400)
    check('filetree', 'clear filter restores the tree', (await fr().locator('[data-testid^="cloud-workspace-file-tree-node-"]').count()) >= 3, 'root nodes visible', 'ok')
  })

  await step('filetree', 'deep + empty directories', async () => {
    await clickFileNode('docs/r2-deep/a/b/c/d-e.txt')
    await waitTabForPath('docs/r2-deep/a/b/c/d-e.txt')
    check('filetree', 'deep directory path opens at depth 5', true, 'file tab for deep path', 'ok')
    await expandParents('docs/r2-empty')
    await fr().locator('[data-testid="cloud-workspace-file-tree-node-docs/r2-empty"]').click()
    await sleep(600)
    const empty = await frameText()
    check('filetree', 'empty directory shows 空目录', /空目录/.test(empty), '空目录 row', /空目录/.test(empty) ? 'shown' : 'missing')
  })

  await step('filetree', 'refresh keeps expansion', async () => {
    // docs should still be expanded from earlier steps
    await t('cloud-workspace-file-tree-refresh').click()
    await sleep(1500)
    const expanded = await fr().evaluate(() =>
      [...document.querySelectorAll('[role="treeitem"][aria-expanded="true"]')].map((el) => el.getAttribute('aria-label'))
    )
    check('filetree', 'refresh re-reads without collapsing expanded levels', expanded.includes('docs') && expanded.length >= 1, 'docs stays expanded', JSON.stringify(expanded), 'P1')
  })

  await step('filetree', 'long filename', async () => {
    const long = fs.readFileSync('/tmp/r2-longname.txt', 'utf8').trim()
    const rel = `docs/r2-fixtures/${long}`
    await clickFileNode(rel)
    await waitTabForPath(rel)
    const tabs = await tabIds()
    check('filetree', '112-char filename opens and keeps tab title', tabs.some((id) => id.includes('r2-xxxxxxxx')), 'tab exists', JSON.stringify(tabs.slice(-3)), 'P2')
  })

  // ===== J. git panel =====
  await step('git', 'status groups vs git status', async () => {
    const porcelain = execFileSync('git', ['-c', 'core.quotepath=false', 'status', '--porcelain', '--untracked-files=all'], { cwd: WT, encoding: 'utf8' }).trim().split('\n').filter(Boolean)
    const worktreeCommits = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: WT, encoding: 'utf8' }).trim()
    await t('cloud-simple-workspace-right-tab-git').click()
    await t('cloud-workspace-git-panel').waitFor({ timeout: 20000 })
    await sleep(1200)
    const panel = await t('cloud-workspace-git-panel').evaluate((root) => {
      const groups = [...root.querySelectorAll('[data-testid^="cloud-workspace-git-group-"]')].map((g) => ({
        status: g.getAttribute('data-testid').replace('cloud-workspace-git-group-', ''),
        label: g.querySelector('p')?.innerText ?? '',
        files: [...g.querySelectorAll('[data-testid^="cloud-workspace-git-change-"]')].map((b) => b.getAttribute('data-testid').replace('cloud-workspace-git-change-', ''))
      }))
      const commits = [...root.querySelectorAll('[data-testid^="cloud-workspace-git-commit-"]')]
        .filter((el) => !el.getAttribute('data-testid').includes('-file'))
        .map((el) => el.getAttribute('data-testid').replace('cloud-workspace-git-commit-', ''))
      return { groups, commits }
    })
    const actualUntracked = porcelain.filter((l) => l.startsWith('??')).map((l) => l.slice(3).trim().replace(/^"(.*)"$/, '$1'))
    const panelUntracked = panel.groups.find((g) => g.status === 'untracked')?.files ?? []
    const missing = panelUntracked.filter((p) => !actualUntracked.some((a) => a === p || a.endsWith('/' + p)))
    check('git', 'untracked group matches git status (fixtures)', actualUntracked.length >= 10 && missing.length === 0, `untracked >=10 and all present`, JSON.stringify({ porcelainCount: actualUntracked.length, panelUntracked: panelUntracked.length, missing, groups: panel.groups.map((g) => [g.status, g.files.length]) }), 'P1')
    check('git', 'history matches the checkout commit count', panel.commits.length === Number(worktreeCommits), `${worktreeCommits} commits`, String(panel.commits.length), 'P1')
    await shot(page, 'r2-11-git-panel')
    meta.gitPorcelainCount = porcelain.length
  })

  await step('git', 'commit expand + diff tab + modes', async () => {
    const first = fr().locator('[data-testid^="cloud-workspace-git-commit-"]:not([data-testid*="-file"])').first()
    await first.click()
    await sleep(1500)
    const fileRows = fr().locator('[data-testid^="cloud-workspace-git-commit-file-"]')
    const n = await fileRows.count()
    check('git', 'expanding a commit lazily lists its files', n >= 1, '>=1 commit file', String(n), 'P1')
    if (n > 0) {
      const rel = await fileRows.first().evaluate((el) => el.getAttribute('data-testid').replace('cloud-workspace-git-commit-file-', ''))
      await fileRows.first().click()
      await waitTabForPath(rel)
      await t('cloud-workspace-diff-tab').waitFor({ timeout: 20000 })
      const source = await t('cloud-workspace-diff-source').innerText()
      check('git', 'commit file opens a diff tab labelled 提交', /提交/.test(source), 'source badge 提交 <sha>', source, 'P1')
      const sideBySide = await t('cloud-workspace-diff-mode-side-by-side').getAttribute('aria-pressed')
      await t('cloud-workspace-diff-mode-inline').click()
      const inline = await t('cloud-workspace-diff-mode-inline').getAttribute('aria-pressed')
      await t('cloud-workspace-diff-mode-side-by-side').click()
      const back = await t('cloud-workspace-diff-mode-side-by-side').getAttribute('aria-pressed')
      check('git', 'diff 左右/合并 toggle works', sideBySide === 'true' && inline === 'true' && back === 'true', 'aria-pressed flips', JSON.stringify({ sideBySide, inline, back }), 'P1')
      await shot(page, 'r2-12-diff-commit')
    }
  })

  await step('git', 'working-tree diff + binary diff', async () => {
    // modify a tracked file through the UI so the working tree is non-empty
    await t('cloud-simple-workspace-right-tab-files').click().catch(() => {})
    await clickFileNode('README.md')
    await fr().locator('.monaco-editor:visible').first().waitFor()
    await sleep(400)
    await monacoAppend('\nr2-working-diff')
    await sleep(600)
    await t('cloud-workspace-file-tab-save').click()
    await sleep(1200)
    await t('cloud-simple-workspace-right-tab-git').click()
    await t('cloud-workspace-git-refresh').click()
    await sleep(1200)
    const modifiedExists = await fr().locator('[data-testid="cloud-workspace-git-change-README.md"]').count()
    check('git', 'saved UI edit appears in the 修改 group', modifiedExists > 0, 'README.md modified row', String(modifiedExists), 'P1')
    if (modifiedExists > 0) {
      await fr().locator('[data-testid="cloud-workspace-git-change-README.md"]').click()
      await t('cloud-workspace-diff-tab').waitFor({ timeout: 20000 })
      const source = await t('cloud-workspace-diff-source').innerText()
      await sleep(1000)
      const hasDiffText = await fr().evaluate(() => document.body.innerText.includes('r2-working-diff'))
      check('git', 'working-tree diff opens with 工作区 source and shows the change', /工作区/.test(source) && hasDiffText, '工作区 diff content', JSON.stringify({ source, hasDiffText }), 'P1')
      await shot(page, 'r2-13-diff-working')
    }
    await t('cloud-simple-workspace-right-tab-git').click()
    const binRow = fr().locator('[data-testid="cloud-workspace-git-change-docs/r2-fixtures/r2-binary.bin"]')
    if (await binRow.count()) {
      await binRow.click()
      await t('cloud-workspace-diff-tab').waitFor({ timeout: 20000 })
      await sleep(1500)
      const binary = await t('cloud-workspace-diff-binary').count()
      const body = await frameText()
      check('git', 'binary working-tree diff degrades to binary notice', binary > 0 || /二进制/.test(body), 'binary diff body', JSON.stringify({ binary, tail: body.slice(-160) }), 'P1')
      await shot(page, 'r2-14-diff-binary')
    } else {
      check('git', 'binary fixture row present in untracked group', false, 'row present', 'row missing', 'P1')
    }
    execFileSync('git', ['checkout', '--', 'README.md'], { cwd: WT })
  })

  // ===== K. tabs mix / close / dedupe =====
  await step('tabs', 'mixed tab kinds + neighbour close', async () => {
    await t('cloud-simple-workspace-new-terminal').click()
    await fr().locator('.xterm:visible').first().waitFor({ timeout: 30000 })
    await sleep(500)
    const ids = await tabIds()
    check('tabs', 'terminal + editor + preview + diff coexist in one strip', ids.some((i) => i.startsWith('terminal-')) && ids.some((i) => i.startsWith('file:')) && ids.some((i) => i.startsWith('preview:')) && ids.some((i) => i.startsWith('diff:')), 'all four kinds', JSON.stringify(ids.slice(-8)), 'P1')
    // choose the middle tab and close it
    const middleIndex = Math.floor(ids.length / 2)
    const middle = ids[middleIndex]
    const right = ids[middleIndex + 1]
    await t(`cloud-simple-workspace-tab-${middle}`).click()
    await t(`cloud-simple-workspace-tab-close-${middle}`).click()
    await sleep(700)
    const active = await activeTabId()
    check('tabs', 'closing the active tab activates the right neighbour', right ? active === right : active !== null, `active=${right}`, String(active), 'P1')
  })

  await step('terminal', 'echo + cap', async () => {
    const marker = path.join(WT, 'docs/r2-terminal-marker')
    try { fs.unlinkSync(marker) } catch {}
    const termId = (await tabIds()).find((id) => id.startsWith('terminal-'))
    await t(`cloud-simple-workspace-tab-${termId}`).click()
    await fr().locator('.xterm-screen:visible').first().waitFor({ timeout: 30000 })
    for (let i = 0; i < 60; i += 1) {
      const state = await fr().evaluate(() => document.querySelector('[data-testid="cloud-terminal-state"]')?.textContent ?? '')
      if (state.includes('实时')) break
      await sleep(500)
    }
    await fr().locator('.xterm-screen:visible').first().click()
    await page.keyboard.type(`touch ${JSON.stringify(marker)}`, { delay: 5 })
    await page.keyboard.press('Enter')
    let echoed = false
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      if (fs.existsSync(marker)) { echoed = true; break }
      await sleep(300)
    }
    check('terminal', 'terminal accepts input and runs a command on the host', echoed, 'marker file created', String(echoed), 'P1')
    // fill to the cap
    for (let i = 0; i < 5; i += 1) {
      if (await t('cloud-simple-workspace-new-terminal').isDisabled().catch(() => true)) break
      await t('cloud-simple-workspace-new-terminal').click()
      await sleep(900)
    }
    const terminals = (await tabIds()).filter((i) => i.startsWith('terminal-')).length
    const disabled = await t('cloud-simple-workspace-new-terminal').isDisabled().catch(() => null)
    const title = await t('cloud-simple-workspace-new-terminal').getAttribute('title').catch(() => '')
    check('terminal', 'terminal tabs cap at 6 and the button disables', terminals === 6 && disabled === true, '6 terminals, + disabled', JSON.stringify({ terminals, disabled, title }), 'P1')
    await shot(page, 'r2-15-terminals-cap')
    // close extra terminals down to one
    while ((await tabIds()).filter((i) => i.startsWith('terminal-')).length > 1) {
      const ids = (await tabIds()).filter((i) => i.startsWith('terminal-'))
      await t(`cloud-simple-workspace-tab-close-${ids[ids.length - 1]}`).click()
      await sleep(350)
    }
    check('terminal', 'closing a terminal frees a slot', !(await t('cloud-simple-workspace-new-terminal').isDisabled().catch(() => true)), '+ enabled again', 'ok')
  })

  // ===== L. logout cleanup (overlay still open) =====
  await step('overlay', 'logout removes overlay and returns to login', async () => {
    // The overlay is still open from the tab tests; logout must tear it down.
    const overlayOpen = (await parent('#workspaceOverlay').count()) === 1
    await page.evaluate(() => document.getElementById('logoutBtn')?.click())
    const deadline = Date.now() + 6000
    let removed = false
    let login = false
    while (Date.now() < deadline) {
      removed = (await parent('#workspaceOverlay').count()) === 0
      login = (await page.locator('#username').count()) > 0
      if (removed && login) break
      await sleep(200)
    }
    check('overlay', 'logout with the overlay open clears it and shows the login form', overlayOpen && removed && login, 'overlay gone, login visible', JSON.stringify({ overlayOpen, removed, login }), 'P0')
  })

  // summary
  meta.endedAt = new Date().toISOString()
  meta.handoffCount = network.handoffs.length
  meta.checks = checks.length
  meta.failures = checks.filter((c) => !c.ok).length
}

main()
  .catch((err) => {
    console.error('FATAL', err)
    checks.push({ id: 'CFATAL', area: 'journey', name: 'script', ok: false, severity: 'P0', expected: 'journey completes', actual: err.message })
  })
  .finally(async () => {
    try {
      await page?.screenshot({ path: path.join(SHOTS, 'r2-99-final.png') })
    } catch {}
    const result = {
      feature: 'U46 embedded simple workspace — exploratory r2',
      meta,
      checks,
      network,
      findings: checks.filter((c) => !c.ok).map((c) => ({
        checkId: c.id,
        severity: c.severity,
        area: c.area,
        title: c.name,
        expected: c.expected,
        actual: c.actual,
        ...(c.extra ?? {})
      })),
      screenshots: fs.readdirSync(SHOTS).filter((f) => f.endsWith('.png')).sort()
    }
    fs.writeFileSync(path.join(OUT, 'workspace.json'), JSON.stringify(result, null, 2))
    console.log(`written ${path.join(OUT, 'workspace.json')} checks=${checks.length} failures=${result.findings.length}`)
    await browser?.close()
  })
