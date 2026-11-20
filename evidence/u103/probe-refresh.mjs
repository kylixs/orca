#!/usr/bin/env node
/**
 * U103 read-only probe: login at the platform, open the demo project's Orca Web
 * workspace in a popup, then reload the popup and record what it lands on.
 */
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const BASE = process.env.ORCA_QA_BASE ?? 'https://127.0.0.1:18787'
const USER = process.env.ORCA_QA_USER ?? 'admin'
const PASS = process.env.ORCA_QA_PASS ?? 'Adm1n!'
const OUT = path.resolve('evidence/u103')
fs.mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1440, height: 900 }
})
const out = { base: BASE, startedAt: new Date().toISOString(), steps: {} }

function instrument(page, tag) {
  const rec = { console: [], pageErrors: [], failed: [], responses: [] }
  page.on('console', (m) => {
    if (rec.console.length < 300) rec.console.push({ type: m.type(), text: m.text().slice(0, 500) })
  })
  page.on('pageerror', (e) => rec.pageErrors.push(String(e).slice(0, 800)))
  page.on('requestfailed', (r) => rec.failed.push({ url: r.url(), reason: r.failure()?.errorText }))
  page.on('response', (r) => {
    const u = r.url()
    if (/\/assets\/|web-index|\.js(\?|$)|\.css(\?|$)|release|handoff|\/v1\//.test(u)) {
      if (rec.responses.length < 400)
        rec.responses.push({ status: r.status(), url: u.slice(0, 300) })
    }
  })
  out.steps[tag] = rec
  return rec
}

async function dump(page) {
  return page
    .evaluate(() => {
      const visible = (sel) => {
        const el = document.querySelector(sel)
        if (!el) return 'missing'
        const cs = getComputedStyle(el)
        return el.hidden || cs.display === 'none' || cs.visibility === 'hidden'
          ? 'hidden'
          : 'visible'
      }
      const dumpStore = (s) => {
        const o = {}
        for (let i = 0; i < s.length; i += 1) {
          const k = s.key(i)
          o[k] = String(s.getItem(k)).slice(0, 500)
        }
        return o
      }
      const bodyText = (document.body?.innerText ?? '').slice(0, 600)
      return {
        url: location.href,
        title: document.title,
        rootChildren: document.getElementById('root')?.childElementCount ?? -1,
        loginLike:
          visible('#loginForm') !== 'hidden' || /登录|Sign in|Log in/i.test(bodyText.slice(0, 200)),
        markers: {
          loginForm: visible('#loginForm'),
          loginView: visible('#view-login'),
          viewApp: visible('#view-app'),
          appLayout: visible('.app-layout'),
          appShell: visible('.shell')
        },
        bodyText,
        localStorage: dumpStore(localStorage),
        sessionStorage: dumpStore(sessionStorage),
        cookie: document.cookie
      }
    })
    .catch((e) => ({ evaluateError: String(e) }))
}

const page = await context.newPage()
page.setDefaultTimeout(45_000)
instrument(page, 'platform')
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
await page.locator('#loginForm').waitFor({ state: 'visible' })
await page.fill('#username', USER)
await page.fill('#password', PASS)
await page.click('#loginBtn')
await page.locator('#view-app').waitFor({ state: 'visible' })
out.steps.platformAfterLogin = await dump(page)

await page.locator('tr', { hasText: 'demo' }).first().locator('[data-orca-web]').click()
const popup = await page.waitForEvent('popup', { timeout: 45_000 })
popup.setDefaultTimeout(90_000)
popup.on('dialog', (d) => d.accept())
instrument(popup, 'popupBeforeReload')
await popup.waitForSelector('.app-layout', { timeout: 90_000 }).catch(() => {})
await sleep(2500)
out.steps.popupBeforeReload.state = await dump(popup)
out.steps.popupBeforeReload.urlBefore = popup.url()
await popup.screenshot({ path: path.join(OUT, 'before-refresh.png') }).catch(() => {})

// The user action: refresh the Orca Web page.
instrument(popup, 'popupAfterReload')
const reloadAt = Date.now()
await popup.reload({ waitUntil: 'domcontentloaded' }).catch((e) => {
  out.steps.popupAfterReload.reloadError = String(e)
})
await sleep(8000)
out.steps.popupAfterReload.urlAfter = popup.url()
out.steps.popupAfterReload.reloadMs = Date.now() - reloadAt
out.steps.popupAfterReload.stateAfter8s = await dump(popup)
await popup.screenshot({ path: path.join(OUT, 'after-refresh.png') }).catch(() => {})
await sleep(7000)
out.steps.popupAfterReload.stateAfter15s = await dump(popup)
await popup.screenshot({ path: path.join(OUT, 'after-refresh-15s.png') }).catch(() => {})

out.finishedAt = new Date().toISOString()
fs.writeFileSync(path.join(OUT, 'probe-result.json'), JSON.stringify(out, null, 2))
console.log('platform url', out.steps.platformAfterLogin.url)
console.log('popup before', out.steps.popupBeforeReload.urlBefore)
console.log('before markers', JSON.stringify(out.steps.popupBeforeReload.state?.markers))
console.log('after url', out.steps.popupAfterReload.urlAfter)
console.log('after markers (8s)', JSON.stringify(out.steps.popupAfterReload.stateAfter8s?.markers))
console.log(
  'after markers (15s)',
  JSON.stringify(out.steps.popupAfterReload.stateAfter15s?.markers)
)
console.log('after body', (out.steps.popupAfterReload.stateAfter15s?.bodyText ?? '').slice(0, 200))
console.log('pageErrors', JSON.stringify(out.steps.popupAfterReload.pageErrors?.slice(0, 5)))
console.log('failed', JSON.stringify(out.steps.popupAfterReload.failed?.slice(0, 10)))
console.log(
  'console errors',
  JSON.stringify(
    (out.steps.popupAfterReload.console ?? []).filter((m) => m.type === 'error').slice(0, 10)
  )
)
await browser.close()
