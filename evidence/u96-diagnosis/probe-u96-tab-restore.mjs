#!/usr/bin/env node
/**
 * U96 diagnosis probe (read-only): open the embedded simple workspace, open a
 * file tab + terminal tab, close/reopen the overlay and reload the console,
 * then dump the tab strip and storage. No repo code changes.
 */
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const BASE = process.env.ORCA_QA_BASE ?? 'https://127.0.0.1:18787'
const USER = process.env.ORCA_QA_USER ?? 'admin'
const PASS = process.env.ORCA_QA_PASS ?? 'Adm1n!'
const OUT = path.resolve('evidence/u96-diagnosis')
fs.mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const MARK = `U96-MARK-${Date.now()}`

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1440, height: 900 }
})
const page = await context.newPage()
page.setDefaultTimeout(30_000)
page.on('dialog', (d) => d.accept())
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 300)))

const adminFrame = () => page.frames().find((f) => f.url().includes('/cloud-admin.html'))
const out = { base: BASE, marker: MARK, steps: {} }

async function storageOf(frame) {
  if (!frame) return null
  return frame.evaluate(() => {
    const dump = (s) => {
      const o = {}
      for (let i = 0; i < s.length; i += 1) {
        const k = s.key(i)
        o[k] = String(s.getItem(k)).slice(0, 400)
      }
      return o
    }
    return {
      origin: location.origin,
      localStorage: dump(localStorage),
      sessionStorage: dump(sessionStorage)
    }
  })
}

async function wsState(label, shot) {
  const frame = adminFrame()
  const tabs = frame
    ? await frame.evaluate(() =>
        [
          ...document.querySelectorAll(
            '[data-testid^="cloud-simple-workspace-tab-"][data-testid$="}"], [role="tab"]'
          )
        ].map((el) => ({ text: (el.textContent ?? '').trim(), id: el.getAttribute('data-testid') }))
      )
    : null
  const state = frame
    ? await frame.evaluate(() => ({
        workspace: !!document.querySelector('[data-testid="cloud-simple-workspace"]'),
        tabCount: document.querySelectorAll('[role="tab"]').length,
        empty:
          document.querySelector('[data-testid="cloud-simple-workspace-empty-state"]')?.innerText ??
          null,
        terminalPanels: document.querySelectorAll('[data-testid="cloud-terminal-panel"]').length,
        terminalText:
          document.querySelector('[data-testid="cloud-terminal-panel"]')?.innerText ?? null
      }))
    : null
  const overlay = await page.evaluate(() => {
    const o = document.querySelector('#workspaceOverlay')
    if (!o) return null
    return {
      route: o.querySelector('[data-workspace-route]')?.textContent ?? '',
      dirty: o.querySelector('[data-workspace-dirty]')?.textContent ?? '',
      status: o.querySelector('[data-workspace-status]')?.textContent ?? '',
      failure: o.querySelector('[data-workspace-ready-failure]')?.textContent?.slice(0, 160) ?? ''
    }
  })
  if (shot) await page.screenshot({ path: path.join(OUT, shot) })
  const storage = await storageOf(frame)
  out.steps[label] = { tabs, state, overlay, storage }
  console.log(
    label,
    JSON.stringify(
      { tabs, state, overlay, storageKeys: storage ? Object.keys(storage.localStorage) : null },
      null,
      2
    )
  )
}

async function login() {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await page.locator('#loginForm').waitFor({ state: 'visible' })
  await page.fill('#username', USER)
  await page.fill('#password', PASS)
  await page.click('#loginBtn')
  await page.locator('#view-app').waitFor({ state: 'visible' })
}

async function openDemo() {
  await page
    .locator('tr', { hasText: 'demo-app' })
    .getByRole('button', { name: '打开', exact: true })
    .click()
  await page.locator('#workspaceOverlay iframe').waitFor({ state: 'attached' })
  // Wait for the iframe document and the workspace shell.
  const frame = await page
    .waitForFunction(
      () => {
        const f = [...document.querySelectorAll('#workspaceOverlay iframe')][0]
        return (
          f &&
          f.contentDocument &&
          f.contentDocument.querySelector('[data-testid="cloud-simple-workspace"]')
        )
      },
      null,
      { timeout: 25_000 }
    )
    .catch(() => null)
  await sleep(1500)
  return frame !== null
}

try {
  await login()
  out.steps.consoleStorage = await storageOf(page.mainFrame())
  const ok = await openDemo()
  out.steps.openDemo = { workspaceShell: ok }
  await sleep(1000)
  await wsState('open-fresh', 'u96-1-open-fresh.png')

  // Open a terminal tab and run a marker command.
  const frame = adminFrame()
  await frame.locator('[data-testid="cloud-simple-workspace-new-terminal"]').click()
  await sleep(3000)
  await frame
    .locator('[data-testid="cloud-terminal-host"]')
    .click()
    .catch(() => {})
  await page.keyboard.type(`echo ${MARK}`)
  await page.keyboard.press('Enter')
  await sleep(1500)
  await wsState('after-terminal', 'u96-2-after-terminal.png')

  // Open a file tab from the file tree (first file node).
  const nodes = frame.locator('[data-testid^="cloud-workspace-file-tree-node-"]')
  const nodeCount = await nodes.count()
  let openedFile = null
  if (nodeCount > 0) {
    for (let i = 0; i < Math.min(nodeCount, 6); i += 1) {
      const id = await nodes.nth(i).getAttribute('data-testid')
      // Directories toggle; files open. Try dirs first to reveal a file.
      await nodes
        .nth(i)
        .locator('button, [role="button"]')
        .first()
        .click()
        .catch(async () => {
          await nodes
            .nth(i)
            .click()
            .catch(() => {})
        })
      await sleep(700)
      const after = await nodes.count()
      if (after > nodeCount) break
    }
    const files = frame.locator('[data-testid^="cloud-workspace-file-tree-node-"]')
    const n2 = await files.count()
    for (let i = n2 - 1; i >= 0; i -= 1) {
      const el = files.nth(i)
      const aria = await el.getAttribute('aria-expanded')
      if (aria === null) {
        await el.click().catch(() => {})
        await sleep(800)
        openedFile = await el.getAttribute('data-testid')
        break
      }
    }
  }
  out.steps.fileClick = { nodeCount, openedFile }
  await sleep(1200)
  await wsState('after-file', 'u96-3-after-file.png')

  // Close the overlay, then reopen the same project.
  await page.locator('#workspaceOverlay [data-workspace-close]').click()
  await sleep(1200)
  await openDemo()
  await sleep(2500)
  await wsState('reopen-overlay', 'u96-4-reopen-overlay.png')

  // Full page reload (closes everything), then reopen.
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page
    .locator('#view-app')
    .waitFor({ state: 'visible', timeout: 25_000 })
    .catch(() => {})
  await sleep(1200)
  out.steps.afterReloadConsoleStorage = await storageOf(page.mainFrame())
  await openDemo()
  await sleep(2500)
  await wsState('reopen-after-reload', 'u96-5-reopen-after-reload.png')
} catch (error) {
  out.error = String(error).slice(0, 1000)
  await page.screenshot({ path: path.join(OUT, 'u96-error.png') }).catch(() => {})
} finally {
  out.errors = errors.slice(-10)
  fs.writeFileSync(path.join(OUT, 'u96-probe-result.json'), JSON.stringify(out, null, 2))
  await browser.close()
}
