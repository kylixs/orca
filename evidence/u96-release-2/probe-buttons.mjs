#!/usr/bin/env node
// Enumerate tab-bar create affordances and what each click opens.
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const BASE = 'https://127.0.0.1:18787'
const OUT = path.resolve('evidence/u96-release-2')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = { buttons: [], clicks: [] }
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1440, height: 900 }
})
const page = await context.newPage()
page.setDefaultTimeout(60_000)
page.on('dialog', (d) => d.accept())
let popup
async function dismiss(p, windowMs = 12_000) {
  const deadline = Date.now() + windowMs
  let closed = 0
  let quiet = 0
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
  await page.fill('#username', 'admin')
  await page.fill('#password', 'Adm1n!')
  await page.click('#loginBtn')
  await page.locator('#view-app').waitFor({ state: 'visible' })
  const pp = context.waitForEvent('page', { timeout: 60_000 })
  await page.locator('tr', { hasText: 'demo' }).first().locator('[data-orca-web]').click()
  popup = await pp
  popup.setDefaultTimeout(90_000)
  popup.on('dialog', (d) => d.accept())
  await popup.waitForSelector('.app-layout', { timeout: 90_000 })
  out.tipsClosed = await dismiss(popup)
  await sleep(1500)
  out.buttons = await popup.evaluate(() =>
    [...document.querySelectorAll('button')]
      .map((el, i) => {
        const r = el.getBoundingClientRect()
        const label = el.getAttribute('aria-label') || ''
        const title = el.getAttribute('title') || ''
        const text = (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40)
        return {
          i,
          label,
          title,
          text,
          rect: {
            x: Math.round(r.x),
            y: Math.round(r.y),
            w: Math.round(r.width),
            h: Math.round(r.height)
          },
          visible: r.width > 0 && r.height > 0,
          cls: (el.className || '').toString().slice(0, 120)
        }
      })
      .filter((b) => b.visible && (b.label || b.title || b.text))
  )
  const candidates = out.buttons.filter((b) =>
    /new|tab|plus/i.test(`${b.label} ${b.title} ${b.text}`)
  )
  out.candidates = candidates
  for (const c of candidates.slice(0, 6)) {
    const before = await popup.locator('[role="menuitem"]').count()
    await popup
      .locator('button')
      .nth(c.i)
      .click({ timeout: 8000 })
      .catch((e) => (c.clickError = String(e).slice(0, 200)))
    await sleep(1000)
    const items = await popup.locator('[role="menuitem"]').allTextContents()
    const menus = await popup
      .locator('[role="menu"],[role="listbox"],[data-slot="dropdown-menu-content"]')
      .count()
    out.clicks.push({ target: c, before, items, menus })
    await popup.screenshot({ path: path.join(OUT, `probe-btn-${c.i}.png`) }).catch(() => {})
    await popup.keyboard.press('Escape')
    await sleep(500)
    // dismiss any dialog that the click may have opened
    await dismiss(popup, 3000)
  }
} catch (error) {
  out.failure = String(error).slice(0, 1200)
} finally {
  fs.writeFileSync(path.join(OUT, 'probe-buttons.json'), JSON.stringify(out, null, 2))
  await browser.close()
}
console.log(JSON.stringify(out, null, 2))
