#!/usr/bin/env node
// Focused: reset to 1 tab, inspect the tab-create menu DOM, create one tab.
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const BASE = 'https://127.0.0.1:18787'
const USER = process.env.ORCA_QA_USER ?? 'zhangsan'
const PASS = process.env.ORCA_QA_PASS ?? 'Passw0rd!'
const OUT = path.resolve('evidence/u96-release-2')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = { steps: {}, errors: [] }
const errs = []
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1440, height: 900 }
})
const page = await context.newPage()
page.setDefaultTimeout(60_000)
page.on('dialog', (d) => d.accept())
let popup
const tabs = (p) =>
  p.evaluate(() =>
    [...document.querySelectorAll('[data-testid="sortable-tab"]')].map((el) => {
      const r = el.getBoundingClientRect()
      return {
        id: el.getAttribute('data-tab-id'),
        title: el.getAttribute('data-tab-title'),
        selected: el.getAttribute('aria-selected'),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) }
      }
    })
  )
async function dismiss(p, windowMs = 12_000) {
  const deadline = Date.now() + windowMs
  let closed = 0,
    quiet = 0
  while (Date.now() < deadline) {
    const d = p.locator('[role="dialog"]').first()
    if ((await d.count()) > 0) {
      const c = d.locator('[data-slot="dialog-close"]').first()
      if (await c.count()) await c.click({ timeout: 4000 }).catch(() => {})
      else await p.keyboard.press('Escape')
      closed += 1
      quiet = 0
      await sleep(800)
    } else {
      if (closed > 0) {
        quiet += 500
        if (quiet >= 1500) break
      }
      await sleep(500)
    }
  }
  return closed
}
try {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await page.locator('#loginForm').waitFor({ state: 'visible' })
  await page.fill('#username', USER)
  await page.fill('#password', PASS)
  await page.click('#loginBtn')
  await page.locator('#view-app').waitFor({ state: 'visible' })
  const pp = context.waitForEvent('page', { timeout: 60_000 })
  await page.locator('tr', { hasText: 'demo' }).first().locator('[data-orca-web]').click()
  popup = await pp
  popup.setDefaultTimeout(90_000)
  popup.on('dialog', (d) => d.accept())
  popup.on('console', (m) => {
    if (m.type() === 'error' && !/favicons|ERR_CONNECTION|Failed to load resource/.test(m.text()))
      errs.push(m.text().slice(0, 300))
  })
  popup.on('pageerror', (e) => errs.push(String(e).slice(0, 300)))
  await popup.waitForSelector('.app-layout', { timeout: 90_000 })
  out.tips = await dismiss(popup)
  await sleep(2000)
  out.steps.freshTabs = await tabs(popup)

  // Close tabs until one remains.
  for (let guard = 0; guard < 10; guard += 1) {
    const list = await tabs(popup)
    if (list.length <= 1) break
    const target = list.find((t) => t.selected !== 'true') ?? list[list.length - 1]
    const el = popup.locator(`[data-tab-id="${target.id}"]`).first()
    await el.click({ button: 'middle' }).catch(() => {})
    await sleep(400)
    if ((await tabs(popup)).length === list.length) {
      // Close via the tab's x button, then confirm if a dialog appears.
      const close = el.locator('[aria-label^="Close tab"]').first()
      if (await close.count()) await close.click({ timeout: 5000 }).catch(() => {})
      await sleep(800)
      const dlg = popup.locator('[role="dialog"]').first()
      if (await dlg.count()) {
        const btn = dlg.getByRole('button', { name: /Close|关闭|Don't save|Discard/ }).last()
        await btn.click({ timeout: 5000 }).catch(() => popup.keyboard.press('Enter'))
      }
    }
    await sleep(800)
  }
  out.steps.tabsAfterClose = await tabs(popup)

  // Open the tab-create menu and dump its surface.
  await popup.getByRole('button', { name: 'New tab' }).first().click({ timeout: 15_000 })
  await sleep(1200)
  out.steps.menu = await popup.evaluate(() => {
    const surfaces = [
      ...document.querySelectorAll(
        '[data-slot="dropdown-menu-content"],[role="menu"],[role="listbox"],[data-radix-popper-content-wrapper]'
      )
    ]
    return surfaces.map((el) => ({
      role: el.getAttribute('role'),
      slot: el.getAttribute('data-slot'),
      text: (el.innerText || '').replace(/\s+/g, ' ').slice(0, 500),
      html: el.innerHTML.slice(0, 300)
    }))
  })
  out.steps.menuTexts = await popup.locator('[role="menuitem"],[role="option"]').allTextContents()
  await popup.screenshot({ path: path.join(OUT, 'probe-create-menu.png') })

  // Click the visible "New Terminal" text regardless of role.
  const nt = popup.getByText('New Terminal', { exact: false }).first()
  out.steps.newTerminalCount = await nt.count()
  if (await nt.count())
    await nt.click({ timeout: 8000 }).catch((e) => (out.steps.clickError = String(e).slice(0, 200)))
  let created = null
  for (let i = 0; i < 30; i += 1) {
    await sleep(700)
    created = await tabs(popup)
    if (created.length > 1) break
  }
  out.steps.tabsAfterCreate = created
  out.steps.created = (created?.length ?? 0) > 1
  await popup.screenshot({ path: path.join(OUT, 'probe-create-after.png') })
  out.errors = errs
} catch (error) {
  out.failure = String(error).slice(0, 1200)
  await (popup ?? page)
    .screenshot({ path: path.join(OUT, 'probe-create-failure.png') })
    .catch(() => {})
} finally {
  out.errors = errs
  fs.writeFileSync(path.join(OUT, 'probe-create.json'), JSON.stringify(out, null, 2))
  await browser.close()
}
console.log(JSON.stringify(out, null, 2))
