#!/usr/bin/env node
/** Probe: dismiss first-run tip, then find a reliable terminal text oracle in the web build. */
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const OUT = path.resolve(import.meta.dirname)
const SHOTS = path.join(OUT, 'screenshots')
const ENTRY =
  'https://100.67.197.59:18444/h/dev-local-02/web-index.html?api=https%3A%2F%2F127.0.0.1%3A18787&project=proj_c1cc0f50'
const TS = '20261117-062441'
const out = {}
const sleep = (ms) => page.waitForTimeout(ms)
let context, page

try {
  context = await chromium.launchPersistentContext(`/tmp/prod-smoke/profile-${TS}`, {
    headless: true,
    ignoreHTTPSErrors: true,
    viewport: { width: 1600, height: 1000 },
    locale: 'zh-CN',
    permissions: ['clipboard-read', 'clipboard-write'],
    args: ['--no-sandbox']
  })
  page = context.pages()[0] ?? (await context.newPage())
  await page.goto(ENTRY, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.locator('#web-cloud-api-url').waitFor({ timeout: 30000 }).catch(() => {})
  if (await page.locator('#web-cloud-api-url').isVisible().catch(() => false)) {
    await page.locator('#web-cloud-api-url').fill('https://127.0.0.1:18787')
    await page.locator('#web-cloud-username').fill('zhangsan')
    await page.locator('#web-cloud-password').fill('Passw0rd!')
    await page.locator('button[type="submit"]').click()
  }
  await page.waitForSelector('.app-layout', { timeout: 90000 })
  out.shellReached = true
  await sleep(5000)

  out.dialogsBefore = await page.evaluate(() =>
    [...document.querySelectorAll('[data-slot="dialog-content"]')].map((d) => (d.innerText ?? '').slice(0, 200))
  )
  // dismiss first-run tip
  for (const label of [/^\s*Got it/i, /^\s*知道了/, /^\s*关闭/, /Close/]) {
    const btn = page.getByRole('button', { name: label }).first()
    if (await btn.isVisible().catch(() => false)) {
      await btn.click().catch(() => {})
      await sleep(800)
    }
  }
  const overlayGone = await page
    .locator('[data-slot="dialog-overlay"]')
    .first()
    .waitFor({ state: 'detached', timeout: 5000 })
    .then(() => true)
    .catch(() => false)
  out.overlayGoneByGotIt = overlayGone
  out.dialogsAfter = await page.evaluate(() =>
    [...document.querySelectorAll('[data-slot="dialog-content"]')].map((d) => (d.innerText ?? '').slice(0, 200))
  )

  out.xtermDom = await page.evaluate(() => {
    const w = [...document.querySelectorAll('.xterm')].find((el) => el.offsetParent !== null)
    return {
      outer: w ? w.outerHTML.slice(0, 600) : null,
      canvases: w ? w.querySelectorAll('canvas').length : 0,
      rows: w ? w.querySelectorAll('.xterm-rows > div').length : 0,
      rowsTextLen: w
        ? [...w.querySelectorAll('.xterm-rows > div')].reduce((n, r) => n + (r.textContent ?? '').length, 0)
        : 0,
      a11y: w?.querySelector('.xterm-accessibility')?.textContent?.slice(0, 300) ?? null,
      screenText: w?.querySelector('.xterm-screen')?.textContent?.slice(0, 300) ?? null
    }
  })

  // focus + type marker
  out.focused = await page.evaluate(() => {
    const tas = [...document.querySelectorAll('.xterm-helper-textarea')]
    const ta = tas.find((el) => el.offsetParent !== null || el.getClientRects().length > 0) ?? tas.at(-1)
    ta?.focus()
    return !!ta
  })
  await page.keyboard.insertText('echo PROD-SMOKE-20261117-062441')
  await page.keyboard.press('Enter')
  await sleep(3000)
  await page.screenshot({ path: path.join(SHOTS, 'probe-echo.png') })
  out.rowsTextLenAfter = await page.evaluate(() =>
    [...document.querySelectorAll('.xterm')]
      .filter((el) => el.offsetParent !== null)
      .reduce((n, w) => n + [...w.querySelectorAll('.xterm-rows > div')].reduce((m, r) => m + (r.textContent ?? '').length, 0), 0)
  )

  // clipboard select-all oracle
  const tryClip = async (mod) => {
    await page.evaluate(() => {
      const tas = [...document.querySelectorAll('.xterm-helper-textarea')]
      const ta = tas.find((el) => el.offsetParent !== null || el.getClientRects().length > 0) ?? tas.at(-1)
      ta?.focus()
    })
    await page.keyboard.press(`${mod}+a`)
    await sleep(300)
    await page.keyboard.press(`${mod}+c`)
    await sleep(400)
    return page.evaluate(() => navigator.clipboard.readText().catch((e) => `CLIP_ERR ${e.message}`))
  }
  out.clipMeta = (await tryClip('Meta')).slice(-400)
  out.clipCtrl = (await tryClip('Control')).slice(-400)
  out.dialogNow = await page.evaluate(() =>
    [...document.querySelectorAll('[data-slot="dialog-content"]')].map((d) => (d.innerText ?? '').slice(0, 100))
  )
} catch (e) {
  out.error = `${e.message}\n${e.stack}`
} finally {
  fs.writeFileSync(path.join(OUT, 'probe-terminal-oracle.json'), JSON.stringify(out, null, 2))
  console.log(JSON.stringify(out, null, 2))
  await context?.close().catch(() => {})
}
