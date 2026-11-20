// U83 real-system verification: simple-workspace terminal must reach the pane bottom.
// Drives the live platform (18787) in headless Chromium; measures geometry, resizes, screenshots.
import { chromium } from 'playwright'
import path from 'node:path'

const BASE = 'https://127.0.0.1:18787'
const OUT = path.dirname(new URL(import.meta.url).pathname)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1600, height: 1000 }
})
const page = await context.newPage()
page.setDefaultTimeout(20000)
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
if (await page.locator('#username').count()) {
  await page.fill('#username', 'admin')
  await page.fill('#password', 'Adm1n!')
  await page.click('button:has-text("登录")')
}
await page.waitForSelector('text=demo-app')
const fr = () => page.frames().find((f) => f.url().includes('/cloud-admin.html'))

await page
  .locator('tr', { hasText: 'demo-app' })
  .getByRole('button', { name: '打开', exact: true })
  .click()
await page.locator('#workspaceOverlay iframe').waitFor({ timeout: 10000 })
for (let i = 0; i < 120; i += 1) {
  const ok = await page.evaluate(() => {
    const o = document.querySelector('#workspaceOverlay')
    return (
      !!o?.querySelector('[data-workspace-ready-failure]') ||
      o?.querySelector('[data-workspace-status]')?.hidden === true
    )
  })
  if (ok) break
  await sleep(500)
}
await fr().evaluate(() =>
  document.querySelector('[data-testid="cloud-simple-workspace-new-terminal"]').click()
)
for (let i = 0; i < 60; i += 1) {
  const state = await fr().evaluate(
    () => document.querySelector('[data-testid="cloud-terminal-state"]')?.textContent ?? ''
  )
  if (state.includes('实时')) break
  await sleep(500)
}

const measure = () =>
  fr().evaluate(() => {
    const rect = (sel) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { top: +r.top.toFixed(2), bottom: +r.bottom.toFixed(2), height: +r.height.toFixed(2) }
    }
    const pane = [
      ...document.querySelectorAll('[data-testid^="cloud-simple-workspace-pane-"]')
    ].find((el) => el.getBoundingClientRect().height > 0)
    const paneRect = pane?.getBoundingClientRect()
    const panel = rect('[data-testid="cloud-terminal-panel"]')
    const host = rect('[data-testid="cloud-terminal-host"]')
    const xterm = rect('.xterm-screen')
    const rows = document.querySelector('.xterm-rows')?.children.length ?? null
    return {
      viewport: { w: innerWidth, h: innerHeight },
      paneBottom: paneRect ? +paneRect.bottom.toFixed(2) : null,
      panel,
      host,
      xterm,
      rows,
      gapPaneToPanel: paneRect && panel ? +(paneRect.bottom - panel.bottom).toFixed(2) : null,
      gapHostToXterm: host && xterm ? +(host.bottom - xterm.bottom).toFixed(2) : null
    }
  })

const before = await measure()
console.log('BEFORE RESIZE', JSON.stringify(before))
await fr()
  .locator('[data-testid="cloud-simple-workspace"]')
  .screenshot({ path: path.join(OUT, 'u83-filled-1600x1000.png') })

await page.setViewportSize({ width: 1280, height: 860 })
await sleep(1500)
const after = await measure()
console.log('AFTER RESIZE', JSON.stringify(after))
await fr()
  .locator('[data-testid="cloud-simple-workspace"]')
  .screenshot({ path: path.join(OUT, 'u83-filled-1280x860.png') })

const state = await fr().evaluate(
  () => document.querySelector('[data-testid="cloud-terminal-state"]')?.textContent ?? ''
)
console.log('terminal state', state)
await browser.close()
