#!/usr/bin/env node
// Follow-up probe: record full session.tabs.move replies for the A2 split/move path.
import { chromium } from 'playwright'
import fs from 'node:fs'

const BASE = process.env.ORCA_QA_BASE ?? 'https://127.0.0.1:18787'
const OUT = '/Users/gongdewei/work/projects/orca/evidence/journey-final7-20261117-055415'
const DEV = { username: 'zhangsan', password: 'Passw0rd!' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const result = { steps: [], errors: [] }
const browser = await chromium.launch({ headless: true })
try {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } })
  const consolePage = await ctx.newPage()
  consolePage.setDefaultTimeout(60_000)
  await consolePage.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await consolePage.locator('#loginForm').waitFor({ state: 'visible', timeout: 30_000 })
  const resp = consolePage.waitForResponse((r) => /\/v1\/auth\/login/.test(r.url()))
  await consolePage.fill('#username', DEV.username)
  await consolePage.fill('#password', DEV.password)
  await consolePage.click('#loginBtn')
  await resp
  await consolePage.locator('#view-app').waitFor({ state: 'visible', timeout: 30_000 })
  const token = await consolePage.evaluate(() => localStorage.getItem('orca.access'))
  const projects = (
    await (
      await fetch(BASE + '/v1/projects', { headers: { authorization: `Bearer ${token}` } })
    ).json()
  ).projects
  const project = projects.find((p) => p.key === 'zhangsan-demo')
  const button = consolePage.locator(`[data-orca-web="${project.id}"]`).first()
  await button.waitFor({ state: 'visible', timeout: 60_000 })
  const popupPromise = ctx.waitForEvent('page', { timeout: 90_000 })
  popupPromise.catch(() => {})
  await button.click({ timeout: 30_000 })
  const page = await popupPromise
  page.setDefaultTimeout(120_000)
  page.on('dialog', (d) => d.accept())
  page.on('pageerror', (e) => result.errors.push(String(e).slice(0, 400)))
  await page.waitForSelector('.app-layout', { timeout: 180_000 })
  await page.waitForSelector('[data-testid="sortable-tab"]', { timeout: 120_000 }).catch(() => {})
  await sleep(3000)
  const envs = await page.evaluate(() => window.api.runtimeEnvironments.list())
  const envId = envs[0]?.id
  const store = await page.evaluate(() => {
    const s = window.__store?.getState?.()
    return { activeWorktreeId: s?.activeWorktreeId ?? null }
  })
  const worktree = `id:${store.activeWorktreeId}`
  const hostCall = (method, params) =>
    page.evaluate(
      async ({ envId, method, params }) => {
        const reply = await window.api.runtimeEnvironments.call({
          selector: envId,
          method,
          params,
          timeoutMs: 60_000
        })
        return reply.ok ? { ok: true, result: reply.result } : { ok: false, error: reply.error }
      },
      { envId, method, params }
    )
  const snap = async (label) => {
    const r = await hostCall('session.tabs.list', { worktree })
    const b = r.ok
      ? {
          tabs: (r.result.tabs ?? []).map((t) => ({
            id: t.id,
            parentTabId: t.parentTabId,
            isActive: t.isActive
          })),
          tabGroups: (r.result.tabGroups ?? []).map((g) => ({
            id: g.id,
            activeTabId: g.activeTabId,
            tabOrder: g.tabOrder
          })),
          tabGroupLayout:
            r.result.tabGroupLayout === undefined
              ? 'absent'
              : JSON.stringify(r.result.tabGroupLayout).slice(0, 300),
          activeTabId: r.result.activeTabId,
          activeGroupId: r.result.activeGroupId
        }
      : r
    result.steps.push({ label, snapshot: b })
    return r
  }
  await snap('initial')
  const before = result.steps[0].snapshot
  const surfaces = before.tabs.filter((t) => t.parentTabId)
  const groups = before.tabGroups
  if (!surfaces.length || !groups.length) throw new Error('no surfaces/group to move')
  const surface = surfaces[0]
  const group = groups.find((g) => g.tabOrder?.includes(surface.parentTabId)) ?? groups[0]
  const split = await hostCall('session.tabs.move', {
    kind: 'split',
    worktree,
    tabId: surface.id,
    targetGroupId: group.id,
    splitDirection: 'right'
  })
  result.steps.push({ label: 'split-reply', reply: split })
  await sleep(1500)
  await snap('after-split')
  const afterSplit = result.steps[result.steps.length - 1].snapshot
  const newGroup = afterSplit.tabGroups?.find((g) => !groups.some((x) => x.id === g.id))
  const second = surfaces.find((t) => t.parentTabId !== surface.parentTabId)
  if (newGroup && second) {
    const move = await hostCall('session.tabs.move', {
      kind: 'move-to-group',
      worktree,
      tabId: second.id,
      targetGroupId: newGroup.id
    })
    result.steps.push({ label: 'move-reply', reply: move })
    await sleep(1500)
    await snap('after-move')
    const activate = await hostCall('session.tabs.activate', {
      worktree,
      tabId: surface.id
    })
    result.steps.push({ label: 'activate-reply', reply: activate })
    await sleep(1500)
    await snap('after-activate')
  } else {
    result.steps.push({ label: 'no-new-group-or-second-surface', newGroup: newGroup ?? null })
  }
  await page.screenshot({ path: `${OUT}/probe-move-result.png` })
} catch (e) {
  result.errors.push(String(e).slice(0, 1000))
} finally {
  fs.writeFileSync(`${OUT}/probe-move-result.json`, JSON.stringify(result, null, 2))
  await browser.close()
}
console.log(JSON.stringify(result, null, 2).slice(0, 6000))
