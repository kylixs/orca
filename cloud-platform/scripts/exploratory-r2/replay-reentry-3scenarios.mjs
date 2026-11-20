#!/usr/bin/env node
/** Replay U59① P0: first open -> close -> second open in one profile, three scenarios. */
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const BASE = process.env.ORCA_QA_BASE || 'https://127.0.0.1:18787'
const OUT = path.resolve('cloud-platform/evidence/r-fixes-verify')
const SHOTS = path.join(OUT, 'screenshots')
fs.mkdirSync(SHOTS, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const browser = await chromium.launch({ headless: true })
const results = []

async function login(page) {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  if (await page.locator('#username').count()) {
    await page.fill('#username', 'admin')
    await page.fill('#password', 'Adm1n!')
    await page.click('button:has-text("登录")')
  }
  await page.waitForSelector('text=demo-app', { timeout: 25000 })
}

const frameOf = (page) => page.frames().find((f) => f.url().includes('/cloud-admin.html'))

async function openProject(page, key) {
  const started = Date.now()
  await page
    .locator('tr', { hasText: key })
    .getByRole('button', { name: '打开', exact: true })
    .click()
  await page.locator('#workspaceOverlay iframe').waitFor({ timeout: 15000 })
  let last = null
  while (Date.now() - started < 30000) {
    last = await page.evaluate(() => {
      const o = document.querySelector('#workspaceOverlay')
      return {
        overlay: !!o,
        ready: o?.querySelector('[data-workspace-status]')?.hidden === true,
        failure: o?.querySelector('[data-workspace-ready-failure]')?.innerText?.slice(0, 160) ?? '',
        statusText: o?.querySelector('[data-workspace-status]')?.innerText?.slice(0, 120) ?? '',
        route: o?.querySelector('[data-workspace-route]')?.textContent ?? ''
      }
    })
    if (last.ready || last.failure) break
    await sleep(500)
  }
  const frame = frameOf(page)
  const frameBody = frame
    ? await frame.evaluate(() => document.body.innerText.slice(0, 240)).catch(() => '')
    : null
  return {
    ...last,
    ms: Date.now() - started,
    frameUrl: frame?.url()?.slice(0, 140) ?? null,
    frameBody
  }
}

async function closeOverlay(page) {
  await page.locator('#workspaceOverlay [data-workspace-close]').click()
  for (let i = 0; i < 40; i += 1) {
    if ((await page.locator('#workspaceOverlay').count()) === 0) return true
    await sleep(250)
  }
  return false
}

async function scenario(name, firstKey, secondKey) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1600, height: 1000 }
  })
  const page = await context.newPage()
  page.setDefaultTimeout(25000)
  const events = { consoleErrors: [], httpFailures: [] }
  page.on('console', (m) => {
    if (m.type() === 'error') events.consoleErrors.push(m.text().slice(0, 200))
  })
  page.on('pageerror', (e) => events.consoleErrors.push(`pageerror: ${e.message}`))
  page.on('response', (r) => {
    if (r.status() >= 400) events.httpFailures.push(`${r.status()} ${r.url().slice(0, 160)}`)
  })
  page.on('dialog', (d) => d.accept())
  const record = { name, firstKey, secondKey, first: null, closed: null, second: null, events }
  try {
    await login(page)
    record.first = await openProject(page, firstKey)
    await page.screenshot({ path: path.join(SHOTS, `reentry-${name}-1-first.png`) })
    record.closed = await closeOverlay(page)
    await sleep(1200)
    record.second = await openProject(page, secondKey)
    await page.screenshot({ path: path.join(SHOTS, `reentry-${name}-2-second.png`) })
    record.pass =
      record.first.ready === true && record.closed === true && record.second.ready === true
  } catch (error) {
    record.error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error)
    record.pass = false
  } finally {
    await context.close()
  }
  results.push(record)
  console.log(
    `${record.pass ? 'PASS' : 'FAIL'} ${name}: first=${record.first?.ready} closed=${record.closed} second=${record.second?.ready} secondFailure=${record.second?.failure ?? ''}`
  )
}

await scenario('same-project', 'demo-app', 'demo-app')
await scenario('different-project', 'demo-app', 'zhangsan-demo')
await scenario('cross-host', 'demo-app', 'infra-tools')
fs.writeFileSync(
  path.join(OUT, 'p0-reentry-3scenarios.json'),
  JSON.stringify(
    {
      check: 'U59① P0 embed second-open',
      base: BASE,
      generatedAt: new Date().toISOString(),
      results
    },
    null,
    2
  )
)
await browser.close()
console.log(
  `written ${results.length} scenarios; failures=${results.filter((r) => !r.pass).length}`
)
