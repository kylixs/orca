#!/usr/bin/env node
/**
 * U63 manual re-verification — Orca Web + embedded workspace.
 *
 * Replays the exploratory-r2 path list (workspace-paths.md P1–P19) against the
 * running local environment (platform + real hosts + real out/web bundle) and
 * records one numbered screenshot per step plus extracted-text assertions.
 *
 *   A. Orca Web new-tab chain: handoff auto-entry → W13 workspace → terminal /
 *      file tree → replay 410 fallback.
 *   B. Embedded overlay chain: console 「打开」 → overlay → terminal / editor
 *      save / markdown dual mode / preview / git changes → diff modes → close
 *      handshake → reopen.
 *   C. R2 second-open scenarios: same project / different project / cross-host.
 *
 * Evidence only: writes cloud-platform/evidence/man-review/workspace/ and never
 * touches product code (fixtures under the admin checkouts are temporary).
 *
 * Usage: node cloud-platform/scripts/exploratory-r2/run-workspace-manual-review.mjs
 */
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const BASE = process.env.ORCA_QA_BASE || 'https://127.0.0.1:18787'
const OUT = path.resolve('cloud-platform/evidence/man-review/workspace')
const SHOTS = path.join(OUT, 'screenshots')
fs.mkdirSync(SHOTS, { recursive: true })

const ADMIN = { username: 'admin', password: 'Adm1n!' }
const PROJECT_DEMO = 'proj_ec90a17a'
const PROJECT_ZHANGSAN = 'proj_03cfcd4e'
const PROJECT_INFRA = 'proj_fc96a124'
const WT = '/Users/gongdewei/orca-local-env/host/projects/demo-app/.orca-worktrees/admin/main-2'
const WT_ZHANGSAN =
  '/Users/gongdewei/orca-local-env/host/projects/zhangsan-demo/.orca-worktrees/admin/main-2'
const WT2 = '/Users/gongdewei/orca-local-env/host2/projects/infra-tools/.orca-worktrees/admin/main-3'

const steps = []
const counters = { A: 0, B: 0, C: 0 }
const events = {
  generatedAt: null,
  handoffs: [],
  redeem: [],
  httpFailures: [],
  consoleErrors: [],
  dialogs: [],
  newTerminalMarkers: []
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function watch(page, segment) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      events.consoleErrors.push({ segment, url: page.url(), text: msg.text().slice(0, 300) })
    }
  })
  page.on('pageerror', (err) =>
    events.consoleErrors.push({ segment, url: page.url(), text: `pageerror: ${err.message}` })
  )
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('/web-handoff')) {
      events.handoffs.push({ segment, url: req.url(), body: req.postData() })
    }
  })
  page.on('response', (res) => {
    if (res.request().method() === 'POST' && res.url().includes('/v1/web/handoff')) {
      events.redeem.push({ segment, status: res.status(), url: res.url() })
    }
    if (res.status() >= 400) {
      events.httpFailures.push({ segment, status: res.status(), url: res.url().slice(0, 200) })
    }
  })
  page.on('dialog', async (dialog) => {
    events.dialogs.push({ segment, type: dialog.type(), message: dialog.message() })
    await dialog.accept().catch(() => {})
  })
}

let current = null

function addAssertion(name, ok, expected, actual, severity = 'P1') {
  current.assertions.push({ name, ok: Boolean(ok), expected, actual, severity: ok ? null : severity })
  return Boolean(ok)
}

async function shot(page, label) {
  const file = `${current.id}-${label}.png`
  await page.screenshot({ path: path.join(SHOTS, file) })
  current.screenshots.push(file)
  return file
}

async function runStep(segment, action, body) {
  counters[segment] += 1
  current = {
    id: `${segment}${String(counters[segment]).padStart(2, '0')}`,
    segment,
    action,
    startedAt: new Date().toISOString(),
    assertions: [],
    screenshots: [],
    notes: [],
    error: null
  }
  const started = Date.now()
  try {
    await body()
  } catch (error) {
    current.error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error)
    current.assertions.push({
      name: 'step completes',
      ok: false,
      expected: 'step completes',
      actual: `threw: ${String(error?.message ?? error).split('\n')[0]}`,
      severity: 'P0'
    })
  }
  current.durationMs = Date.now() - started
  current.ok = !current.error && current.assertions.every((a) => a.ok)
  steps.push(current)
  const failed = current.assertions.filter((a) => !a.ok).length
  console.log(
    `${current.ok ? 'PASS' : 'FAIL'} ${current.id} ${action} :: ` +
      `${current.assertions.length - failed}/${current.assertions.length} assertions` +
      (current.error ? ` :: ${current.error.split('\n')[0]}` : '')
  )
  current = null
}

const note = (text) => current.notes.push(text)

/* ---------------- common helpers ---------------- */

async function loginConsole(page) {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  if (await page.locator('#username').count()) {
    await page.fill('#username', ADMIN.username)
    await page.fill('#password', ADMIN.password)
    await page.click('#loginBtn').catch(async () => {
      await page.getByRole('button', { name: '登录' }).click()
    })
  }
  await page.locator('tr', { hasText: 'demo-app' }).first().waitFor({ timeout: 25000 })
}

const frameOf = (page) => page.frames().find((f) => f.url().includes('/cloud-admin.html'))
const t = (page, id) => frameOf(page).locator(`[data-testid="${id}"]:visible`)
const parent = (page, sel) => page.locator(sel)
const frameText = (page) => frameOf(page).evaluate(() => document.body.innerText)

async function tabIds(page) {
  return frameOf(page).evaluate(() =>
    [...document.querySelectorAll('[role="tab"][data-testid^="cloud-simple-workspace-tab-"]')]
      .map((el) => el.getAttribute('data-testid').replace('cloud-simple-workspace-tab-', ''))
      .filter((id) => !id.startsWith('dirty-'))
  )
}

async function waitTab(page, relPath) {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    const ids = await tabIds(page)
    const hit = ids.find(
      (id) =>
        id === `file:${relPath}` ||
        id === `preview:${relPath}` ||
        id === `diff:${relPath}` ||
        (id.startsWith('diff:') && id.endsWith(`:${relPath}`))
    )
    if (hit) return hit
    await sleep(250)
  }
  return null
}

