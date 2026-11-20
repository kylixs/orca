#!/usr/bin/env node
/**
 * U96 diagnosis probe (read-only): Orca Web (full web client) cloud workspace.
 * The platform mints a web handoff; the web tab opens the cloud project. Open
 * extra tabs + a terminal marker, close the web tab, open a fresh handoff, and
 * dump tabs / terminal text / browser storage. No repo code changes.
 */
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const BASE = process.env.ORCA_QA_BASE ?? 'https://127.0.0.1:18787'
const USER = process.env.ORCA_QA_USER ?? 'admin'
const PASS = process.env.ORCA_QA_PASS ?? 'Adm1n!'
const OUT = path.resolve('evidence/u96-diagnosis')
fs.mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const MARK = `U96-WEB-${Date.now()}`

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1440, height: 900 }
})
const page = await context.newPage()
page.setDefaultTimeout(45_000)
page.on('dialog', (d) => d.accept())
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 300)))

const out = { base: BASE, marker: MARK, steps: {} }

async function login() {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await page.locator('#loginForm').waitFor({ state: 'visible' })
  await page.fill('#username', USER)
  await page.fill('#password', PASS)
  await page.click('#loginBtn')
  await page.locator('#view-app').waitFor({ state: 'visible' })
}

async function mintOrcaWeb() {
  await page.locator('tr', { hasText: 'demo' }).first().locator('[data-orca-web]').click()
  const popup = await page.waitForEvent('popup', { timeout: 45_000 })
  popup.setDefaultTimeout(90_000)
  popup.on('dialog', (d) => d.accept())
  popup.on('pageerror', (e) => errors.push('[web] ' + String(e).slice(0, 300)))
  popup.on('console', (m) => m.type() === 'error' && errors.push('[web] ' + m.text().slice(0, 300)))
  await popup.waitForSelector('.app-layout', { timeout: 90_000 })
  return popup
}

async function webState(popup, label, shot) {
  const state = await popup
    .evaluate(() => {
      const tabs = [...document.querySelectorAll('[data-testid="sortable-tab"]')].map((el) => ({
        id: el.getAttribute('data-tab-id'),
        title: el.getAttribute('data-tab-title'),
        active: el.getAttribute('aria-selected')
      }))
      const groups = document.querySelectorAll('[data-tab-group-id]').length
      const rows = [...document.querySelectorAll('.xterm-rows')].map((el) =>
        (el.textContent ?? '').slice(-1200)
      )
      const dump = (s) => {
        const o = {}
        for (let i = 0; i < s.length; i += 1) {
          const k = s.key(i)
          if (/workspaceSession|lastActive|ui\.|tab|session/i.test(k)) {
            o[k] = String(s.getItem(k)).slice(0, 3000)
          }
        }
        return o
      }
      return {
        url: location.href.replace(/#.*/, ''),
        hashPresent: location.hash.includes('handoff'),
        tabs,
        groupMarkers: groups,
        terminalRows: rows,
        localStorage: dump(localStorage),
        sessionStorage: dump(sessionStorage)
      }
    })
    .catch((error) => ({ evaluateError: String(error) }))
  out.steps[label] = state
  if (shot) await popup.screenshot({ path: path.join(OUT, shot) }).catch(() => {})
  console.log(
    label,
    JSON.stringify({
      tabs: state.tabs,
      groups: state.groupMarkers,
      terminalTail: state.terminalRows?.map((r) => r.slice(-300)),
      storageKeys: state.localStorage ? Object.keys(state.localStorage) : null
    })
  )
  return state
}

async function dismissTips(popup) {
  const gotIt = popup.getByRole('button', { name: /Got it|知道了|明白/ }).first()
  if (await gotIt.isVisible().catch(() => false)) {
    await gotIt.click({ timeout: 10_000 }).catch(() => {})
    await sleep(500)
  }
}

async function newTerminalTab(popup) {
  await dismissTips(popup)
  const clicked = await popup
    .evaluate(() => {
      const buttons = [...document.querySelectorAll('button')]
      const target = buttons.find((el) => {
        const label = `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('title') ?? ''}`
        return /New tab|新标签页|新标签|新規タブ|Nouvel onglet|Nueva pestaña|새 탭/i.test(label)
      })
      if (!target) return false
      target.click()
      return true
    })
    .catch(() => false)
  if (!clicked) {
    throw new Error('new-tab button not found')
  }
  await sleep(1500)
  // The dropdown lists entry kinds; pick the plain terminal.
  const terminalItem = popup.getByRole('menuitem', { name: /Terminal|终端|終端|터미널/i }).first()
  if (await terminalItem.isVisible().catch(() => false)) {
    await terminalItem.click({ timeout: 15_000 }).catch(() => {})
    await sleep(2500)
  }
}

try {
  await login()
  let popup = await mintOrcaWeb()
  await dismissTips(popup)
  await popup
    .locator('.xterm')
    .first()
    .waitFor({ state: 'attached', timeout: 60_000 })
    .catch(() => {})
  await sleep(8000)
  await webState(popup, 'web-open-fresh', 'u96-web-1-fresh.png')

  // Second tab + terminal marker in it.
  await newTerminalTab(popup)
  await popup
    .locator('.xterm')
    .last()
    .click()
    .catch(() => {})
  await popup.keyboard.type(`echo ${MARK}`)
  await popup.keyboard.press('Enter')
  await sleep(2500)
  await webState(popup, 'web-after-terminal', 'u96-web-2-terminal.png')

  await newTerminalTab(popup)
  await webState(popup, 'web-after-second-tab', 'u96-web-3-two-tabs.png')

  // Reopen: close the whole web tab, mint a fresh handoff in a new tab.
  await popup.close()
  await sleep(1000)
  popup = await mintOrcaWeb()
  await dismissTips(popup)
  await popup
    .locator('.xterm')
    .first()
    .waitFor({ state: 'attached', timeout: 60_000 })
    .catch(() => {})
  await sleep(8000)
  await webState(popup, 'web-reopen-fresh-handoff', 'u96-web-4-reopen.png')

  // Same-document reload (session restore path), then inspect again.
  await popup.reload({ waitUntil: 'domcontentloaded' })
  await popup.waitForSelector('.app-layout', { timeout: 90_000 })
  await dismissTips(popup)
  await popup
    .locator('.xterm')
    .first()
    .waitFor({ state: 'attached', timeout: 60_000 })
    .catch(() => {})
  await sleep(8000)
  await webState(popup, 'web-after-reload', 'u96-web-5-reload.png')
} catch (error) {
  out.error = String(error).slice(0, 1500)
  await page.screenshot({ path: path.join(OUT, 'u96-web-error.png') }).catch(() => {})
} finally {
  out.errors = errors.slice(-20)
  fs.writeFileSync(path.join(OUT, 'u96-orca-web-result.json'), JSON.stringify(out, null, 2))
  await browser.close()
}
