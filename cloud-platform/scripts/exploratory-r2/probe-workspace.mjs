#!/usr/bin/env node
/**
 * U46 embedded simple workspace — exploratory probe.
 * Isolated headless Chromium (own profile), ignoreHTTPSErrors for the local
 * relay-edge cert. No code changes; read-only interactions.
 *
 * Usage: node cloud-platform/scripts/exploratory-r2/probe-workspace.mjs
 */
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const BASE = process.env.ORCA_QA_BASE || 'https://127.0.0.1:18787'
const OUT = path.resolve('cloud-platform/evidence/exploratory-r2')
const SHOTS = path.join(OUT, 'screenshots')
fs.mkdirSync(SHOTS, { recursive: true })

const log = (...a) => console.log('[probe]', ...a)
const shot = async (page, name) => {
  const file = path.join(SHOTS, `${name}.png`)
  await page.screenshot({ path: file })
  return file
}
const outline = async (frame) =>
  frame.evaluate(() => {
    const out = []
    for (const el of document.querySelectorAll('*')) {
      if (el.children.length > 0) continue
      const text = (el.textContent || '').trim()
      if (!text || text.length > 80) continue
      const style = getComputedStyle(el)
      if (style.display === 'none' || style.visibility === 'hidden') continue
      out.push({
        tag: el.tagName.toLowerCase(),
        text,
        role: el.getAttribute('role') || '',
        testid: el.getAttribute('data-testid') || '',
        cls: (el.className || '').toString().slice(0, 60)
      })
    }
    return out
  })

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1600, height: 1000 }
})
const page = await context.newPage()
const consoleErrors = []
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))

await page.goto(BASE + '/', { waitUntil: 'networkidle' })
if (await page.locator('#username').count()) {
  await page.fill('#username', 'admin')
  await page.fill('#password', 'Adm1n!')
  await page.click('button:has-text("登录")')
  await page.waitForSelector('text=demo-app', { timeout: 15000 })
}
log('logged in')
await shot(page, 'probe-01-workbench')

const row = page.locator('tr', { hasText: 'demo-app' })
await row.getByRole('button', { name: '打开', exact: true }).click()
const overlay = page.locator('#workspaceOverlay')
await overlay.waitFor({ timeout: 10000 })
const frameEl = overlay.locator('iframe')
await frameEl.waitFor({ timeout: 10000 })
const frame = await (await frameEl.elementHandle()).contentFrame()
log('iframe loaded', frame?.url() ?? '')
// wait for ready: status hidden or failure
await page.waitForTimeout(8000)
const state = await page.evaluate(() => {
  const o = document.querySelector('#workspaceOverlay')
  return {
    overlay: !!o,
    statusHidden: o?.querySelector('[data-workspace-status]')?.hidden ?? null,
    route: o?.querySelector('[data-workspace-route]')?.textContent ?? '',
    dirty: o?.querySelector('[data-workspace-dirty]')?.textContent ?? '',
    failure: o?.querySelector('[data-workspace-ready-failure]')?.innerText ?? '',
    iframeSrc: o?.querySelector('iframe')?.src ?? ''
  }
})
log('overlay state', JSON.stringify(state))
await shot(page, 'probe-02-overlay')

const fr = page.frames().find((f) => f.url().includes('cloud-admin'))
if (fr) {
  const outlineData = await outline(fr)
  fs.writeFileSync(path.join(OUT, 'probe-frame-outline.json'), JSON.stringify(outlineData, null, 2))
  log('frame outline entries', outlineData.length)
  log(
    outlineData
      .slice(0, 80)
      .map((x) => `${x.tag}${x.testid ? '[' + x.testid + ']' : ''}: ${x.text}`)
      .join('\n')
  )
  log('frame html head', (await fr.content()).slice(0, 500))
} else {
  log('no cloud-admin frame')
}
fs.writeFileSync(
  path.join(OUT, 'probe-console-errors.json'),
  JSON.stringify(consoleErrors, null, 2)
)
log('console errors', consoleErrors.length)
await browser.close()