async function expandParents(page, relPath) {
  const parts = relPath.split('/')
  let cur = ''
  for (let i = 0; i < parts.length - 1; i += 1) {
    cur = cur ? `${cur}/${parts[i]}` : parts[i]
    await frameOf(page).evaluate((p) => {
      const btn = document.querySelector(
        `[data-testid="cloud-workspace-file-tree-node-${CSS.escape(p)}"]`
      )
      const item = btn?.closest('[role="treeitem"]')
      if (!btn) return
      if (item?.getAttribute('aria-expanded') === 'true') return
      btn.click()
    }, cur)
    await sleep(450)
  }
}

async function clickFileNode(page, relPath) {
  await t(page, 'cloud-simple-workspace-right-tab-files').click().catch(() => {})
  await sleep(250)
  await expandParents(page, relPath)
  const node = frameOf(page).locator(
    `[data-testid="cloud-workspace-file-tree-node-${relPath.replaceAll('"', '\\"')}"]`
  )
  if ((await node.count()) && (await node.isVisible())) {
    await node.click()
    return
  }
  const input = frameOf(page).locator('[data-testid="cloud-workspace-file-tree-filter"] input')
  const base = relPath.split('/').at(-1)
  await input.fill(base)
  await sleep(600)
  const match = frameOf(page).locator(
    `[data-testid="cloud-workspace-file-tree-match-${relPath.replaceAll('"', '\\"')}"]`
  )
  await match.waitFor({ timeout: 15000 })
  await match.click()
  await input.fill('')
}

async function monacoAppend(page, text) {
  const frame = frameOf(page)
  const lines = frame.locator('.monaco-editor:visible .view-lines').first()
  await lines.click()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End')
  // Monaco can drop keystrokes while its model settles; type slowly and verify
  // through the instrumented probe (VITE_EXPOSE_STORE), retrying when needed.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.keyboard.type(text, { delay: 12 })
    await sleep(500)
    const tail = await frame
      .evaluate(() => window.__monacoEditorE2E?.snapshot?.().valueTail ?? '')
      .catch(() => '')
    if (tail.includes(text.trim())) return true
  }
  return false
}

async function activeTabIdOf(page) {
  return page.evaluate(() => {
    const store = window.__store
    if (!store) return null
    const state = store.getState()
    const wId = state.activeWorktreeId
    if (!wId) return null
    const tabs = state.tabsByWorktree?.[wId] ?? []
    if (tabs.length === 0) return null
    const pref =
      state.activeTabType === 'terminal'
        ? state.activeTabId
        : (state.activeTabIdByWorktree?.[wId] ?? null)
    if (pref && tabs.some((tab) => tab.id === pref)) return pref
    return tabs[0]?.id ?? null
  })
}

async function terminalContent(page, charLimit = 8000) {
  const tabId = await activeTabIdOf(page)
  if (!tabId) return ''
  return page.evaluate(
    ({ tabId, charLimit }) => {
      const manager = window.__paneManagers?.get(tabId)
      if (!manager) return ''
      const pane = manager.getActivePane?.() ?? manager.getPanes?.()[0] ?? null
      const text = pane?.serializeAddon?.serialize?.() ?? ''
      return text.slice(-charLimit)
    },
    { tabId, charLimit }
  )
}

async function waitOverlayReady(page, timeoutMs = 35000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await page.evaluate(() => {
      const o = document.querySelector('#workspaceOverlay')
      return {
        overlay: !!o,
        ready: o?.querySelector('[data-workspace-status]')?.hidden === true,
        failure: o?.querySelector('[data-workspace-ready-failure]')?.innerText?.slice(0, 400) ?? '',
        status: o?.querySelector('[data-workspace-status]')?.innerText?.slice(0, 200) ?? '',
        route: o?.querySelector('[data-workspace-route]')?.textContent ?? '',
        iframeSrc: o?.querySelector('iframe')?.src ?? ''
      }
    })
    if (last.ready || last.failure) return last
    await sleep(400)
  }
  return last
}

async function openOverlay(page, projectKey, timeoutMs = 35000) {
  await page
    .locator('tr', { hasText: projectKey })
    .first()
    .getByRole('button', { name: '打开', exact: true })
    .click()
  await parent(page, '#workspaceOverlay iframe').waitFor({ timeout: 20000 })
  return waitOverlayReady(page, timeoutMs)
}

async function closeOverlay(page) {
  const before = page.url()
  await parent(page, '#workspaceOverlay [data-workspace-close]').click()
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) {
    if ((await parent(page, '#workspaceOverlay').count()) === 0) {
      return { closed: true, urlUnchanged: page.url() === before }
    }
    await sleep(200)
  }
  return { closed: false, urlUnchanged: page.url() === before }
}

const demoFrame = (page) => frameOf(page)
const demoText = (page) => frameText(page)

/* ---------------- A. Orca Web new-tab chain ---------------- */

