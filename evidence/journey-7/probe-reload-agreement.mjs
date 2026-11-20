#!/usr/bin/env node
// Follow-up: reload agreement between DOM/store/host on the persisted 2-group state.
import { chromium } from 'playwright'
import fs from 'node:fs'

const BASE = 'https://127.0.0.1:18787'
const OUT = 'evidence/journey-7'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = { base: BASE, steps: {} }
const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1440, height: 900 }
})
const consolePage = await ctx.newPage()
consolePage.setDefaultTimeout(60000)
consolePage.on('dialog', (d) => d.accept())
const domState = (p) =>
  p.evaluate(() => ({
    tabs: [...document.querySelectorAll('[data-testid="sortable-tab"]')].map((el) => ({
      id: el.getAttribute('data-tab-id'),
      active: el.getAttribute('data-active'),
      title: el.getAttribute('data-tab-title'),
      visible: el.offsetParent !== null
    })),
    strips: document.querySelectorAll('.terminal-tab-strip').length,
    activePanes: document.querySelectorAll('.pane-title-bar[data-active-pane]').length,
    activePaneTitles: [...document.querySelectorAll('.pane-title-bar[data-active-pane]')].map(
      (el) => el.textContent?.replace(/\s+/g, ' ').slice(0, 80)
    ),
    visibility: document.visibilityState
  }))
const storeState = (p) =>
  p.evaluate(() => {
    const s = window.__store?.getState?.()
    const wt = s?.activeWorktreeId
    return {
      wt,
      activeTabId: s?.activeTabIdByWorktree?.[wt] ?? null,
      activeGroupId: s?.activeGroupIdByWorktree?.[wt] ?? null,
      tabs: (s?.tabsByWorktree?.[wt] ?? []).map((t) => ({ id: t.id, title: t.title })),
      groups: (s?.groupsByWorktree?.[wt] ?? []).map((g) => ({ id: g.id, tabOrder: g.tabOrder }))
    }
  })
try {
  await consolePage.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await consolePage.locator('#loginForm').waitFor({ timeout: 30000 })
  await consolePage.fill('#username', 'zhangsan')
  await consolePage.fill('#password', 'Passw0rd!')
  await consolePage.click('#loginBtn')
  await consolePage.locator('#view-app').waitFor({ timeout: 30000 })
  const projects = await consolePage.evaluate(
    async () =>
      (
        await (
          await fetch('/v1/projects', {
            headers: { authorization: `Bearer ${localStorage.getItem('orca.access')}` }
          })
        ).json()
      ).projects
  )
  const target = projects.find((p) => p.key === 'zhangsan-demo')
  const pp = ctx.waitForEvent('page')
  await consolePage.locator(`[data-orca-web="${target.id}"]`).first().click()
  const popup = await pp
  popup.setDefaultTimeout(120000)
  popup.on('dialog', (d) => d.accept())
  await popup.waitForSelector('.app-layout', { timeout: 180000 })
  await sleep(5000)
  const envId = (await popup.evaluate(() => window.api.runtimeEnvironments.list()))[0]?.id
  const store = await storeState(popup)
  const worktree = `id:${store.wt}`
  const call = (method, params) =>
    popup.evaluate(
      async ({ envId, method, params }) => {
        const r = await window.api.runtimeEnvironments.call({
          selector: envId,
          method,
          params,
          timeoutMs: 60000
        })
        return r.ok ? r.result : { error: r.error }
      },
      { envId, method, params }
    )
  out.steps.initial = {
    dom: await domState(popup),
    store,
    host: await call('session.tabs.list', { worktree })
  }
  await sleep(15000)
  out.steps.initialSettled = {
    dom: await domState(popup),
    store: await storeState(popup),
    host: await call('session.tabs.list', { worktree })
  }
  await popup.reload({ waitUntil: 'domcontentloaded' })
  await popup.waitForSelector('.app-layout', { timeout: 180000 })
  await sleep(6000)
  out.steps.afterReload = {
    dom: await domState(popup),
    store: await storeState(popup),
    host: await call('session.tabs.list', { worktree })
  }
  await popup.screenshot({ path: `${OUT}/reload-agreement.png` })
} catch (e) {
  out.error = String(e).slice(0, 1500)
} finally {
  fs.writeFileSync(`${OUT}/reload-agreement.json`, JSON.stringify(out, null, 2))
  await browser.close()
}
console.log(JSON.stringify(out, null, 2))
