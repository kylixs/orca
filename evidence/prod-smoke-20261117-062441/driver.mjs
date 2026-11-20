#!/usr/bin/env node
/**
 * Production-build (de-instrumented) real-host smoke, relay browser mode.
 * No window.__store oracle: DOM, geometry, screenshots only.
 * Usage: ORCA_BACKGROUND_LAUNCH=1 node driver.mjs
 */
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const TS = process.env.SMOKE_TS || String(Date.now())
const OUT = path.resolve(import.meta.dirname)
const SHOTS = path.join(OUT, 'screenshots')
fs.mkdirSync(SHOTS, { recursive: true })

const RELAY = 'https://100.67.197.59:18444/h/dev-local-02/web-index.html'
const API = 'https://127.0.0.1:18787'
const PROJECT = 'proj_c1cc0f50' // zhangsan-demo
const ENTRY = `${RELAY}?api=${encodeURIComponent(API)}&project=${PROJECT}`
const MARKER = `PROD-SMOKE-${TS}`

const steps = []
const consoleLog = []
const pageErrors = []
const requestFailures = []

function addStep(step, ok, evidence = {}, notes = '') {
  steps.push({ step, ok, at: new Date().toISOString(), evidence, notes })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${step} ${notes} ${JSON.stringify(evidence).slice(0, 400)}`)
}
const sleep = (ms) => page.waitForTimeout(ms)

let browser, context, page
async function shot(name) {
  const file = path.join(SHOTS, `${name}.png`)
  await page.screenshot({ path: file, fullPage: false }).catch((e) => {
    pageErrors.push(`screenshot ${name}: ${e.message}`)
  })
  return path.relative(OUT, file)
}

async function dom() {
  return page.evaluate(() => {
    const text = (el) => (el?.innerText ?? '').replace(/\s+/g, ' ').trim()
    const vis = (el) => !!el && (el.offsetParent !== null || el.getClientRects().length > 0)
    const boxes = (sel) =>
      [...document.querySelectorAll(sel)].filter(vis).map((el) => {
        const r = el.getBoundingClientRect()
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
      })
    return {
      url: location.href,
      title: document.title,
      hasAppLayout: !!document.querySelector('.app-layout'),
      hasSignInForm: !!document.querySelector('#web-cloud-api-url'),
      body: text(document.body).slice(0, 4000),
      tabs: [...document.querySelectorAll('[data-testid="sortable-tab"]')].map((el) => ({
        id: el.getAttribute('data-tab-id'),
        title: el.getAttribute('data-tab-title'),
        active: el.getAttribute('data-active'),
        visible: vis(el)
      })),
      visibleTabs: [...document.querySelectorAll('[data-testid="sortable-tab"]')].filter(vis).length,
      groupStrips: [...document.querySelectorAll('[data-tab-group-strip-id]')].filter(vis).length,
      groupBodies: [...document.querySelectorAll('[data-tab-group-body-id]')].filter(vis).length,
      groupBodyIds: [...document.querySelectorAll('[data-tab-group-body-id]')]
        .filter(vis)
        .map((el) => el.getAttribute('data-tab-group-body-id')),
      groupStripBoxes: boxes('[data-tab-group-strip-id]'),
      cloudSessionStored: !!localStorage.getItem('orca.webCloudSession'),
      runtimeEnvStored: !!localStorage.getItem('orca.web.runtimeEnvironment.v1'),
      xterms: boxes('.xterm'),
      xtermRows: [...document.querySelectorAll('.xterm')]
        .filter(vis)
        .map((w) =>
          [...w.querySelectorAll('.xterm-rows > div')].map((r) => r.textContent ?? '').join('\n')
        ),
      toasts: [...document.querySelectorAll('[data-sonner-toast], li[data-sonner-toast]')].map(text),
      alerts: [...document.querySelectorAll('[role="alert"]')].map(text),
      dialogs: [...document.querySelectorAll('[data-slot="dialog-content"]')].map(text).slice(0, 3),
      editorPaths: [...document.querySelectorAll('.editor-header-path')].filter(vis).map(text),
      activeTabTitles: [...document.querySelectorAll('[data-tab-id][data-active="true"]')]
        .filter(vis)
        .map(text),
      editorLines: [...document.querySelectorAll('.view-lines')].filter(vis).map((el) => text(el).slice(0, 400)),
      explorerShell: vis(document.querySelector('[data-orca-explorer-shell]')),
      explorerRows: [...document.querySelectorAll('[data-file-explorer-row]')].filter(vis).map(text).slice(0, 60),
      menus: [...document.querySelectorAll('[role="menu"],[data-radix-menu-content]')].filter(vis).map(text).slice(0, 5),
      buttons: [...document.querySelectorAll('button')]
        .filter(vis)
        .map((b) => b.getAttribute('aria-label') || text(b))
        .filter(Boolean)
        .slice(0, 60)
    }
  })
}

async function waitFor(fn, timeoutMs, interval = 500) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await fn()
      if (value) return value
    } catch {}
    await sleep(interval)
  }
  return null
}

async function clickNewTerminal(menuButtonLocator) {
  // A leftover context menu/dropdown intercepts the "+" trigger.
  await page.keyboard.press('Escape').catch(() => {})
  await sleep(250)
  await page.keyboard.press('Escape').catch(() => {})
  await sleep(250)
  const btn = menuButtonLocator
  await btn.click({ timeout: 10000 })
  await sleep(600)
  const item = page.locator('[role="menuitem"]', { hasText: /New Terminal|新终端/ }).first()
  await item.waitFor({ timeout: 8000 })
  await item.click({ timeout: 8000 })
  await sleep(1200)
}

async function terminalText() {
  // Web build renders terminals to canvas: `.xterm-rows` is empty. Use xterm's
  // select-all + copy path, then read the clipboard (real terminal text).
  try {
    await page.evaluate(() => {
      const tas = [...document.querySelectorAll('.xterm-helper-textarea')]
      const ta = tas.find((el) => el.offsetParent !== null || el.getClientRects().length > 0) ?? tas.at(-1)
      ta?.focus()
    })
    await page.keyboard.press('Meta+a')
    await sleep(300)
    await page.keyboard.press('Meta+c')
    await sleep(400)
    return await page.evaluate(() => navigator.clipboard.readText().catch(() => ''))
  } catch {
    return ''
  }
}

async function dismissBlockers() {
  for (let round = 0; round < 4; round += 1) {
    const overlay = await page.locator('[data-slot="dialog-overlay"]').count().catch(() => 0)
    if (overlay === 0) return true
    let clicked = false
    for (const label of [/^\s*Got it/i, /^\s*知道了/, /^\s*关闭/, /^Close$/, /开始听写/]) {
      const btn = page.locator('[data-slot="dialog-content"] button', { hasText: label }).first()
      if (await btn.isVisible().catch(() => false)) {
        await btn.click({ timeout: 3000 }).catch(() => {})
        clicked = true
        break
      }
    }
    if (!clicked) {
      const closeBtn = page.locator('[data-slot="dialog-content"] button[aria-label="Close"], [data-slot="dialog-content"] button[aria-label="关闭"]').first()
      if (await closeBtn.isVisible().catch(() => false)) {
        await closeBtn.click({ timeout: 3000 }).catch(() => {})
        clicked = true
      }
    }
    if (!clicked) await page.keyboard.press('Escape').catch(() => {})
    await sleep(700)
  }
  return (await page.locator('[data-slot="dialog-overlay"]').count().catch(() => 0)) === 0
}

async function focusTerminal() {
  return page.evaluate(() => {
    const tas = [...document.querySelectorAll('.xterm-helper-textarea')]
    const ta = tas.find((el) => el.offsetParent !== null || el.getClientRects().length > 0) ?? tas.at(-1)
    if (!ta) return false
    ta.focus()
    return true
  })
}

try {
  fs.writeFileSync(path.join(OUT, 'env.json'), JSON.stringify({ TS, ENTRY, MARKER, API, PROJECT }, null, 2))
  const profile = `/tmp/prod-smoke/profile-${TS}`
  context = await chromium.launchPersistentContext(profile, {
    headless: true,
    ignoreHTTPSErrors: true,
    viewport: { width: 1600, height: 1000 },
    locale: 'zh-CN',
    permissions: ['clipboard-read', 'clipboard-write'],
    args: ['--no-sandbox']
  })
  page = context.pages()[0] ?? (await context.newPage())
  page.setDefaultTimeout(30000)
  page.on('console', (m) => {
    if (consoleLog.length < 600) consoleLog.push({ type: m.type(), text: m.text().slice(0, 800) })
  })
  page.on('pageerror', (e) => {
    if (pageErrors.length < 200) pageErrors.push(e.message)
  })
  page.on('requestfailed', (r) => {
    if (requestFailures.length < 200)
      requestFailures.push({ url: r.url(), error: r.failure()?.errorText })
  })

  // ---------- 0. sign in through the production cloud entry ----------
  await page.goto(ENTRY, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.locator('#web-cloud-api-url').waitFor({ timeout: 30000 })
  const loginShot = await shot('00-login-form')
  await page.locator('#web-cloud-api-url').fill(API)
  await page.locator('#web-cloud-username').fill('zhangsan')
  await page.locator('#web-cloud-password').fill('Passw0rd!')
  await page.locator('button[type="submit"]').click()
  const shell = await waitFor(async () => {
    const d = await dom()
    if (d.hasAppLayout) return d
    if (/CONNECT_FAILED|PROJECT_NOT_VISIBLE|NO_PROJECTS|NO_OPENABLE|Connect failed|登录失败/i.test(d.body)) {
      return { failed: true, body: d.body }
    }
    return null
  }, 90000, 1000)
  if (!shell || shell.failed) {
    addStep('0-signin', false, { loginShot, shell, consoleLog: consoleLog.slice(-10) }, 'sign-in did not reach app-layout')
    throw new Error('sign-in failed')
  }
  await sleep(8000)
  const dismissed = await dismissBlockers()
  const afterLogin = await dom()
  addStep('0-signin', true, {
    url: afterLogin.url,
    tabs: afterLogin.tabs.length,
    xterms: afterLogin.xterms.length,
    onboardingDismissed: dismissed,
    body: afterLogin.body.slice(0, 300)
  }, 'workspace mounted')
  await shot('01-workspace-shell')

  // ---------- 1. workspace shell + terminal echo ----------
  let d1 = await dom()
  let terminalVisible = d1.xterms.length > 0
  if (!terminalVisible) {
    const newTabBtn = page.locator('button[aria-label="New tab"], button[aria-label="新标签页"]').first()
    await clickNewTerminal(newTabBtn)
    terminalVisible = !!(await waitFor(async () => (await dom()).xterms.length > 0, 30000))
    d1 = await dom()
  }
  let echoSeen = false
  let terminalClipped = ''
  if (terminalVisible) {
    await dismissBlockers()
    await focusTerminal()
    await page.keyboard.insertText(`echo ${MARKER}`)
    await page.keyboard.press('Enter')
    echoSeen = !!(await waitFor(async () => {
      const t = await terminalText()
      if (t.includes(MARKER)) {
        terminalClipped = t
        return true
      }
      return false
    }, 30000, 1200))
  }
  const d1b = await dom()
  addStep(
    '1-shell-terminal-echo',
    terminalVisible && echoSeen,
    {
      terminalVisible,
      echoSeen,
      xterms: d1b.xterms,
      tabCount: d1b.tabs.length,
      terminalTail: terminalClipped.slice(-400),
      dialogs: d1b.dialogs,
      shellShot: await shot('02-terminal-echo')
    },
    echoSeen ? `echo ${MARKER} read back from terminal clipboard selection` : 'echo not observed'
  )

  // ---------- 2. file tree -> README.md editor ----------
  let explorer = (await dom()).explorerShell
  if (!explorer) {
    const candidates = await page.evaluate(() =>
      [...document.querySelectorAll('button,[role="tab"],[role="button"]')]
        .filter((el) => el.offsetParent !== null)
        .map((el) => ({ aria: el.getAttribute('aria-label'), text: (el.innerText ?? '').trim().slice(0, 40) }))
        .filter((x) => /Explorer|Files|资源管理|文件/i.test(`${x.aria ?? ''} ${x.text}`))
        .slice(0, 20)
    )
    for (const c of candidates) {
      const loc = c.aria
        ? page.locator(`button[aria-label=${JSON.stringify(c.aria)}]`).first()
        : page.locator('button', { hasText: c.text }).first()
      await loc.click({ timeout: 5000 }).catch(() => {})
      await sleep(700)
      explorer = (await dom()).explorerShell
      if (explorer) break
    }
  }
  let openedFile = false
  let editorText = ''
  let editorPath = ''
  if (explorer) {
    await dismissBlockers()
    const row = page.locator('[data-orca-explorer-shell] [data-file-explorer-row]', { hasText: /README\.md/i }).first()
    const rowVisible = await row.isVisible().catch(() => false)
    if (rowVisible) await row.click({ timeout: 8000 }).catch((e) => pageErrors.push(`readme click: ${e.message}`))
    if (!rowVisible) {
      // try expanding src then README from root tree list
      const anyRow = page.locator('[data-orca-explorer-shell] [data-file-explorer-row]').first()
      if (await anyRow.isVisible().catch(() => false)) await anyRow.click().catch(() => {})
    }
    const settled = await waitFor(async () => {
      const d = await dom()
      const headerPath = d.editorPaths.find((x) => /README\.md/i.test(x)) ?? ''
      const activeEditor = d.activeTabTitles.some((x) => /README\.md/i.test(x))
      const previewText = /研发自助创建的演示项目|node src\/render\.js/.test(d.body)
      if ((headerPath || activeEditor) && previewText) {
        return {
          p: headerPath || d.activeTabTitles.find((x) => /README\.md/i.test(x)),
          lines: d.body.match(/zhangsan-demo[\s\S]{0,120}/)?.[0] ?? 'preview text present'
        }
      }
      return null
    }, 30000, 800)
    if (settled) {
      openedFile = true
      editorPath = settled.p
      editorText = settled.lines.slice(0, 200)
    }
  }
  const d2 = await dom()
  addStep('2-file-tree-readme', openedFile, {
    explorerShell: explorer,
    editorPath,
    editorText,
    activeTabTitles: d2.activeTabTitles,
    explorerRowSample: d2.explorerRows.slice(0, 12),
    shot: await shot('03-file-editor')
  }, openedFile ? `opened ${editorPath}` : `editor not opened (explorer=${explorer}, rows=${d2.explorerRows.length})`)

  // ---------- 3. new tab -> move tab to split right ----------
  const preSplit = await dom()
  const preTabIds = new Set(preSplit.tabs.map((t) => t.id))
  const preColumns = new Set(preSplit.xterms.map((b) => b.x)).size
  await dismissBlockers()
  await clickNewTerminal(page.locator('button[aria-label="New tab"], button[aria-label="新标签页"]').first())
  const d3a = await dom()
  const newTab = d3a.tabs.find((t) => !preTabIds.has(t.id)) ?? d3a.tabs.find((t) => t.active === 'true')
  await shot('04-new-tab')
  let splitWorked = false
  let splitEvidence = {}
  if (newTab) {
    const tabEl = page.locator(`[data-testid="sortable-tab"][data-tab-id=${JSON.stringify(newTab.id)}]`).first()
    await tabEl.click({ button: 'right', timeout: 8000 })
    await sleep(700)
    const moveTrigger = page
      .locator('[role="menuitem"]', { hasText: /Move Tab to Split|将标签页移至拆分|移动到分栏/ })
      .first()
    const triggerVisible = await moveTrigger.isVisible().catch(() => false)
    if (triggerVisible) {
      await moveTrigger.click({ timeout: 5000 }).catch(async () => moveTrigger.hover())
      await sleep(900)
      const rightItem = page.locator('[role="menuitem"]', { hasText: /^\s*Right|^\s*右/ }).first()
      await rightItem.waitFor({ timeout: 8000 }).catch(() => {})
      const rightVisible = await rightItem.isVisible().catch(() => false)
      if (rightVisible) await rightItem.click()
      await sleep(3500)
    }
    await page.keyboard.press('Escape').catch(() => {})
    await sleep(500)
    const d3 = await dom()
    const cols = d3.xterms.filter((b) => b.h > 40 && b.w > 100)
    const columnsNow = new Set(cols.map((b) => b.x)).size
    const stripColumns = new Set(d3.groupStripBoxes.map((b) => b.x)).size
    const groupsGrew = d3.groupStrips > preSplit.groupStrips
    // Two pane columns: a new group whose tab strip sits at a different x.
    splitWorked = groupsGrew && stripColumns >= 2
    splitEvidence = {
      newTabId: newTab.id,
      triggerVisible,
      groupsBefore: preSplit.groupStrips,
      groupsAfter: d3.groupStrips,
      runBodiesAfter: d3.groupBodies,
      groups: { strips: d3.groupStrips, bodies: d3.groupBodies, ids: d3.groupBodyIds },
      groupStripBoxes: d3.groupStripBoxes,
      stripColumns,
      columnsBefore: preColumns,
      columnsAfter: columnsNow,
      xtermBoxes: cols,
      toasts: d3.toasts,
      dialogs: d3.dialogs,
      bodyTail: d3.body.slice(-400),
      shot: await shot('05-split-right')
    }
  } else {
    splitEvidence = { toasts: d3a.toasts, body: d3a.body.slice(0, 500) }
  }
  addStep('3-new-tab-split-right', splitWorked, splitEvidence, splitWorked ? 'two pane columns observed' : 'no split geometry')

  // ---------- 4. close a newly created tab with one click ----------
  let closed = false
  let closeEvidence = {}
  {
    await dismissBlockers()
    const before = await dom()
    const beforeIds = new Set(before.tabs.map((t) => t.id))
    // Create the throwaway tab in the right-most pane (keep the split for step 5).
    const buttons = await page.evaluate(() =>
      [...document.querySelectorAll('button[aria-label="New tab"], button[aria-label="新标签页"]')]
        .filter((b) => b.offsetParent !== null)
        .map((b) => {
          const r = b.getBoundingClientRect()
          return { x: Math.round(r.x), y: Math.round(r.y) }
        })
    )
    const target = buttons.sort((a, b) => b.x - a.x)[0]
    if (target) {
      // Use bounding-box match to select the right-most new-tab button.
      const all = await page.locator('button[aria-label="New tab"], button[aria-label="新标签页"]').all()
      let chosen = null
      for (const b of all) {
        const bb = await b.boundingBox()
        if (bb && Math.round(bb.x) === target.x && Math.round(bb.y) === target.y) chosen = b
      }
      if (!chosen) chosen = all.at(-1)
      await clickNewTerminal(chosen)
    }
    const created = await waitFor(async () => {
      const d = await dom()
      const t = d.tabs.find((x) => !beforeIds.has(x.id))
      return t ?? null
    }, 20000, 500)
    if (created) {
      const closeBtn = page.locator(
        `[data-testid="sortable-tab"][data-tab-id=${JSON.stringify(created.id)}] [data-tab-close-button="true"]`
      ).first()
      const box = await closeBtn.boundingBox().catch(() => null)
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      } else {
        await closeBtn.click({ timeout: 5000 }).catch(() => {})
      }
      closed = !!(await waitFor(async () => {
        const d = await dom()
        return !d.tabs.some((t) => t.id === created.id)
      }, 5000, 400))
      const d4 = await dom()
      closeEvidence = {
        createdTabId: created.id,
        closeClickOnce: true,
        closed,
        remainingTabs: d4.tabs.length,
        groups: { strips: d4.groupStrips, bodies: d4.groupBodies },
        toasts: d4.toasts,
        dialogs: d4.dialogs,
        shot: await shot('06-close-tab')
      }
    } else {
      closeEvidence = { createdTabId: null, toasts: (await dom()).toasts }
    }
  }
  addStep('4-close-new-tab-one-click', closed, closeEvidence, closed ? 'tab gone after a single X click' : 'tab still present')

  // ---------- 5. refresh restores workspace + tab groups ----------
  const preRefresh = await dom()
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })
  const restored = await waitFor(async () => {
    const d = await dom()
    if (!d.hasAppLayout) return null
    if (d.xterms.length === 0) return null
    return d
  }, 60000, 1000)
  await sleep(6000)
  const d5 = await dom()
  const groupsKept = d5.groupStrips >= Math.min(2, preRefresh.groupStrips) && d5.groupBodies >= 1
  const tabsKept = d5.tabs.length >= 1
  const refreshOk = !!restored && !d5.hasSignInForm && groupsKept && tabsKept
  addStep('5-refresh-restore', refreshOk, {
    preRefresh: {
      tabs: preRefresh.tabs.map((t) => t.title),
      groups: { strips: preRefresh.groupStrips, bodies: preRefresh.groupBodies },
      xterms: preRefresh.xterms.length,
      cloudSessionStored: preRefresh.cloudSessionStored,
      runtimeEnvStored: preRefresh.runtimeEnvStored
    },
    afterRefresh: {
      url: d5.url,
      tabs: d5.tabs.map((t) => t.title),
      groups: { strips: d5.groupStrips, bodies: d5.groupBodies, ids: d5.groupBodyIds },
      xterms: d5.xterms,
      hasSignInForm: d5.hasSignInForm,
      toasts: d5.toasts,
      body: d5.body.slice(0, 400)
    },
    shot: await shot('07-after-refresh')
  }, refreshOk ? 'workspace and groups restored' : 'restore incomplete')
} catch (error) {
  addStep('fatal', false, {}, error instanceof Error ? `${error.message}\n${error.stack}` : String(error))
} finally {
  const result = {
    startedAt: new Date().toISOString(),
    TS,
    entry: ENTRY,
    marker: MARKER,
    steps,
    consoleErrors: consoleLog.filter((m) => m.type === 'error'),
    consoleAll: consoleLog,
    pageErrors,
    requestFailures
  }
  fs.writeFileSync(path.join(OUT, 'steps.json'), JSON.stringify(result, null, 2))
  fs.writeFileSync(path.join(OUT, 'console-errors.json'), JSON.stringify({
    consoleErrors: result.consoleErrors,
    pageErrors,
    requestFailures
  }, null, 2))
  try { await context?.close() } catch {}
  console.log('\nSUMMARY', JSON.stringify(steps.map((s) => ({ step: s.step, ok: s.ok })), null, 1))
  console.log('consoleErrors', result.consoleErrors.length, 'pageErrors', pageErrors.length, 'requestFailures', requestFailures.length)
}