async function segmentA() {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 960 }
  })
  const page = await context.newPage()
  watch(page, 'A')
  page.setDefaultTimeout(30000)
  let popup = null
  let issuedUrl = ''

  try {
    await runStep('A', '管理台登录（admin）', async () => {
      await loginConsole(page)
      const row = page.locator('tr', { hasText: 'demo-app' }).first()
      const visible = await row.isVisible()
      addAssertion('demo-app row visible', visible, 'demo-app 行可见', String(visible), 'P0')
      const entry = page.locator(`button[data-orca-web="${PROJECT_DEMO}"]`)
      addAssertion(
        'Orca Web entry enabled',
        (await entry.count()) === 1 && (await entry.isEnabled()),
        'Orca Web 入口可见且可点',
        `count=${await entry.count()} enabled=${await entry.isEnabled().catch(() => false)}`,
        'P0'
      )
      await shot(page, 'console-login')
    })

    await runStep('A', '点击 Orca Web：签发 handoff 并打开新标签', async () => {
      const entry = page.locator(`button[data-orca-web="${PROJECT_DEMO}"]`)
      for (let attempt = 1; attempt <= 3 && !popup; attempt += 1) {
        const popupPromise = page.waitForEvent('popup', { timeout: 12000 }).catch(() => null)
        await entry.click()
        popup = await popupPromise
      }
      addAssertion('popup opened', Boolean(popup), '新标签打开', String(Boolean(popup)), 'P0')
      if (!popup) return
      watch(popup, 'A')
      popup.setDefaultTimeout(30000)
      await popup.waitForLoadState('domcontentloaded')
      issuedUrl = popup.url()
      const url = new URL(issuedUrl)
      // Direct hosts serve /web-index.html; a relay edge prefixes /h/<route>/.
      addAssertion(
        'entry is the host-served web client',
        /(^|\/)web-index\.html$/.test(url.pathname),
        '/web-index.html or /h/<route>/web-index.html',
        url.pathname,
        'P0'
      )
      addAssertion(
        'entry carries ?api=<platform>',
        url.searchParams.get('api') === BASE,
        BASE,
        url.searchParams.get('api') ?? '',
        'P0'
      )
      addAssertion(
        'hash carries one-time code + project',
        new RegExp(`^#handoff=[A-Za-z0-9_-]+&project=${PROJECT_DEMO}$`).test(url.hash),
        '#handoff=<code>&project=<id>',
        url.hash.replace(/#handoff=[A-Za-z0-9_-]+/, '#handoff=<redacted>'),
        'P0'
      )
      const minted = events.handoffs.filter(
        (h) => h.segment === 'A' && h.url.includes(`/v1/projects/${PROJECT_DEMO}/web-handoff`)
      )
      addAssertion(
        'web-handoff POST observed',
        minted.length >= 1,
        'POST /v1/projects/{id}/web-handoff',
        String(minted.length),
        'P0'
      )
      await shot(page, 'console-after-click')
    })

    await runStep('A', '新标签自动进入工作区（免登）', async () => {
      if (!popup) return
      await popup.waitForSelector('.app-layout', { timeout: 120000 })
      await popup.waitForTimeout(8000)
      const state = await popup.evaluate(() => {
        const stored = window.localStorage.getItem('orca.web.runtimeEnvironment.v1')
        return {
          hash: window.location.hash,
          hasSignInForm: document.querySelector('#web-cloud-api-url') !== null,
          hasAppLayout: document.querySelector('.app-layout') !== null,
          degradedToast: document.body.innerText.includes('Session restore failed'),
          cloudSessionPersisted:
            window.localStorage.getItem('orca.webCloudSession') !== null,
          environment: stored === null ? null : (JSON.parse(stored)?.name ?? null),
          bodyTail: document.body.innerText.slice(0, 200)
        }
      })
      addAssertion('handoff code cleared from URL', state.hash === '', 'hash 清空', state.hash, 'P0')
      addAssertion('workspace shell mounted', state.hasAppLayout, '.app-layout 存在', String(state.hasAppLayout), 'P0')
      addAssertion('no sign-in form', state.hasSignInForm === false, '无登录表单', String(state.hasSignInForm), 'P0')
      addAssertion('not degraded (W7c)', state.degradedToast === false, '无 Session restore failed', String(state.degradedToast), 'P0')
      addAssertion('cloud session persisted', state.cloudSessionPersisted, 'orca.webCloudSession 存在', String(state.cloudSessionPersisted), 'P0')
      addAssertion(
        'environment is demo-app',
        String(state.environment ?? '').includes('demo-app'),
        'environment contains demo-app',
        String(state.environment),
        'P0'
      )
      note(JSON.stringify(state).slice(0, 500))
      // A first-run feature tip can cover the workspace; dismiss it so the
      // screenshot (and the reviewer) sees the workspace surface itself.
      await popup.getByRole('button', { name: 'Got it' }).click({ timeout: 8000 }).catch(() => {})
      await popup.locator('.app-layout').waitFor({ timeout: 10000 }).catch(() => {})
      await popup.waitForTimeout(800)
      await shot(popup, 'web-workspace-entered')
    })

    await runStep('A', 'W13 云工作区视图：项目行与 checkout 激活', async () => {
      if (!popup) return
      let state = null
      const deadline = Date.now() + 180000
      while (Date.now() < deadline) {
        state = await popup.evaluate(() => {
          const storeState = window.__store?.getState?.() ?? null
          const flat = Object.values(storeState?.worktreesByRepo ?? {}).flat()
          return {
            repoCount: storeState?.repos?.length ?? null,
            activeWorktreeId: storeState?.activeWorktreeId ?? null,
            activeWorktreePath:
              flat.find((entry) => entry.id === storeState?.activeWorktreeId)?.path ?? null,
            explorerShellMounted: document.querySelector('[data-orca-explorer-shell]') !== null,
            sidebarCloudEmptyState:
              document.querySelector('[data-worktree-sidebar-container] svg.lucide-cloud') !== null
          }
        })
        if (state.repoCount === 1 && state.activeWorktreeId) break
        await sleep(1000)
      }
      addAssertion('one project row registered', state?.repoCount === 1, 'repoCount=1', String(state?.repoCount), 'P0')
      addAssertion('checkout activated', Boolean(state?.activeWorktreeId), 'activeWorktreeId 非空', String(state?.activeWorktreeId), 'P0')
      addAssertion(
        'checkout is the host-managed per-user one',
        String(state?.activeWorktreePath ?? '').includes('.orca-worktrees/admin/'),
        '<project>/.orca-worktrees/admin/...',
        String(state?.activeWorktreePath),
        'P0'
      )
      addAssertion('explorer shell mounted', Boolean(state?.explorerShellMounted), 'data-orca-explorer-shell', String(state?.explorerShellMounted), 'P1')
      addAssertion('cloud empty card retired', state?.sidebarCloudEmptyState === false, '云空态消失', String(state?.sidebarCloudEmptyState), 'P2')
      note(JSON.stringify(state))
      await shot(popup, 'w13-workspace-view')
    })

    await runStep('A', '终端实时回显（Orca Web）', async () => {
      if (!popup) return
      await popup.getByRole('button', { name: 'Got it' }).click({ timeout: 8000 }).catch(() => {})
      if ((await popup.locator('.xterm').count()) === 0) {
        await popup.keyboard.press(process.platform === 'darwin' ? 'Meta+T' : 'Control+T')
      }
      await popup.locator('.xterm').first().waitFor({ timeout: 90000 })
      await popup.locator('.xterm').first().click()
      const marker = `MANREVIEW-WEB-${Date.now()}`
      await popup.keyboard.type(`echo ${marker}`)
      await popup.keyboard.press('Enter')
      let content = ''
      const deadline = Date.now() + 40000
      while (Date.now() < deadline) {
        content = await terminalContent(popup)
        if (content.includes(marker)) break
        await sleep(600)
      }
      addAssertion('terminal accepts typing and streams output', content.includes(marker), 'PTY 回显 marker', content.includes(marker) ? 'marker 出现' : JSON.stringify(content.slice(-200)), 'P0')
      await shot(popup, 'terminal-echo')
    })

    await runStep('A', '文件树打开文件（Monaco）', async () => {
      if (!popup) return
      const explorer = popup.locator('[data-orca-explorer-shell]')
      await explorer.first().waitFor({ timeout: 60000 })
      const file = explorer.getByText('README.md', { exact: true }).first()
      await file.waitFor({ timeout: 30000 })
      await file.click()
      await popup.locator('.editor-header-path').first().waitFor({ timeout: 30000 })
      const pathText = await popup.locator('.editor-header-path').first().innerText()
      await popup.waitForTimeout(700)
      // README.md opens in the rich markdown editor, not Monaco, so the
      // user-visible pane text is the oracle (Monaco's view-lines stays empty).
      const paneText = await popup.evaluate(() => document.body.innerText)
      addAssertion('editor header shows README.md', pathText.includes('README.md'), 'README.md', pathText, 'P0')
      addAssertion('file content rendered', /快速开始/.test(paneText) && /node src\/server\.js/.test(paneText), 'README 内容可见', paneText.match(/快速开始[^\n]*/)?.[0] ?? paneText.slice(0, 120), 'P1')
      await shot(popup, 'file-tree-editor')
      // The path list's editor oracle is Monaco: a code file must render lines.
      // src starts collapsed, so expand it before reaching server.js.
      const srcRow = explorer.getByText('src', { exact: true }).first()
      await srcRow.click()
      await sleep(900)
      const jsFile = explorer.getByText('server.js', { exact: true }).first()
      if (!(await jsFile.isVisible().catch(() => false))) {
        await srcRow.dblclick().catch(() => {})
        await sleep(900)
      }
      await jsFile.waitFor({ timeout: 30000 })
      await jsFile.click()
      await popup.locator('.editor-header-path').first().waitFor({ timeout: 30000 })
      await popup.locator('.view-lines').first().waitFor({ timeout: 30000 })
      await popup.waitForTimeout(600)
      const lineText = await popup.locator('.view-lines').first().innerText().catch(() => '')
      addAssertion('JS file renders Monaco lines', /createOrder/.test(lineText), 'server.js 源码行', lineText.slice(0, 120), 'P1')
      await shot(popup, 'file-tree-monaco')
    })

    await runStep('A', '重放 handoff 链接：410 回落登录表单', async () => {
      if (!issuedUrl) return
      const fresh = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width: 1440, height: 960 }
      })
      const replay = await fresh.newPage()
      watch(replay, 'A')
      replay.setDefaultTimeout(30000)
      try {
        await replay.goto(issuedUrl, { waitUntil: 'domcontentloaded' })
        await replay.locator('#web-cloud-api-url').waitFor({ timeout: 30000 })
        const redeem = events.redeem.filter((r) => r.segment === 'A').at(-1)
        const apiValue = await replay.locator('#web-cloud-api-url').inputValue()
        const appLayout = await replay.locator('.app-layout').count()
        addAssertion('redeem returns 410', redeem?.status === 410, '410', String(redeem?.status), 'P0')
        addAssertion('falls back to sign-in form', (await replay.locator('#web-cloud-api-url').count()) === 1 && appLayout === 0, '登录表单可见', `form=${await replay.locator('#web-cloud-api-url').count()} app=${appLayout}`, 'P0')
        addAssertion('platform address prefilled', apiValue === BASE, BASE, apiValue, 'P1')
        note(JSON.stringify({ redeem, apiValue }))
        await shot(replay, 'replay-410-signin')
      } finally {
        await fresh.close()
      }
    })
  } finally {
    await context.close()
  }
}

