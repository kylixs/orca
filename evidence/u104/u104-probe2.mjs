#!/usr/bin/env node
/** U104 probe 2: does the cloud client's transport see the host inventory? */
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
const BASE = process.env.ORCA_QA_BASE ?? 'https://127.0.0.1:18787'
const OUT = path.resolve('evidence/u104')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = { steps: {}, console: [] }
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1440, height: 900 }
})
const page = await context.newPage()
page.setDefaultTimeout(45_000)
page.on('dialog', (d) => d.accept())
async function login() {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await page.locator('#loginForm').waitFor({ state: 'visible' })
  await page.fill('#username', 'admin')
  await page.fill('#password', 'Adm1n!')
  await page.click('#loginBtn')
  await page.locator('#view-app').waitFor({ state: 'visible' })
}
async function mint(tag) {
  const p = context.waitForEvent('page', { timeout: 60_000 })
  await page.locator('tr', { hasText: 'demo' }).first().locator('[data-orca-web]').click()
  const popup = await p
  popup.setDefaultTimeout(120_000)
  popup.on('console', (m) => {
    const t = m.text()
    if (/session-tabs|listAll|subscribe|restore|mirror|capab/i.test(t))
      out.console.push(`${tag}:${m.type()}: ${t.slice(0, 400)}`)
  })
  popup.on('pageerror', (e) => out.console.push(`${tag}:pageerror: ${String(e).slice(0, 300)}`))
  await popup.waitForSelector('.app-layout', { timeout: 150_000 })
  return popup
}
async function probe(popup, tag) {
  await popup
    .locator('.xterm')
    .first()
    .waitFor({ state: 'attached', timeout: 120_000 })
    .catch(() => {})
  await sleep(8000)
  const local = await popup.evaluate(() => {
    const tabs = [...document.querySelectorAll('[data-testid="sortable-tab"]')].map((el) => ({
      id: el.getAttribute('data-tab-id'),
      title: el.getAttribute('data-tab-title')
    }))
    const env = Object.keys(localStorage).find((k) => /runtime|environment/i.test(k))
    return { tabs, envKey: env, env: env ? String(localStorage.getItem(env)).slice(0, 600) : null }
  })
  let host = null
  try {
    host = await popup.evaluate(async () => {
      const raw =
        localStorage.getItem('orca.webRuntimeEnvironment.v1') ??
        localStorage.getItem(
          Object.keys(localStorage).find((k) => /runtime.*environment|web.*environment/i.test(k)) ??
            ''
        )
      const env = raw ? JSON.parse(raw) : null
      const selector = env?.id ?? env?.environment?.id
      if (!selector) return { error: 'no selector', keys: Object.keys(localStorage) }
      const resp = await window.api.runtimeEnvironments.call({
        selector,
        method: 'session.tabs.listAll',
        params: {},
        timeoutMs: 15000
      })
      const snapshots = resp?.ok ? (resp.result?.snapshots ?? []) : []
      return {
        selector,
        ok: resp?.ok,
        error: resp?.ok === false ? resp.error : null,
        snapshotCount: snapshots.length,
        snapshots: snapshots.map((s) => ({
          worktree: String(s.worktree ?? s.worktreeId ?? '').slice(-60),
          tabs: (s.tabs ?? []).length,
          groups: (s.tabGroups ?? []).length,
          titles: (s.tabs ?? []).slice(-5).map((t) => t.title)
        }))
      }
    })
  } catch (e) {
    host = { evaluateError: String(e).slice(0, 500) }
  }
  out.steps[tag] = { local, host }
  console.log(
    tag,
    JSON.stringify({
      localTabs: local.tabs,
      hostSnapshotCount: host?.snapshotCount,
      hostErr: host?.error,
      hostWorktrees: host?.snapshots?.map((s) => [s.worktree.slice(-28), s.tabs, s.groups])
    })
  )
}
try {
  await login()
  const a = await mint('openA')
  await probe(a, 'openA')
  const b = await mint('openB')
  await probe(b, 'openB')
  await sleep(4000)
  await probe(b, 'openB-settled')
  await a.close().catch(() => {})
  await b.close().catch(() => {})
} catch (e) {
  out.error = String(e).slice(0, 1500)
} finally {
  out.console = out.console.slice(-40)
  fs.writeFileSync(path.join(OUT, 'u104-probe2-result.json'), JSON.stringify(out, null, 2))
  await browser.close()
}
