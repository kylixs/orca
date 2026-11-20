#!/usr/bin/env node
import { chromium } from 'playwright'
import path from 'node:path'
import fs from 'node:fs'

const BASE = 'https://127.0.0.1:18787'
const SHOTS = path.resolve('cloud-platform/evidence/exploratory-r2/screenshots')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const browser = await chromium.launch({ headless: true })

async function scenario(name, { terminal, waitAfterClose }) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1600, height: 1000 }
  })
  const page = await context.newPage()
  page.setDefaultTimeout(20000)
  page.on('dialog', (d) => d.accept())
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
  await page.locator('#workspaceOverlay iframe').waitFor()
  await sleep(6000)
  if (terminal) {
    await fr().locator('[data-testid="cloud-simple-workspace-new-terminal"]').click()
    for (let i = 0; i < 60; i += 1) {
      const st = await fr().evaluate(
        () => document.querySelector('[data-testid="cloud-terminal-state"]')?.textContent ?? ''
      )
      if (st.includes('实时')) break
      await sleep(500)
    }
    await fr().locator('.xterm-screen').first().click()
    await page.keyboard.type('echo warm', { delay: 5 })
    await page.keyboard.press('Enter')
    await sleep(1000)
  }
  await page.locator('#workspaceOverlay [data-workspace-close]').click()
  await sleep(waitAfterClose)
  const removed = (await page.locator('#workspaceOverlay').count()) === 0
  await page
    .locator('tr', { hasText: 'infra-tools' })
    .getByRole('button', { name: '打开', exact: true })
    .click()
  await page.locator('#workspaceOverlay iframe').waitFor()
  let last = null
  for (let i = 0; i < 24; i += 1) {
    await sleep(1000)
    const st = await page.evaluate(() => {
      const o = document.querySelector('#workspaceOverlay')
      return {
        iframe: !!o?.querySelector('iframe'),
        status: o?.querySelector('[data-workspace-status]')?.hidden ?? null,
        route: o?.querySelector('[data-workspace-route]')?.textContent ?? '',
        failure: o?.querySelector('[data-workspace-ready-failure]')?.innerText?.slice(0, 80) ?? ''
      }
    })
    const frame = fr()
    const body = frame
      ? await frame.evaluate(() => document.body.innerText.slice(0, 200)).catch(() => 'ERR')
      : null
    last = { t: i + 1, ...st, frame: frame ? frame.url().slice(0, 90) : null, body }
    if (st.failure) break
    if (st.status === true) break
    if (i === 7 || i === 14) {
      await page.screenshot({ path: path.join(SHOTS, `probe-race-${name}-${i + 1}s.png`) })
      console.log(name, JSON.stringify(last))
    }
  }
  console.log('RESULT', name, JSON.stringify(last))
  await context.close()
}

await scenario('A-terminal-close1s', { terminal: true, waitAfterClose: 1000 })
await scenario('B-terminal-close6s', { terminal: true, waitAfterClose: 6000 })
await scenario('C-noTerminal-close1s', { terminal: false, waitAfterClose: 1000 })
await browser.close()
