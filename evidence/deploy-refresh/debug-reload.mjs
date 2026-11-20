#!/usr/bin/env node
import { chromium } from 'playwright'
const BASE = 'https://127.0.0.1:18787'
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ ignoreHTTPSErrors: true })
const page = await context.newPage()
const logs = []
page.on('console', (m) => logs.push(`${m.type()}: ${m.text().slice(0, 200)}`))
page.on('pageerror', (e) => logs.push(`pageerror: ${String(e).slice(0, 300)}`))
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
await page.locator('#loginForm').waitFor({ state: 'visible', timeout: 30000 })
await page.fill('#username', 'admin')
await page.fill('#password', 'Adm1n!')
await page.click('#loginBtn')
await page.locator('#view-app').waitFor({ state: 'visible', timeout: 30000 })
const hosts = await page.evaluate(async () =>
  (
    await fetch('/v1/hosts', {
      headers: { authorization: 'Bearer ' + localStorage.getItem('orca.access') }
    })
  ).json()
)
const host = hosts.hosts.find((h) => h.name === 'dev-local-02')
const url = `${BASE}/#/hosts/${host.id}?tab=perms`
await page.goto(url, { waitUntil: 'domcontentloaded' })
await page.locator('#hostPermCards .perm-card').first().waitFor({ timeout: 30000 })
console.log(
  'before reload:',
  await page.evaluate(() => ({
    hash: location.hash,
    cards: document.querySelectorAll('#hostPermCards .perm-card').length
  }))
)
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(6000)
const state = await page.evaluate(() => ({
  hash: location.hash,
  loginVisible: Boolean(document.querySelector('#loginForm')),
  appVisible: Boolean(document.querySelector('#view-app')),
  contentText: document.querySelector('#content')?.textContent?.slice(0, 300),
  hostPermCards: document.querySelectorAll('#hostPermCards .perm-card').length,
  permsPanelHidden: [...document.querySelectorAll('[data-auth-panel="perms"]')].map(
    (el) => el.hidden
  ),
  drawers: document.querySelectorAll('.drawer').length,
  dialogs: document.querySelectorAll('.dialog').length,
  crumbs: document.querySelector('#crumbs')?.textContent
}))
console.log(JSON.stringify({ state, logs: logs.slice(-20) }, null, 2))
await browser.close()