/* ---------------- B. embedded overlay chain ---------------- */

async function segmentB() {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1600, height: 1000 }
  })
  const page = await context.newPage()
  watch(page, 'B')
  page.setDefaultTimeout(30000)

  const workbenchUrl = () => page.url()
  let readyState = null

  try {
    await runStep('B', '管理台登录（admin）', async () => {
      await loginConsole(page)
      addAssertion('workbench rows visible', (await page.locator('tr', { hasText: 'demo-app' }).count()) === 1, 'demo-app 行可见', 'ok', 'P0')
      await shot(page, 'console-login')
    })

    await runStep('B', '点击「打开」：同页覆盖层挂载 iframe', async () => {
      await page
        .locator('tr', { hasText: 'demo-app' })
        .first()
        .getByRole('button', { name: '打开', exact: true })
        .click()
      await parent(page, '#workspaceOverlay').waitFor({ timeout: 15000 })
      await parent(page, '#workspaceOverlay iframe').waitFor({ timeout: 15000 })
      const loadingText = await parent(page, '#workspaceOverlay [data-workspace-status]')
        .innerText()
        .catch(() => '')
      addAssertion('overlay mounted', (await parent(page, '#workspaceOverlay').count()) === 1, 'overlay 存在', 'ok', 'P0')
      addAssertion('loading status present', /正在进入项目工作区/.test(loadingText), '正在进入项目工作区…', loadingText, 'P2')
      await shot(page, 'overlay-loading')
      readyState = await waitOverlayReady(page, 35000)
    })

    await runStep('B', '覆盖层就绪：embed iframe 与路线徽标', async () => {
      const state = readyState ?? (await waitOverlayReady(page, 5000))
      addAssertion('workspace ready', state?.ready === true, 'ready', JSON.stringify(state).slice(0, 300), 'P0')
      addAssertion('no failure state', !state?.failure, '无失败态', state?.failure ?? '', 'P0')
      addAssertion('iframe is cloud-admin embed', /cloud-admin\.html\?.*embed=1/.test(state?.iframeSrc ?? ''), 'cloud-admin.html?embed=1', state?.iframeSrc ?? '', 'P0')
      const frame = frameOf(page)
      const frameUrl = frame?.url() ?? ''
      addAssertion('handoff hash cleared in iframe', !frameUrl.includes('handoff='), 'iframe URL 无 handoff=', frameUrl, 'P1')
      addAssertion('route badge 直连/中继', /直连|中继/.test(state?.route ?? ''), '直连|中继', state?.route ?? '', 'P1')
      const adminHandoffs = events.handoffs.filter(
        (h) => h.segment === 'B' && h.url.includes(`/v1/projects/${PROJECT_DEMO}/web-handoff`)
      )
      addAssertion('one admin-surface handoff POST', adminHandoffs.length === 1 && String(adminHandoffs[0]?.body ?? '').includes('"surface":"admin"'), '1 次 surface=admin', JSON.stringify(adminHandoffs).slice(0, 300), 'P1')
      note(JSON.stringify(state).slice(0, 500))
      await shot(page, 'overlay-ready')
    })

    await runStep('B', '外壳/状态栏/空态', async () => {
      await t(page, 'cloud-simple-workspace').waitFor()
      const body = await demoText(page)
      const status = await t(page, 'cloud-simple-workspace-status-bar').innerText()
      addAssertion('two-pane shell with file/git tabs and + 终端', /文件/.test(body) && /Git 变更/.test(body) && /\+ 终端/.test(body), '文件/Git 变更/+ 终端', body.slice(0, 200), 'P1')
      addAssertion('status bar shows project/E2EE/route/branch/path', /demo-app/.test(status) && /E2EE/.test(status) && /直连|中继/.test(status) && /main/.test(status) && /\.orca-worktrees/.test(status), '项目/E2EE/路线/分支/路径', status.replaceAll('\n', ' | '), 'P1')
      addAssertion('empty state copy', /从右侧文件树打开文件/.test(body), '从右侧文件树打开文件', body.match(/从右侧文件树打开文件[^\n]*/)?.[0] ?? 'missing', 'P2')
      await shot(page, 'shell-status')
    })

    await runStep('B', '文件树：根节点与目录展开', async () => {
      const rootNodes = await demoFrame(page).evaluate(() =>
        [...document.querySelectorAll('[data-testid^="cloud-workspace-file-tree-node-"]')].map((el) =>
          el.getAttribute('data-testid').replace('cloud-workspace-file-tree-node-', '')
        )
      )
      addAssertion('root lists docs/src/README.md and hides .git', ['docs', 'src', 'README.md'].every((x) => rootNodes.includes(x)) && !rootNodes.some((x) => x.includes('.git')), 'docs/src/README.md, no .git', JSON.stringify(rootNodes), 'P1')
      await expandParents(page, 'docs/r2-fixtures/r2-markdown.md')
      const visible = await demoText(page)
      addAssertion('expanded tree shows docs subtree', /r2-fixtures|design\.md/.test(visible), 'docs 子项可见', visible.slice(0, 160), 'P2')
      await shot(page, 'file-tree-root')
    })

    await runStep('B', '终端：新建 + 实时 + 执行命令', async () => {
      await t(page, 'cloud-simple-workspace-new-terminal').click()
      await demoFrame(page).locator('.xterm:visible').first().waitFor({ timeout: 40000 })
      for (let i = 0; i < 60; i += 1) {
        const state = await demoFrame(page).evaluate(() => document.querySelector('[data-testid="cloud-terminal-state"]')?.textContent ?? '')
        if (state.includes('实时')) break
        await sleep(500)
      }
      const terminalState = await demoFrame(page).evaluate(() => document.querySelector('[data-testid="cloud-terminal-state"]')?.textContent ?? '')
      addAssertion('terminal state is 实时', /实时/.test(terminalState), '实时', terminalState, 'P0')
      const marker = path.join(WT, 'docs/r2-manreview-terminal-marker')
      try { fs.unlinkSync(marker) } catch {}
      await demoFrame(page).locator('.xterm-screen:visible').first().click()
      await page.keyboard.type(`touch ${JSON.stringify(marker)}`)
      await page.keyboard.press('Enter')
      let exists = false
      const deadline = Date.now() + 12000
      while (Date.now() < deadline) {
        if (fs.existsSync(marker)) { exists = true; break }
        await sleep(300)
      }
      addAssertion('command executes on host', exists, '宿主出现 marker 文件', String(exists), 'P0')
      events.newTerminalMarkers.push({ marker, exists })
      await shot(page, 'terminal-live')
    })

    await runStep('B', '编辑器：打开 + 编辑 + dirty + 保存', async () => {
      await clickFileNode(page, 'README.md')
      await waitTab(page, 'README.md')
      await demoFrame(page).locator('.monaco-editor:visible').first().waitFor({ timeout: 30000 })
      await sleep(500)
      const marker = `manreviewedit${Date.now()}`
      const typed = await monacoAppend(page, `\n${marker}`)
      await sleep(700)
      addAssertion('buffer receives the typed marker', typed, 'Monaco 模型含 marker', String(typed), 'P1')
      const dirtyTab = await t(page, 'cloud-simple-workspace-tab-dirty-file:README.md').count()
      const statusDirty = await t(page, 'cloud-simple-workspace-status-dirty').count()
      let parentDirty = ''
      try {
        await page.waitForFunction(() => {
          const el = document.querySelector('#workspaceOverlay [data-workspace-dirty]')
          return el && el.hidden === false
        }, { timeout: 6000 })
        parentDirty = await parent(page, '#workspaceOverlay [data-workspace-dirty]').innerText()
      } catch { parentDirty = 'not-visible' }
      addAssertion('edit marks tab/status/overlay dirty', dirtyTab > 0 && statusDirty > 0 && /未保存文件/.test(parentDirty), '三处 dirty', JSON.stringify({ dirtyTab, statusDirty, parentDirty }), 'P0')
      await shot(page, 'editor-dirty')
      await t(page, 'cloud-workspace-file-tab-save').click()
      let cleared = false
      let hasMarker = false
      const deadline = Date.now() + 20000
      while (Date.now() < deadline) {
        cleared = (await t(page, 'cloud-simple-workspace-tab-dirty-file:README.md').count()) === 0
        hasMarker = fs.readFileSync(path.join(WT, 'README.md'), 'utf8').includes(marker)
        if (cleared && hasMarker) break
        await sleep(300)
      }
      addAssertion('save writes host file and clears dirty', cleared && hasMarker, '磁盘含 marker + dirty 清空', JSON.stringify({ cleared, hasMarker }), 'P0')
      await shot(page, 'editor-saved')
    })

    await runStep('B', 'Markdown 双模式（预览/编辑 + XSS）', async () => {
      await clickFileNode(page, 'docs/r2-fixtures/r2-markdown.md')
      await waitTab(page, 'docs/r2-fixtures/r2-markdown.md')
      await demoFrame(page).locator('.monaco-editor:visible').first().waitFor({ timeout: 30000 })
      await t(page, 'cloud-workspace-file-tab-mode-preview').click()
      await t(page, 'cloud-workspace-markdown-preview').waitFor({ timeout: 30000 })
      await sleep(700)
      const rendered = await t(page, 'cloud-workspace-markdown-preview').evaluate((root) => ({
        h1: root.querySelector('h1')?.textContent ?? '',
        h2Count: root.querySelectorAll('h2').length,
        tableRows: root.querySelectorAll('table tr').length,
        code: root.querySelector('pre code')?.textContent ?? '',
        linkTarget: root.querySelector('a[href="https://orca.example.com"]')?.getAttribute('target') ?? '',
        katex: root.querySelectorAll('.katex').length,
        details: root.querySelectorAll('details').length,
        scripts: root.querySelectorAll('script').length,
        iframes: root.querySelectorAll('iframe').length,
        onerrorAttrs: root.querySelectorAll('[onerror]').length,
        jsHrefs: [...root.querySelectorAll('a')].filter((a) => (a.getAttribute('href') ?? '').startsWith('javascript:')).length
      }))
      addAssertion('GFM headings/table/code/link render', rendered.h1.includes('R2 Markdown') && rendered.h2Count >= 5 && rendered.tableRows >= 3 && rendered.code.includes('const answer') && rendered.linkTarget === '_blank', '完整 GFM', JSON.stringify(rendered).slice(0, 300), 'P1')
      addAssertion('katex renders', rendered.katex > 0, 'katex > 0', String(rendered.katex), 'P2')
      addAssertion('XSS surface stripped', rendered.scripts === 0 && rendered.iframes === 0 && rendered.onerrorAttrs === 0 && rendered.jsHrefs === 0, 'script/iframe/onerror/js=0', JSON.stringify(rendered).slice(0, 200), 'P0')
      const xssFlag = await demoFrame(page).evaluate(() => window.__r2Xss ?? null)
      addAssertion('XSS marker never executed', xssFlag === null, 'undefined', String(xssFlag), 'P0')
      await shot(page, 'markdown-preview')
      await t(page, 'cloud-workspace-file-tab-mode-edit').click()
      await demoFrame(page).locator('.monaco-editor:visible').first().waitFor({ timeout: 20000 })
      addAssertion('edit mode shows Monaco source', true, 'Monaco 可见', 'ok', 'P1')
      await shot(page, 'markdown-edit')
    })

    await runStep('B', '预览：图片 data URL', async () => {
      await clickFileNode(page, 'docs/r2-fixtures/r2-sample.png')
      await waitTab(page, 'docs/r2-fixtures/r2-sample.png')
      await t(page, 'cloud-workspace-preview-tab').waitFor({ timeout: 30000 })
      const img = t(page, 'cloud-workspace-preview-image')
      await img.waitFor({ timeout: 30000 })
      await sleep(400)
      const info = await img.evaluate((el) => ({
        src: el.getAttribute('src')?.slice(0, 30),
        naturalWidth: el.naturalWidth,
        naturalHeight: el.naturalHeight
      }))
      const badge = await t(page, 'cloud-workspace-preview-kind').innerText()
      addAssertion('image renders from data URL', info.src?.startsWith('data:image/') && info.naturalWidth > 0, 'data:image + naturalWidth>0', JSON.stringify({ info, badge }), 'P1')
      await shot(page, 'preview-image')
    })

    await runStep('B', '预览：HTML 沙箱', async () => {
      await clickFileNode(page, 'docs/r2-fixtures/r2-sample.html')
      await waitTab(page, 'docs/r2-fixtures/r2-sample.html')
      const frameEl = t(page, 'cloud-workspace-preview-html-frame')
      await frameEl.waitFor({ timeout: 30000 })
      await sleep(800)
      const attrs = await frameEl.evaluate((el) => ({
        sandbox: el.getAttribute('sandbox'),
        referrer: el.getAttribute('referrerpolicy')
      }))
      const child = demoFrame(page).childFrames().find((f) => f.url().startsWith('about:srcdoc'))
      const childInfo = child
        ? await child.evaluate(() => ({
            text: document.body.innerText.slice(0, 120),
            scriptRan: document.body.getAttribute('data-script-ran'),
            imgError: document.body.getAttribute('data-img-error')
          }))
        : null
      addAssertion('HTML sandbox empty + no-referrer', attrs.sandbox === '' && attrs.referrer === 'no-referrer', "sandbox='' / no-referrer", JSON.stringify(attrs), 'P0')
      addAssertion('scripts and onerror blocked', childInfo?.scriptRan === null && childInfo?.imgError === null && /R2 HTML 沙箱样本/.test(childInfo?.text ?? ''), 'srcdoc 正文可见、脚本未执行', JSON.stringify(childInfo), 'P0')
      await shot(page, 'preview-html')
    })

    await runStep('B', 'Git 变更：分组与提交', async () => {
      await t(page, 'cloud-simple-workspace-right-tab-git').click()
      await t(page, 'cloud-workspace-git-panel').waitFor({ timeout: 30000 })
      await sleep(1200)
      const porcelain = execFileSync('git', ['-c', 'core.quotepath=false', 'status', '--porcelain', '--untracked-files=all'], { cwd: WT, encoding: 'utf8' }).trim().split('\n').filter(Boolean)
      const commitCount = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: WT, encoding: 'utf8' }).trim()
      const panel = await t(page, 'cloud-workspace-git-panel').evaluate((root) => {
        const groups = [...root.querySelectorAll('[data-testid^="cloud-workspace-git-group-"]')].map((g) => ({
          status: g.getAttribute('data-testid').replace('cloud-workspace-git-group-', ''),
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
      addAssertion('untracked group matches git status', actualUntracked.length >= 10 && missing.length === 0, 'untracked >=10 且全部在面板', JSON.stringify({ porcelain: actualUntracked.length, panel: panelUntracked.length, missing }), 'P1')
      addAssertion('history commit count matches', panel.commits.length === Number(commitCount), `${commitCount} commits`, String(panel.commits.length), 'P1')
      note(JSON.stringify(panel.groups.map((g) => [g.status, g.files.length])))
      await shot(page, 'git-panel')
    })

    await runStep('B', '提交 diff：懒加载 + 左右/合并切换', async () => {
      const first = demoFrame(page).locator('[data-testid^="cloud-workspace-git-commit-"]:not([data-testid*="-file"])').first()
      await first.click()
      await sleep(1500)
      const rows = demoFrame(page).locator('[data-testid^="cloud-workspace-git-commit-file-"]')
      const count = await rows.count()
      addAssertion('commit expands to file rows', count >= 1, '>=1 提交文件', String(count), 'P1')
      if (count === 0) return
      const rel = await rows.first().evaluate((el) => el.getAttribute('data-testid').replace('cloud-workspace-git-commit-file-', ''))
      await rows.first().click()
      await waitTab(page, rel)
      await t(page, 'cloud-workspace-diff-tab').waitFor({ timeout: 30000 })
      // Wait for the lazy diff fetch to finish before judging the badge/shot.
      await t(page, 'cloud-workspace-diff-loading').waitFor({ state: 'detached', timeout: 30000 }).catch(() => {})
      const source = await t(page, 'cloud-workspace-diff-source').innerText()
      addAssertion('commit diff source badge 提交', /提交/.test(source), '提交 <sha>', source, 'P1')
      const initial = await t(page, 'cloud-workspace-diff-mode-side-by-side').getAttribute('aria-pressed')
      await t(page, 'cloud-workspace-diff-mode-inline').click()
      const inline = await t(page, 'cloud-workspace-diff-mode-inline').getAttribute('aria-pressed')
      await t(page, 'cloud-workspace-diff-mode-side-by-side').click()
      const back = await t(page, 'cloud-workspace-diff-mode-side-by-side').getAttribute('aria-pressed')
      addAssertion('左右/合并 toggle works', initial === 'true' && inline === 'true' && back === 'true', 'aria-pressed 翻转', JSON.stringify({ initial, inline, back }), 'P1')
      // The diff pane lazy-loads its Monaco module; wait for real lines before
      // the screenshot, otherwise the evidence only shows 「正在加载编辑器…」.
      const diffPane = demoFrame(page).locator('[data-testid="cloud-workspace-diff-tab"]:visible')
      await diffPane.locator('.monaco-diff-editor').first().waitFor({ timeout: 30000 }).catch(() => {})
      await demoFrame(page).locator('.view-line:visible').first().waitFor({ timeout: 30000 }).catch(() => {})
      await sleep(1000)
      const diffLines = await demoFrame(page)
        .locator('[data-testid="cloud-workspace-diff-tab"]:visible .view-line')
        .count()
        .catch(() => 0)
      addAssertion('commit diff renders Monaco lines', diffLines > 0, '>0 行', String(diffLines), 'P1')
      await shot(page, 'diff-commit-modes')
    })

    await runStep('B', '工作区 diff：UI 保存后在「修改」组出现', async () => {
      await t(page, 'cloud-simple-workspace-right-tab-files').click().catch(() => {})
      await clickFileNode(page, 'README.md')
      await demoFrame(page).locator('.monaco-editor:visible').first().waitFor({ timeout: 30000 })
      await sleep(400)
      const marker = `manreviewworking${Date.now()}`
      // The probe is a single global and may point at another mounted editor
      // here; the diff-content assertion below is the end-to-end oracle.
      await monacoAppend(page, `\n${marker}`)
      await sleep(500)
      await t(page, 'cloud-workspace-file-tab-save').click()
      await sleep(1500)
      await t(page, 'cloud-simple-workspace-right-tab-git').click()
      await t(page, 'cloud-workspace-git-refresh').click()
      await sleep(1500)
      const row = demoFrame(page).locator('[data-testid="cloud-workspace-git-change-README.md"]')
      addAssertion('saved edit appears in modified group', (await row.count()) > 0, 'README.md 修改行', String(await row.count()), 'P1')
      if ((await row.count()) === 0) return
      await row.first().click()
      await t(page, 'cloud-workspace-diff-tab').waitFor({ timeout: 30000 })
      await t(page, 'cloud-workspace-diff-loading').waitFor({ state: 'detached', timeout: 30000 }).catch(() => {})
      const source = await t(page, 'cloud-workspace-diff-source').innerText()
      let hasDiffText = false
      const diffDeadline = Date.now() + 20000
      while (Date.now() < diffDeadline) {
        hasDiffText = await demoFrame(page).evaluate((m) => document.body.innerText.includes(m), marker)
        if (hasDiffText) break
        await sleep(400)
      }
      addAssertion('working diff shows 工作区 source and change text', /工作区/.test(source) && hasDiffText, '工作区 + diff 内容', JSON.stringify({ source, hasDiffText }), 'P1')
      await shot(page, 'diff-working')
    })

    await runStep('B', '二进制 diff 降级', async () => {
      const binRow = demoFrame(page).locator('[data-testid="cloud-workspace-git-change-docs/r2-fixtures/r2-binary.bin"]')
      addAssertion('binary fixture row present', (await binRow.count()) > 0, 'r2-binary.bin 行', String(await binRow.count()), 'P2')
      if ((await binRow.count()) === 0) return
      await binRow.first().click()
      await t(page, 'cloud-workspace-diff-tab').waitFor({ timeout: 30000 })
      await sleep(1500)
      const binary = await t(page, 'cloud-workspace-diff-binary').count()
      const body = await demoText(page)
      addAssertion('binary diff shows binary notice', binary > 0 || /二进制/.test(body), '二进制提示', JSON.stringify({ binary, tail: body.slice(-160) }), 'P1')
      await shot(page, 'diff-binary')
    })

    await runStep('B', '多标签混合（终端/文件/预览/diff）', async () => {
      const ids = await tabIds(page)
      addAssertion('terminal + file + preview + diff coexist', ids.some((i) => i.startsWith('terminal-')) && ids.some((i) => i.startsWith('file:')) && ids.some((i) => i.startsWith('preview:')) && ids.some((i) => i.startsWith('diff:')), '四类标签共存', JSON.stringify(ids.slice(-10)), 'P1')
      await shot(page, 'tabs-mixed')
    })

    await runStep('B', '关闭握手：覆盖层 dirty 确认 + 移除', async () => {
      await t(page, 'cloud-simple-workspace-right-tab-files').click().catch(() => {})
      await clickFileNode(page, 'README.md')
      await demoFrame(page).locator('.monaco-editor:visible').first().waitFor({ timeout: 30000 })
      await sleep(400)
      await monacoAppend(page, `\nmanreview-close-${Date.now()}`)
      await sleep(700)
      let dirtyText = ''
      try {
        await page.waitForFunction(() => {
          const el = document.querySelector('#workspaceOverlay [data-workspace-dirty]')
          return el && el.hidden === false
        }, { timeout: 8000 })
        dirtyText = await parent(page, '#workspaceOverlay [data-workspace-dirty]').innerText()
      } catch { dirtyText = 'not-visible' }
      addAssertion('overlay dirty indicator visible', /未保存文件/.test(dirtyText), 'N 个未保存文件', dirtyText, 'P1')
      const urlBefore = workbenchUrl()
      const before = Date.now()
      // The global handler accepts the native confirm; this promise keeps its
      // message for the assertion even if the event lands after the click.
      const dialogPromise = page
        .waitForEvent('dialog', { timeout: 8000 })
        .then((d) => ({ type: d.type(), message: d.message() }))
        .catch(() => null)
      await parent(page, '#workspaceOverlay [data-workspace-close]').click()
      let removed = false
      const deadline = Date.now() + 12000
      while (Date.now() < deadline) {
        if ((await parent(page, '#workspaceOverlay').count()) === 0) { removed = true; break }
        await sleep(100)
      }
      const elapsed = Date.now() - before
      const dialog =
        (await Promise.race([dialogPromise, sleep(1500).then(() => null)])) ??
        events.dialogs.find((d) => d.segment === 'B' && /未保存文件/.test(d.message)) ??
        null
      addAssertion('native confirm shows dirty text', /有 \d+ 个文件未保存，确定关闭工作区/.test(dialog?.message ?? ''), '有 N 个文件未保存，确定关闭工作区？', dialog?.message ?? 'no dialog', 'P1')
      addAssertion('overlay removed after handshake', removed, 'overlay 消失', String(removed), 'P0')
      addAssertion('close completes within fallback window', elapsed < 5000, '< 5s', `${elapsed}ms`, 'P2')
      addAssertion('workbench URL unchanged', workbenchUrl() === urlBefore, urlBefore, workbenchUrl(), 'P2')
      note(JSON.stringify({ elapsed, dialog: dialog?.message }))
      await shot(page, 'closed-workbench')
    })

    await runStep('B', '二次打开（同项目）：ready 且空标签集', async () => {
      const state = await openOverlay(page, 'demo-app')
      addAssertion('second overlay ready', state?.ready === true, 'ready', JSON.stringify(state).slice(0, 300), 'P0')
      addAssertion('no NOT_SIGNED_IN failure', !/NOT_SIGNED_IN/.test(state?.failure ?? ''), '无 NOT_SIGNED_IN', state?.failure ?? '', 'P0')
      await sleep(800)
      const ids = await tabIds(page).catch(() => [])
      addAssertion('second open starts with empty tab set', ids.length === 0, '0 tabs', JSON.stringify(ids), 'P1')
      await shot(page, 'second-open-empty')
    })
  } finally {
    await context.close()
    // Leave the demo checkout as found (fixtures stay untracked by design).
    for (const rel of ['README.md', 'docs/design.md']) {
      try { execFileSync('git', ['checkout', '--', rel], { cwd: WT }) } catch {}
    }
  }
}

/* ---------------- C. R2 second-open three scenarios ---------------- */

async function reentryScenario(segment, name, firstKey, secondKey) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1600, height: 1000 }
  })
  const page = await context.newPage()
  watch(page, segment)
  page.setDefaultTimeout(30000)
  try {
    await runStep(segment, `二次打开-${name}：首开 → 关闭 → 二开`, async () => {
      await loginConsole(page)
      const first = await openOverlay(page, firstKey)
      await shot(page, `${name}-first`)
      addAssertion('first open ready', first?.ready === true, 'ready', JSON.stringify(first).slice(0, 250), 'P0')
      const closed = await closeOverlay(page)
      await sleep(1500)
      const second = await openOverlay(page, secondKey)
      await shot(page, `${name}-second`)
      addAssertion('overlay closed between opens', closed.closed === true, 'closed', JSON.stringify(closed), 'P0')
      addAssertion('second open ready', second?.ready === true, 'ready', JSON.stringify(second).slice(0, 250), 'P0')
      addAssertion('second open has no failure body', !second?.failure, '无失败态', second?.failure ?? '', 'P0')
      const frame = frameOf(page)
      const body = frame ? await frame.evaluate(() => document.body.innerText.slice(0, 200)).catch(() => '') : ''
      addAssertion('second frame is not NOT_SIGNED_IN', !/NOT_SIGNED_IN/.test(body), '无 NOT_SIGNED_IN', body.slice(0, 120), 'P0')
      note(JSON.stringify({ first: first?.ready, closed, second: second?.ready }))
    })
  } finally {
    await context.close()
  }
}

