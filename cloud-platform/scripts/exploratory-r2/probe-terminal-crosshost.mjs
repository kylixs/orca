#!/usr/bin/env node
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const BASE = 'https://127.0.0.1:18787'
const OUT = path.resolve('cloud-platform/evidence/exploratory-r2')
const SHOTS = path.join(OUT, 'screenshots')
const WT = '/Users/gongdewei/orca-local-env/host/projects/demo-app/.orca-worktrees/admin/main-2'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1600, height: 1000 }
})
const page = await context.newPage()
page.setDefaultTimeout(20000)
const errors = []
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})
page.on('pageerror', (e) => errors.push(e.message))
page.on('dialog', async (d) => {
  console.log('DIALOG', d.message())
  await d.accept()
})

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
if (await page.locator('#username').count()) {
  await page.fill('#username', 'admin')
  await page.fill('#password', 'Adm1n!')
  await page.click('button:has-text("登录")')
}
await page.waitForSelector('text=demo-app')
const fr = () => page.frames().find((f) => f.url().includes('/cloud-admin.html'))
const t = (id) => fr().locator(`[data-testid="${id}"]:visible`)

async function openProject(key) {
  await page
    .locator('tr', { hasText: key })
    .getByRole('button', { name: '打开', exact: true })
    .click()
  await page.locator('#workspaceOverlay iframe').waitFor({ timeout: 10000 })
  for (let i = 0; i < 120; i += 1) {
    const st = await page.evaluate(() => {
      const o = document.querySelector('#workspaceOverlay')
      return {
        failure: !!o?.querySelector('[data-workspace-ready-failure]'),
        ready: o?.querySelector('[data-workspace-status]')?.hidden === true,
        route: o?.querySelector('[data-workspace-route]')?.textContent ?? '',
        body: o?.querySelector('.workspace-body')?.innerText?.slice(0, 200) ?? ''
      }
    })
    if (st.ready || st.failure) return st
    await sleep(500)
  }
  return { timeout: true }
}

// --- demo terminal ---
console.log('open demo', await openProject('demo-app'))
const termId =
  (await fr().evaluate(() => {
    document.querySelector('[data-testid="cloud-simple-workspace-new-terminal"]').click()
    return true
  })) && (await sleep(1000))
await sleep(1500)
const termState = await fr().evaluate(() => ({
  tabs: [
    ...document.querySelectorAll('[role="tab"][data-testid^="cloud-simple-workspace-tab-"]')
  ].map((e) => e.getAttribute('data-testid')),
  panel: !!document.querySelector('[data-testid="cloud-terminal-panel"]'),
  state: document.querySelector('[data-testid="cloud-terminal-state"]')?.textContent ?? ''
}))
console.log('term', termState)
// wait live
for (let i = 0; i < 60; i += 1) {
  const state = await fr().evaluate(
    () => document.querySelector('[data-testid="cloud-terminal-state"]')?.textContent ?? ''
  )
  if (state.includes('实时')) break
  await sleep(500)
}
const state2 = await fr().evaluate(
  () => document.querySelector('[data-testid="cloud-terminal-state"]')?.textContent ?? ''
)
console.log('term state', state2)
const screen = fr().locator('.xterm-screen:visible').first()
await screen.click()
await page.keyboard.type('echo r2-echo-ok', { delay: 10 })
await page.keyboard.press('Enter')
await sleep(1500)
const screenText = await fr().evaluate(
  () =>
    document.querySelector('.xterm-screen')?.innerText ??
    document.querySelector('.xterm-rows')?.innerText ??
    ''
)
console.log('screen text', JSON.stringify(screenText.slice(-300)))
const marker = path.join(WT, 'docs/r2-terminal-marker')
try {
  fs.unlinkSync(marker)
} catch {}
await screen.click()
await page.keyboard.type(`touch ${JSON.stringify(marker)}`, { delay: 10 })
await page.keyboard.press('Enter')
await sleep(2000)
console.log('marker exists', fs.existsSync(marker))
await page.screenshot({ path: path.join(SHOTS, 'probe-terminal.png') })

// --- close demo, open infra-tools ---
await page.locator('#workspaceOverlay [data-workspace-close]').click()
await sleep(1200)
console.log('closed', (await page.locator('#workspaceOverlay').count()) === 0)
const cross = await openProject('infra-tools')
console.log('open infra', cross)
console.log(
  'frames',
  page
    .frames()
    .map((f) => f.url())
    .slice(0, 8)
)
await page.screenshot({ path: path.join(SHOTS, 'probe-crosshost.png') })
if (fr()) {
  console.log('infra status', await fr().evaluate(() => document.body.innerText.slice(0, 600)))
}
console.log('errors', errors.slice(-10))
await browser.close()
