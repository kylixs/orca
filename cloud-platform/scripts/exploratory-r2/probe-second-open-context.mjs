#!/usr/bin/env node
import { chromium } from 'playwright'
const BASE = 'https://127.0.0.1:18787'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const browser = await chromium.launch({ headless: true })

async function login(page) {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  if (await page.locator('#username').count()) {
    await page.fill('#username', 'admin')
    await page.fill('#password', 'Adm1n!')
    await page.click('button:has-text("登录")')
  }
  await page.waitForSelector('text=demo-app')
}
const fr = (page) => page.frames().find((f) => f.url().includes('/cloud-admin.html'))
async function open(page, key) {
  await page.locator('tr', { hasText: key }).getByRole('button', { name: '打开', exact: true }).click()
  await page.locator('#workspaceOverlay iframe').waitFor()
  for (let i = 0; i < 40; i += 1) {
    await sleep(500)
    const st = await page.evaluate(() => {
      const o = document.querySelector('#workspaceOverlay')
      return { ready: o?.querySelector('[data-workspace-status]')?.hidden === true, failure: !!o?.querySelector('[data-workspace-ready-failure]') }
    })
    if (st.ready || st.failure) return { ...st, body: fr(page) ? await fr(page).evaluate(() => document.body.innerText.slice(0, 180)).catch(() => '') : null }
  }
  return { timeout: true }
}

// Scenario D: close demo, reload the console, then open infra in the same browser profile
{
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  const page = await context.newPage()
  page.on('dialog', (d) => d.accept())
  await login(page)
  console.log('D first demo', await open(page, 'demo-app'))
  await page.locator('#workspaceOverlay [data-workspace-close]').click()
  await sleep(1000)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('text=infra-tools')
  console.log('D after reload infra', await open(page, 'infra-tools'))
  console.log('D storage', await page.evaluate(() => Object.keys(localStorage)))
  await context.close()
}

// Scenario E: same project twice
{
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  const page = await context.newPage()
  page.on('dialog', (d) => d.accept())
  await login(page)
  console.log('E demo #1', await open(page, 'demo-app'))
  await page.locator('#workspaceOverlay [data-workspace-close]').click()
  await sleep(1000)
  console.log('E demo #2', await open(page, 'demo-app'))
  await context.close()
}

// Scenario F: clear the embedded origin storage impossible from parent; use a new context for reference
await browser.close()
