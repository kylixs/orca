#!/usr/bin/env node
/** U104 read-only probe: second+ open of the same project's Orca Web workspace. */
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const BASE = process.env.ORCA_QA_BASE ?? 'https://127.0.0.1:18787'
const USER = process.env.ORCA_QA_USER ?? 'admin'
const PASS = process.env.ORCA_QA_PASS ?? 'Adm1n!'
const OUT = path.resolve('evidence/u104')
fs.mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const MARK = `U104-${Date.now()}`
const out = { base: BASE, marker: MARK, steps: {}, ws: {} }
const errors = []

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1440, height: 900 }
})
const page = await context.newPage()
page.setDefaultTimeout(45_000)
page.on('dialog', (d) => d.accept())

function watch(ws, tag) {
  const rec = { sent: [], recv: [] }
  out.ws[tag] = rec
  const interesting = (s) =>
    /session\.tabs|workspace\.info|terminal\.(create|list|adoptOrphans|subscribe|multiplex)|"snapshot"|"updated"|"removed"|capabilit/i.test(
      s
    )
  ws.on('framesent', (f) => {
    const s = typeof f.payload === 'string' ? f.payload : ''
    if (interesting(s)) rec.sent.push(s.slice(0, 1200))
  })
  ws.on('framereceived', (f) => {
    const s = typeof f.payload === 'string' ? f.payload : ''
    if (interesting(s)) rec.recv.push(s.slice(0, 1500))
  })
}

async function login() {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await page.locator('#loginForm').waitFor({ state: 'visible' })
  await page.fill('#username', USER)
  await page.fill('#password', PASS)
  await page.click('#loginBtn')
  await page.locator('#view-app').waitFor({ state: 'visible' })
}

async function mintOrcaWeb(tag) {
  const popupPromise = context.waitForEvent('page', { timeout: 45_000 })
  await page.locator('tr', { hasText: 'demo' }).first().locator('[data-orca-web]').click()
  const popup = await popupPromise
  popup.setDefaultTimeout(90_000)
  popup.on(
    'console',
    (m) => m.type() === 'error' && errors.push(`[${tag}] ${m.text().slice(0, 300)}`)
  )
  popup.on('pageerror', (e) => errors.push(`[${tag}] ${String(e).slice(0, 300)}`))
  popup.on('websocket', (ws) => watch(ws, tag))
  await popup.waitForSelector('.app-layout', { timeout: 120_000 })
  return popup
}

async function state(popup, label, shot) {
  const s = await popup
    .evaluate(() => {
      const tabs = [...document.querySelectorAll('[data-testid="sortable-tab"]')].map((el) => ({
        id: el.getAttribute('data-tab-id'),
        title: el.getAttribute('data-tab-title'),
        active: el.getAttribute('aria-selected')
      }))
      const groups = [...document.querySelectorAll('[data-tab-group-id]')].map((el) =>
        el.getAttribute('data-tab-group-id')
      )
      const rows = [...document.querySelectorAll('.xterm-rows')].map((el) =>
        (el.textContent ?? '').slice(-800)
      )
      const dump = (st) => {
        const o = {}
        for (let i = 0; i < st.length; i += 1) {
          const k = st.key(i)
          if (/workspaceSession|workspace|lastActive|tab/i.test(k))
            o[k] = String(st.getItem(k)).slice(0, 2500)
        }
        return o
      }
      return {
        url: location.href.replace(/#.*/, ''),
        hash: location.hash.slice(0, 40),
        tabs,
        groups,
        terminalRows: rows,
        storage: dump(localStorage)
      }
    })
    .catch((e) => ({ evaluateError: String(e) }))
  out.steps[label] = s
  if (shot) await popup.screenshot({ path: path.join(OUT, shot) }).catch(() => {})
  console.log(
    label,
    JSON.stringify({
      tabs: s.tabs,
      groups: s.groups,
      termTail: (s.terminalRows || []).map((r) => r.slice(-160))
    })
  )
  return s
}

async function waitTerminal(popup) {
  await popup
    .locator('.xterm')
    .first()
    .waitFor({ state: 'attached', timeout: 90_000 })
    .catch(() => {})
  await sleep(6000)
}

try {
  await login()
  const first = await mintOrcaWeb('open1')
  await waitTerminal(first)
  await state(first, 'open1-fresh', 'u104-1-first-open.png')
  await first
    .locator('.xterm')
    .first()
    .click()
    .catch(() => {})
  await first.keyboard.type(`echo ${MARK}`)
  await first.keyboard.press('Enter')
  await sleep(3000)
  await state(first, 'open1-after-marker', 'u104-2-first-marker.png')

  // Path 3: a second browser tab for the same project while the first stays open.
  const second = await mintOrcaWeb('open2')
  await waitTerminal(second)
  await state(second, 'open2-second-tab-fresh', 'u104-3-second-open.png')
  await sleep(3000)
  await state(second, 'open2-settled', 'u104-4-second-settled.png')

  // Path 1: same page reload of the second tab.
  await second.reload({ waitUntil: 'domcontentloaded' })
  await second.waitForSelector('.app-layout, #view-login', { timeout: 90_000 }).catch(() => {})
  await sleep(8000)
  await state(second, 'open2-after-reload', 'u104-5-second-reload.png')

  await first.close().catch(() => {})
  await second.close().catch(() => {})
} catch (error) {
  out.error = String(error).slice(0, 2000)
  await page.screenshot({ path: path.join(OUT, 'u104-error.png') }).catch(() => {})
} finally {
  out.errors = errors.slice(-30)
  for (const [k, v] of Object.entries(out.ws)) {
    v.sent = v.sent.slice(0, 80)
    v.recv = v.recv.slice(0, 120)
  }
  fs.writeFileSync(path.join(OUT, 'u104-probe-result.json'), JSON.stringify(out, null, 2))
  await browser.close()
}
