#!/usr/bin/env node
// Differential probe: create a terminal tab via the + menu before and after a reload.
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const BASE = 'https://127.0.0.1:18787'
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
const state = (p) =>
  p.evaluate(() => ({
    url: location.href.replace(/#.*/, ''),
    overlay: (document.body.innerText || '').includes('Opening the project workspace'),
    appLayout: document.querySelector('.app-layout') !== null,
    tabs: [...document.querySelectorAll('[data-testid="sortable-tab"]')].map((el) =>
      el.getAttribute('data-tab-title')
    ),
    xterm: document.querySelectorAll('.xterm').length,
    termText: [...document.querySelectorAll('.xterm-rows')]
      .map((el) => el.textContent ?? '')
      .join('\n')
      .slice(-500)
  }))
async function dismiss(p) {
  for (let i = 0; i < 6; i += 1) {
    const d = p.locator('[role="dialog"]').first()
    if ((await d.count()) === 0) return i
    const c = d.getByRole('button', { name: 'Close' }).first()
    if (await c.count()) await c.click({ timeout: 4000 }).catch(() => {})
    else await p.keyboard.press('Escape')
    await sleep(400)
  }
  return -1
}
async function menuTry(p, tag) {
  const btns = await p.getByRole('button', { name: 'New tab' }).count()
  await p.getByRole('button', { name: 'New tab' }).first().click({ timeout: 15_000 })
  await sleep(600)
  const items = await p.locator('[role="menuitem"]').allTextContents()
  out.steps[tag + ':menu'] = { buttons: btns, items }
  const item = p.getByRole('menuitem', { name: /New Terminal/ }).first()
  const itemText = (await item.count()) ? await item.textContent() : null
  out.steps[tag + ':item'] = itemText
  if (itemText)
    await item
      .click({ timeout: 10_000 })
      .catch((e) => (out.steps[tag + ':clickError'] = String(e).slice(0, 300)))
  else await p.keyboard.press('Escape')
}
try {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await page.locator('#loginForm').waitFor({ state: 'visible' })
  await page.fill('#username', 'admin')
  await page.fill('#password', 'Adm1n!')
  await page.click('#loginBtn')
  await page.locator('#view-app').waitFor({ state: 'visible' })
  const pp = context.waitForEvent('page', { timeout: 60_000 })
  await page.locator('tr', { hasText: 'demo' }).first().locator('[data-orca-web]').click()
  popup = await pp
  popup.setDefaultTimeout(90_000)
  popup.on('dialog', (d) => d.accept())
  popup.on('console', (m) => {
    if (m.type() === 'error' && !/favicons|ERR_CONNECTION|Failed to load resource/.test(m.text())) {
      errs.push({ where: out.phase, text: m.text().slice(0, 400) })
    }
  })
  popup.on('pageerror', (e) => errs.push({ where: out.phase, pageerror: String(e).slice(0, 400) }))
  await popup.waitForSelector('.app-layout', { timeout: 90_000 })
  await dismiss(popup)
  await sleep(10_000)
  out.phase = 'fresh'
  out.steps.fresh = await state(popup)
  // Baseline: restored terminal should accept input before any reload.
  await popup.locator('.xterm').last().click()
  await popup.keyboard.type('echo FRESH_INPUT_OK')
  await popup.keyboard.press('Enter')
  await sleep(2500)
  out.steps.freshAfterInput = await state(popup)
  out.steps.freshInputOk = out.steps.freshAfterInput.termText.includes('FRESH_INPUT_OK')

  // Pre-reload: create a second terminal tab.
  out.phase = 'fresh-tab'
  await menuTry(popup, 'freshTab')
  for (const wait of [1500, 5000, 15000, 20000]) {
    await sleep(wait)
    out.steps[`freshTab+${wait}`] = await state(popup)
    if ((out.steps[`freshTab+${wait}`].tabs ?? []).length >= 2) break
  }
  out.steps.freshTabOk = (out.steps['freshTab+20000']?.tabs ?? []).length >= 2

  // Reload, settle longer, then try again.
  out.phase = 'after-reload'
  await popup.reload({ waitUntil: 'domcontentloaded' })
  await popup.waitForSelector('.app-layout', { timeout: 90_000 })
  await dismiss(popup)
  for (const wait of [3000, 5000, 7000]) {
    await sleep(wait)
    out.steps[`reload+${wait}`] = await state(popup)
  }
  await popup
    .locator('.xterm')
    .last()
    .click()
    .catch(() => {})
  await popup.keyboard.type('echo POST_RELOAD_INPUT_OK')
  await popup.keyboard.press('Enter')
  await sleep(3000)
  out.steps.reloadInput = await state(popup)
  out.steps.reloadInputOk = out.steps.reloadInput.termText.includes('POST_RELOAD_INPUT_OK')

  out.phase = 'reload-tab'
  await menuTry(popup, 'reloadTab')
  for (const wait of [1500, 5000, 15000, 20000]) {
    await sleep(wait)
    out.steps[`reloadTab+${wait}`] = await state(popup)
    if ((out.steps[`reloadTab+${wait}`].tabs ?? []).length >= 2) break
  }
  out.steps.reloadTabOk = (out.steps['reloadTab+20000']?.tabs ?? []).length >= 2
  out.errors = errs
} catch (error) {
  out.failure = String(error).slice(0, 1200)
  await (popup ?? page).screenshot({ path: path.join(OUT, 'probe-failure.png') }).catch(() => {})
} finally {
  out.errors = errs
  fs.writeFileSync(path.join(OUT, 'probe-tabcreate.json'), JSON.stringify(out, null, 2))
  await browser.close()
}
console.log(JSON.stringify(out, null, 2))