/* ---------------- main ---------------- */

let browser

async function main() {
  events.generatedAt = new Date().toISOString()
  browser = await chromium.launch({ headless: true })
  await segmentA()
  await segmentB()
  await reentryScenario('C', 'same-project', 'demo-app', 'demo-app')
  await reentryScenario('C', 'different-project', 'demo-app', 'zhangsan-demo')
  await reentryScenario('C', 'cross-host', 'demo-app', 'infra-tools')
}

function writeEvidence() {
  const assertions = steps.flatMap((s) => s.assertions.map((a) => ({ stepId: s.id, ...a })))
  const failed = assertions.filter((a) => !a.ok)
  const findings = failed.map((a, index) => ({
    id: `F${String(index + 1).padStart(2, '0')}`,
    stepId: a.stepId,
    severity: a.severity ?? 'P1',
    title: a.name,
    expected: a.expected,
    actual: a.actual
  }))
  const result = {
    feature: 'U63 manual re-verification — cloud dev platform: Orca Web + embedded workspace',
    generatedAt: events.generatedAt,
    finishedAt: new Date().toISOString(),
    base: BASE,
    environment: {
      demoWorktree: WT,
      zhangsanWorktree: WT_ZHANGSAN,
      infraWorktree: WT2,
      webBundle: 'out/web (VITE_EXPOSE_STORE=true)'
    },
    summary: {
      steps: steps.length,
      stepsPassed: steps.filter((s) => s.ok).length,
      assertions: assertions.length,
      assertionsPassed: assertions.length - failed.length,
      screenshots: steps.reduce((n, s) => n + s.screenshots.length, 0),
      findings: findings.length
    },
    steps,
    network: {
      handoffs: events.handoffs,
      redeem: events.redeem,
      httpFailures: events.httpFailures,
      consoleErrors: events.consoleErrors,
      dialogs: events.dialogs
    },
    screenshots: steps.flatMap((s) => s.screenshots)
  }
  fs.writeFileSync(path.join(OUT, 'steps.json'), JSON.stringify(result, null, 2))
  fs.writeFileSync(
    path.join(OUT, 'findings.json'),
    JSON.stringify({ generatedAt: result.finishedAt, base: BASE, findings }, null, 2)
  )
  console.log(`\nwritten ${path.join(OUT, 'steps.json')}`)
  console.log(
    `steps ${result.summary.stepsPassed}/${result.summary.steps} · ` +
      `assertions ${result.summary.assertionsPassed}/${result.summary.assertions} · ` +
      `screenshots ${result.summary.screenshots} · findings ${result.summary.findings}`
  )
  return result
}

main()
  .catch((error) => {
    console.error('FATAL', error)
    if (current) {
      current.error = error instanceof Error ? error.message : String(error)
      current.ok = false
      steps.push(current)
      current = null
    }
  })
  .finally(async () => {
    try {
      await browser?.close()
    } catch {}
    writeEvidence()
  })
