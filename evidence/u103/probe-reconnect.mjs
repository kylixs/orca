#!/usr/bin/env node
/** U103 probe 2: after the refresh lands on WebConnect, can the user re-enter? */
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const BASE = 'https://127.0.0.1:18787'
const OUT = path.resolve('evidence/u103')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1440, height: 900 }
})
const out = { steps: {} }
const page = await context.newPage()
page.setDefaultTimeout(45_000)
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
await page.locator('#loginForm').waitFor({ state: 'visible' })
await page.fill('#username', 'admin')
await page.fill('#password', 'Adm1n!')
await page.click('#loginBtn')
await page.locator('#view-app').waitFor({ state: 'visible' })
await page.locator('tr', { hasText: 'demo' }).first().locator('[data-orca-web]').click()
const popup = await page.waitForEvent('popup', { timeout: 45_000 })
popup.setDefaultTimeout(90_000)
popup.on('dialog', (d) => d.accept())
const rec = { console: [], pageErrors: [], failed: [] }
popup.on('console', (m) => rec.console.push({ type: m.type(), text: m.text().slice(0, 400) }))
popup.on('pageerror', (e) => rec.pageErrors.push(String(e).slice(0, 400)))
popup.on('requestfailed', (r) =>
  rec.failed.push({ url: r.url().slice(0, 200), reason: r.failure()?.errorText })
)
out.steps.popup = rec
await popup.waitForSelector('.app-layout', { timeout: 90_000 })
await sleep(1500)
await popup.reload({ waitUntil: 'domcontentloaded' })
await sleep(6000)
out.steps.afterReload = await popup.evaluate(() => {
  const inputs = [...document.querySelectorAll('input')].map((i) => ({
    id: i.id,
    type: i.type,
    value: i.value,
    placeholder: i.placeholder
  }))
  const buttons = [...document.querySelectorAll('button')]
    .map((b) => (b.innerText || b.getAttribute('aria-label') || '').trim())
    .filter(Boolean)
  return {
    url: location.href,
    inputs,
    buttons: buttons.slice(0, 20),
    body: document.body.innerText.slice(0, 500)
  }
})
await popup.screenshot({ path: path.join(OUT, 'webconnect-form.png') }).catch(() => {})

// Try the visible cloud-account form.
const apiInput = popup.locator('#web-cloud-api-url')
const hasForm = await apiInput.isVisible().catch(() => false)
out.steps.hasCloudForm = hasForm
if (hasForm) {
  if (!(await apiInput.inputValue()).trim()) await apiInput.fill(BASE)
  await popup.fill('#web-cloud-username', 'admin')
  await popup.fill('#web-cloud-password', 'Adm1n!')
  const submit = popup.locator('form button[type="submit"]').last()
  await submit.click()
  const entered = await popup
    .waitForSelector('.app-layout', { timeout: 60_000 })
    .then(() => true)
    .catch(() => false)
  out.steps.reconnect = { enteredWorkspace: entered }
  await sleep(4000)
  out.steps.afterReconnect = await popup.evaluate(() => ({
    url: location.href,
    appLayout: !!document.querySelector('.app-layout'),
    body: document.body.innerText.slice(0, 600)
  }))
  await popup.screenshot({ path: path.join(OUT, 'after-reconnect.png') }).catch(() => {})
  out.steps.afterReconnect.consoleErrors = rec.console
    .filter((m) => m.type === 'error')
    .slice(0, 15)
}
fs.writeFileSync(path.join(OUT, 'probe-reconnect-result.json'), JSON.stringify(out, null, 2))
console.log(JSON.stringify(out.steps, null, 2).slice(0, 3000))
await browser.close()
