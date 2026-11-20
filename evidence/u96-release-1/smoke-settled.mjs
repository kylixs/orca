#!/usr/bin/env node
// U96 release-1: settled web workspace state (tabs/groups/terminal after load).
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const BASE = 'https://127.0.0.1:18787'
const OUT = path.resolve('evidence/u96-release-1')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const result = { steps: {}, errors: [] }
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1440, height: 900 }
})
const page = await context.newPage()
page.setDefaultTimeout(60_000)
page.on('dialog', (d) => d.accept())

try {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await page.locator('#loginForm').waitFor({ state: 'visible' })
  await page.fill('#username', 'admin')
  await page.fill('#password', 'Adm1n!')
  await page.click('#loginBtn')
  await page.locator('#view-app').waitFor({ state: 'visible' })
  await page.locator('tr', { hasText: 'demo' }).first().locator('[data-orca-web]').click()
  const popup = await page.waitForEvent('popup', { timeout: 60_000 })
  popup.setDefaultTimeout(90_000)
  popup.on('dialog', (d) => d.accept())
  popup.on('pageerror', (e) => result.errors.push(String(e).slice(0, 300)))
  await popup.waitForSelector('.app-layout', { timeout: 90_000 })
  result.steps.loaded = { url: popup.url().replace(/#.*/, '') }
  for (const wait of [3000, 5000, 5000]) {
    await sleep(wait)
    result.steps[`t${wait}`] = await popup.evaluate(() => ({
      tabs: [...document.querySelectorAll('[data-testid="sortable-tab"]')].map((el) => ({
        title: el.getAttribute('data-tab-title'),
        active: el.getAttribute('aria-selected')
      })),
      groups: document.querySelectorAll('[data-tab-group-id]').length,
      groupIds: [...document.querySelectorAll('[data-tab-group-id]')].map((el) =>
        el.getAttribute('data-tab-group-id')
      ),
      xterm: document.querySelectorAll('.xterm').length,
      text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 400)
    }))
  }
  await popup.screenshot({ path: path.join(OUT, 'web-workspace-settled.png') })
  result.ok = true
} catch (error) {
  result.ok = false
  result.failure = String(error).slice(0, 800)
} finally {
  fs.writeFileSync(path.join(OUT, 'smoke-settled.json'), JSON.stringify(result, null, 2))
  await browser.close()
}
console.log(JSON.stringify(result, null, 2))
process.exit(result.ok ? 0 : 1)
