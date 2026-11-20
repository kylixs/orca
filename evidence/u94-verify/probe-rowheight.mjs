// Supplemental: measure the real xterm cell height (canvas renderer has no .xterm-rows div)
// and re-confirm the bottom gap at two viewport sizes.
import { chromium } from 'playwright'
import path from 'node:path'
import fs from 'node:fs'

const BASE = 'https://127.0.0.1:18787'
const OUT = path.dirname(new URL(import.meta.url).pathname)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const browser = await chromium.launch({ headless: true })
const page = await (
  await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } })
).newPage()
page.setDefaultTimeout(25000)
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
await page.fill('#username', 'admin')
await page.fill('#password', 'Adm1n!')
await page.click('#loginBtn')
await page.waitForSelector('text=demo-app', { timeout: 30000 })
await page
  .locator('tr', { hasText: 'demo-app' })
  .getByRole('button', { name: '打开', exact: true })
  .click()
await page.locator('#workspaceOverlay iframe').waitFor({ timeout: 15000 })
for (let i = 0; i < 160; i += 1) {
  const ready = await page.evaluate(
    () => document.querySelector('#workspaceOverlay [data-workspace-status]')?.hidden === true
  )
  if (ready) break
  await sleep(500)
}
const fr = () => page.frames().find((f) => f.url().includes('/cloud-admin.html'))
await fr().evaluate(() =>
  document.querySelector('[data-testid="cloud-simple-workspace-new-terminal"]').click()
)
for (let i = 0; i < 60; i += 1) {
  const s = await fr().evaluate(
    () => document.querySelector('[data-testid="cloud-terminal-state"]')?.textContent ?? ''
  )
  if (s.includes('实时')) break
  await sleep(500)
}
await sleep(600)
const probe = await fr().evaluate(() => {
  const screen = document.querySelector('.xterm-screen')
  const term = document.querySelector('.xterm')
  const cs = getComputedStyle(term)
  const kids = screen
    ? [...screen.children].map((c) => ({
        cls: c.className,
        w: c.getBoundingClientRect().width,
        h: c.getBoundingClientRect().height
      }))
    : []
  // canvas renderer: one .xterm-text-layer canvas; the CSS sets --xterm-cell-height when available
  const vars = {}
  for (const name of ['--xterm-cell-height', '--xterm-cell-width'])
    vars[name] = cs.getPropertyValue(name)
  return {
    screenInlineHeight: screen?.style.height ?? null,
    screenHeight: screen?.getBoundingClientRect().height ?? null,
    termFontSize: cs.fontSize,
    termLineHeight: cs.lineHeight,
    hasRowsDiv: !!document.querySelector('.xterm-rows'),
    kids,
    vars
  }
})
const measure = () =>
  fr().evaluate(() => {
    const r = (sel) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const b = el.getBoundingClientRect()
      return { top: +b.top.toFixed(2), bottom: +b.bottom.toFixed(2), height: +b.height.toFixed(2) }
    }
    const pane = [
      ...document.querySelectorAll('[data-testid^="cloud-simple-workspace-pane-"]')
    ].find((el) => el.getBoundingClientRect().height > 0)
    return {
      paneBottom: +pane.getBoundingClientRect().bottom.toFixed(2),
      panel: r('[data-testid="cloud-terminal-panel"]'),
      host: r('[data-testid="cloud-terminal-host"]'),
      screen: r('.xterm-screen')
    }
  })
const rowsFromScreen = probe.screenHeight && probe.termFontSize ? null : null
const m1 = await measure()
await page.setViewportSize({ width: 1280, height: 860 })
await sleep(1800)
const m2 = await measure()
const out = {
  probe,
  rowsInferred: {
    note: 'cellHeight = screenHeight / rows; rows from xterm fit = floor((host - padding)/cellHeight). Use CSS var or xterm canvas layer height.',
    screenHeight1600: probe.screenHeight
  },
  at1600: {
    ...m1,
    gapPaneToPanel: +(m1.paneBottom - m1.panel.bottom).toFixed(2),
    gapHostToScreen: +(m1.host.bottom - m1.screen.bottom).toFixed(2)
  },
  at1280: {
    ...m2,
    gapPaneToPanel: +(m2.paneBottom - m2.panel.bottom).toFixed(2),
    gapHostToScreen: +(m2.host.bottom - m2.screen.bottom).toFixed(2)
  }
}
fs.writeFileSync(path.join(OUT, 'u94-u83-rowheight.json'), JSON.stringify(out, null, 2))
console.log(JSON.stringify(out, null, 2))
await browser.close()
