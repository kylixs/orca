#!/usr/bin/env node
// Probe: baseline tab counts per worktree + host split/move effect + store exposure.
import { chromium } from 'playwright'
import fs from 'node:fs'

const BASE = 'https://127.0.0.1:18787'
const OUT = 'evidence/journey-8/post-u138/a'
const STAMP = Date.now()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = { base: BASE, stamp: STAMP, steps: {}, errors: [] }

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1440, height: 900 }
})
const consolePage = await ctx.newPage()
consolePage.setDefaultTimeout(60000)
consolePage.on('dialog', (d) => d.accept())
try {
  await consolePage.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await consolePage.locator('#loginForm').waitFor({ timeout: 30000 })
  await consolePage.fill('#username', 'zhangsan')
  await consolePage.fill('#password', 'Passw0rd!')
  await consolePage.click('#loginBtn')
  await consolePage.locator('#view-app').waitFor({ timeout: 30000 })
  const projects = await consolePage.evaluate(async () => {
    const r = await fetch('/v1/projects', {
      headers: { authorization: `Bearer ${localStorage.getItem('orca.access')}` }
    })
    return (await r.json()).projects
  })
  out.projects = projects.map((p) => ({ id: p.id, key: p.key, hostId: p.hostId }))
  out.steps.consoleUrl = consolePage.url()

  const target = projects.find((p) => p.key === 'zhangsan-demo')
  const popupPromise = ctx.waitForEvent('page', { timeout: 90000 })
  popupPromise.catch(() => {})
  await consolePage.locator(`[data-orca-web="${target.id}"]`).first().click()
  const popup = await popupPromise
  popup.setDefaultTimeout(120000)
  popup.on('dialog', (d) => d.accept())
  popup.on('console', (m) => {
    if (m.type() === 'error') out.errors.push(m.text().slice(0, 300))
  })
  await popup.waitForSelector('.app-layout', { timeout: 180000 })
  await sleep(5000)

  const envs = await popup.evaluate(() => window.api.runtimeEnvironments.list())
  out.steps.envs = envs.map((e) => ({ id: e.id, name: e.name, kind: e.kind }))
  const envId = envs[0]?.id
  const call = (method, params) =>
    popup.evaluate(
      async ({ envId, method, params }) => {
        const r = await window.api.runtimeEnvironments.call({
          selector: envId,
          method,
          params,
          timeoutMs: 60000
        })
        if (!r.ok) return { ok: false, error: r.error }
        return { ok: true, result: r.result }
      },
      { envId, method, params }
    )

  const store0 = await popup.evaluate(() => {
    const s = window.__store?.getState?.()
    const wt = s?.activeWorktreeId
    const tabs = s?.tabsByWorktree?.[wt] ?? []
    return {
      exposed: Boolean(s),
      activeWorktreeId: wt ?? null,
      activeTabId: s?.activeTabId ?? null,
      activeTabIdByWorktree: s?.activeTabIdByWorktree?.[wt] ?? null,
      activeGroupIdByWorktree: s?.activeGroupIdByWorktree?.[wt] ?? null,
      tabs: tabs.map((t) => ({ id: t.id, keys: Object.keys(t), raw: t })),
      tabBarOrder: s?.tabBarOrderByWorktree?.[wt] ?? null
    }
  })
  out.steps.store0 = store0
  if (!store0.activeWorktreeId) throw new Error('no active worktree in store')
  const wtKey = store0.activeWorktreeId
  const worktree = `id:${wtKey}`

  const listAll = await call('session.tabs.listAll', {})
  out.steps.listAll = listAll.ok
    ? {
        snapshots: (listAll.result.snapshots ?? []).map((s) => ({
          worktree: s.worktree,
          tabCount: (s.tabs ?? []).length,
          groupCount: (s.tabGroups ?? []).length,
          activeTabId: s.activeTabId
        }))
      }
    : { error: listAll.error }

  const list0 = await call('session.tabs.list', { worktree })
  out.steps.list0 = list0
  const tabs0 = list0.result?.tabs ?? []
  const keep = list0.result?.activeTabId ?? tabs0[0]?.id
  const retired = []
  for (const t of tabs0) {
    const parent = t.parentTabId ?? t.id
    if (keep === t.id || String(keep).startsWith(`${parent}::`)) continue
    const r = await call('session.tabs.close', { worktree, tabId: parent, reason: 'user' })
    retired.push({ id: parent, ok: r.ok, error: r.error })
  }
  out.steps.retire = retired
  await sleep(1500)
  const list1 = await call('session.tabs.list', { worktree })
  out.steps.list1 = list1
  const ids1 = new Set((list1.result?.tabs ?? []).map((t) => t.id))
  const created = []
  for (const index of [1, 2]) {
    const r = await call('terminal.create', {
      worktree,
      title: `J7 probe ${index}`,
      tabId: `j7-probe-${STAMP}-${index}`,
      leafId: `j7-probe-leaf-${STAMP}-${index}`
    })
    created.push({ ok: r.ok, error: r.error, terminal: r.result?.terminal })
    await sleep(500)
  }
  out.steps.created = created
  const list2 = await call('session.tabs.list', { worktree })
  out.steps.list2 = list2
  const fresh = (list2.result?.tabs ?? []).filter((t) => !ids1.has(t.id))
  out.steps.fresh = fresh.map((t) => ({
    id: t.id,
    parentTabId: t.parentTabId,
    isActive: t.isActive
  }))
  const surface0 = fresh.find(
    (t) =>
      t.parentTabId === created[0].terminal?.tabId ||
      String(t.id).startsWith(`${created[0].terminal?.tabId}::`)
  )
  const surface1 = fresh.find(
    (t) =>
      t.parentTabId === created[1].terminal?.tabId ||
      String(t.id).startsWith(`${created[1].terminal?.tabId}::`)
  )
  const targetGroup = (list2.result?.tabGroups ?? []).find((g) =>
    (g.tabOrder ?? []).includes(surface0?.parentTabId)
  )
  out.steps.splitInput = { surface0, surface1, targetGroup }
  const split = await call('session.tabs.move', {
    kind: 'split',
    worktree,
    tabId: surface0?.id,
    targetGroupId: targetGroup?.id,
    splitDirection: 'right'
  })
  out.steps.split = split
  await sleep(2000)
  const list3 = await call('session.tabs.list', { worktree })
  out.steps.list3 = list3
  const groups3 = list3.result?.tabGroups ?? []
  const second = groups3.find((g) => !(list2.result?.tabGroups ?? []).some((x) => x.id === g.id))
  out.steps.splitNewGroup = second
  if (second && surface1) {
    const move = await call('session.tabs.move', {
      kind: 'move-to-group',
      worktree,
      tabId: surface1.id,
      targetGroupId: second.id
    })
    out.steps.moveToGroup = move
    await sleep(1500)
    out.steps.list4 = await call('session.tabs.list', { worktree })
  } else {
    out.steps.moveToGroup = { skipped: 'no second group; split was a no-op' }
  }
  const dom = await popup.evaluate(() => ({
    appLayout: document.querySelector('.app-layout') !== null,
    tabs: [...document.querySelectorAll('[data-testid="sortable-tab"]')].map((el) => ({
      id: el.getAttribute('data-tab-id'),
      active: el.getAttribute('data-active'),
      aria: el.getAttribute('aria-selected'),
      title: el.getAttribute('data-tab-title')
    })),
    strips: document.querySelectorAll('.terminal-tab-strip').length,
    xterm: document.querySelectorAll('.xterm').length
  }))
  out.steps.domAfter = dom
  out.steps.storeAfter = await popup.evaluate(() => {
    const s = window.__store?.getState?.()
    const wt = s?.activeWorktreeId
    return {
      activeTabId: s?.activeTabId ?? null,
      activeTabIdByWorktree: s?.activeTabIdByWorktree?.[wt] ?? null,
      activeGroupIdByWorktree: s?.activeGroupIdByWorktree?.[wt] ?? null,
      tabs: (s?.tabsByWorktree?.[wt] ?? []).map((t) => ({
        id: t.id,
        groupId: t.groupId,
        isActive: t.isActive,
        parentTabId: t.parentTabId
      }))
    }
  })
  await popup.screenshot({ path: `${OUT}/probe-a2.png` })
} catch (e) {
  out.error = String(e).slice(0, 2000)
  out.errors.push(out.error)
} finally {
  fs.writeFileSync(`${OUT}/probe-a2.json`, JSON.stringify(out, null, 2))
  await browser.close()
}
console.log(
  JSON.stringify(
    {
      error: out.error ?? null,
      listAll: out.steps.listAll,
      list0: out.steps.list0?.result,
      retire: out.steps.retire,
      list1: out.steps.list1?.result,
      split: out.steps.split,
      list3: out.steps.list3?.result,
      moveToGroup: out.steps.moveToGroup,
      list4: out.steps.list4?.result,
      domAfter: out.steps.domAfter,
      storeAfter: out.steps.storeAfter
    },
    null,
    2
  )
)
