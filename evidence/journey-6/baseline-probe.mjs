#!/usr/bin/env node
// Probe existing web-workspace tab baselines per project so the release smoke can
// pick the cleanest one instead of inheriting a historical session.
import { chromium } from 'playwright'
import fs from 'node:fs'

const BASE = 'https://127.0.0.1:18787'
const OUT = 'evidence/journey-6/baseline-probe.json'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const projects = ['demo-app', 'zhangsan-demo', 'infra-tools', 'zhangsan-lab']

const state = (page) =>
  page.evaluate(() => ({
    appLayout: document.querySelector('.app-layout') !== null,
    tabs: [...document.querySelectorAll('[data-testid="sortable-tab"]')].map((el) => ({
      id: el.getAttribute('data-tab-id'),
      title: el.getAttribute('data-tab-title')
    })),
    xterm: document.querySelectorAll('.xterm').length
  }))

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1440, height: 900 }
})
const page = await context.newPage()
page.on('dialog', (d) => d.accept())
const result = { base: BASE, user: 'zhangsan', probes: {}, errors: [] }
try {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await page.locator('#loginForm').waitFor({ state: 'visible', timeout: 30_000 })
  await page.fill('#username', 'zhangsan')
  await page.fill('#password', 'Passw0rd!')
  await page.click('#loginBtn')
  await page.locator('#view-app').waitFor({ state: 'visible', timeout: 30_000 })
  const ids = await page.evaluate(async () => {
    const token = localStorage.getItem('orca.access')
    const r = await fetch('/v1/projects', { headers: { authorization: `Bearer ${token}` } })
    return Object.fromEntries(((await r.json()).projects ?? []).map((p) => [p.name, p.id]))
  })
  result.projectIds = ids
  for (const name of projects) {
    const id = ids[name]
    if (!id) {
      result.probes[name] = { skipped: 'no id' }
      continue
    }
    try {
      const button = page.locator(`[data-orca-web="${id}"]`).first()
      await button.waitFor({ state: 'visible', timeout: 30_000 })
      const popupPromise = context.waitForEvent('page', { timeout: 90_000 })
      popupPromise.catch(() => {})
      await button.click()
      const popup = await popupPromise
      popup.setDefaultTimeout(90_000)
      popup.on('dialog', (d) => d.accept())
      popup.on('requestfailed', (r) =>
        result.errors.push({
          project: name,
          url: r.url().slice(0, 240),
          error: r.failure()?.errorText ?? null
        })
      )
      await popup.waitForSelector('.app-layout', { timeout: 120_000 })
      let s = null
      for (const deadline = Date.now() + 60_000; Date.now() < deadline;) {
        s = await state(popup)
        if (s.tabs.length >= 1 && s.xterm >= 1) break
        await sleep(300)
      }
      result.probes[name] = {
        tabs: s?.tabs,
        xterm: s?.xterm,
        tabCount: s?.tabs.length,
        appLayout: s?.appLayout
      }
      await popup.close()
    } catch (e) {
      result.probes[name] = { error: String(e).slice(0, 400) }
    }
    await sleep(500)
  }
} catch (e) {
  result.failure = String(e).slice(0, 800)
} finally {
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2))
  await browser.close()
}
console.log(JSON.stringify(result, null, 2))
