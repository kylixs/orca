#!/usr/bin/env node
/** Production handoff entry (platform-minted URL) -> reload restore check. */
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const OUT = path.resolve(import.meta.dirname)
const SHOTS = path.join(OUT, 'screenshots')
const handoff = JSON.parse(fs.readFileSync('/tmp/prod-smoke/handoff.json', 'utf8')).url
const sleep = (ms) => page.waitForTimeout(ms)
const out = { entry: handoff.replace(/#handoff=[^&]+/, '#handoff=<redacted>'), steps: [] }
let context, page

const state = () =>
  page.evaluate(() => {
    const text = (el) => (el?.innerText ?? '').replace(/\s+/g, ' ').trim()
    const vis = (el) => !!el && (el.offsetParent !== null || el.getClientRects().length > 0)
    return {
      url: location.href,
      hasApp: !!document.querySelector('.app-layout'),
      hasSignInForm: !!document.querySelector('#web-cloud-api-url'),
      body: text(document.body).slice(0, 900),
      tabs: [...document.querySelectorAll('[data-tab-id]')].filter(vis).map((el) => text(el)).slice(0, 20),
      groupStrips: [...document.querySelectorAll('[data-tab-group-strip-id]')].filter(vis).length,
      xterms: [...document.querySelectorAll('.xterm')].filter(vis).length,
      cloudSessionStored: !!localStorage.getItem('orca.webCloudSession'),
      runtimeEnvStored: !!localStorage.getItem('orca.web.runtimeEnvironment.v1')
    }
  })

async function waitFor(fn, timeout, interval = 800) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try {
      const v = await fn()
      if (v) return v
    } catch {}
    await sleep(interval)
  }
  return null
}

try {
  context = await chromium.launchPersistentContext('/tmp/prod-smoke/profile-handoff', {
    headless: true,
    ignoreHTTPSErrors: true,
    viewport: { width: 1600, height: 1000 },
    locale: 'zh-CN',
    args: ['--no-sandbox']
  })
  page = context.pages()[0] ?? (await context.newPage())
  page.on('pageerror', (e) => out.steps.push({ pageerror: e.message }))
  await page.goto(handoff, { waitUntil: 'domcontentloaded', timeout: 60000 })
  const entered = await waitFor(async () => {
    const s = await state()
    return s.hasApp && s.tabs.length > 0 ? s : null
  }, 90000)
  await sleep(6000)
  for (const label of [/^\s*Got it/i, /^\s*知道了/, /^\s*关闭/, /^Close$/]) {
    const btn = page.locator('[data-slot="dialog-content"] button', { hasText: label }).first()
    if (await btn.isVisible().catch(() => false)) await btn.click().catch(() => {})
  }
  const before = await state()
  await page.screenshot({ path: path.join(SHOTS, '08-handoff-before-reload.png') })
  out.steps.push({ step: 'handoff-enter', ok: !!entered && before.tabs.length > 0, before })

  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })
  const restored = await waitFor(async () => {
    const s = await state()
    return s.hasApp && s.tabs.length > 0 ? s : null
  }, 90000)
  await sleep(6000)
  const after = await state()
  await page.screenshot({ path: path.join(SHOTS, '09-handoff-after-reload.png') })
  const ok =
    !!restored &&
    !after.hasSignInForm &&
    after.tabs.length >= Math.min(1, before.tabs.length) &&
    after.groupStrips >= 1
  out.steps.push({ step: 'handoff-reload-restore', ok, after })
} catch (e) {
  out.error = `${e.message}\n${e.stack}`
} finally {
  fs.writeFileSync(path.join(OUT, 'handoff-refresh.json'), JSON.stringify(out, null, 2))
  console.log(JSON.stringify(out, null, 2))
  await context?.close().catch(() => {})
}
