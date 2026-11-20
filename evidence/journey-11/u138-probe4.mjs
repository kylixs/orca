#!/usr/bin/env node
// U138 phase4 diagnosis probe: event-level timeline for restored-active reassert.
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const BASE = process.env.ORCA_QA_BASE ?? 'https://127.0.0.1:18787'
const OUT = path.resolve('evidence/journey-11')
const DEV = { username: 'zhangsan', password: 'Passw0rd!' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const result = { base: BASE, startedAt: Date.now(), phases: {}, errors: [] }

const initScript = () => {
  const log = (window.__u138 = { rpc: [], frames: [] })
  const wrap = (api) => {
    if (!api || api.__u138Wrapped) return api
    api.__u138Wrapped = true
    const re = api.runtimeEnvironments
    if (re?.call) {
      const orig = re.call.bind(re)
      re.call = async (args) => {
        const t = Date.now()
        const r = await orig(args)
        if (/^session\.tabs\.(activate|list|listAll|move|close)$/.test(args.method)) {
          log.rpc.push({
            t,
            method: args.method,
            params: args.params,
            ok: r?.ok,
            active: r?.result?.activeTabId ?? null
          })
        }
        return r
      }
    }
    if (re?.subscribe) {
      const orig = re.subscribe.bind(re)
      re.subscribe = async (args, callbacks) => {
        const wrapped = {
          ...callbacks,
          onResponse: (response) => {
            const ev = response?.result
            if (ev && (ev.type === 'snapshot' || ev.type === 'updated')) {
              log.frames.push({
                t: Date.now(),
                type: ev.type,
                active: ev.activeTabId ?? null,
                ver: ev.snapshotVersion ?? null,
                worktree: String(ev.worktree ?? '').slice(0, 24)
              })
            }
            return callbacks.onResponse?.(response)
          }
        }
        return orig(args, wrapped)
      }
    }
    return api
  }
  let current
  Object.defineProperty(window, 'api', {
    configurable: true,
    get: () => current,
    set: (v) => {
      current = wrap(v)
    }
  })
}

const tabState = (page) =>
  page.evaluate(() => ({
    domActive: [
      ...document.querySelectorAll('[data-testid="sortable-tab"][data-active="true"]')
    ].map((el) => el.getAttribute('data-tab-id')),
    tabs: [...document.querySelectorAll('[data-testid="sortable-tab"]')].length,
    strips: document.querySelectorAll('.terminal-tab-strip').length
  }))

const storeState = (page) =>
  page.evaluate(() => {
    const s = window.__store?.getState?.()
    if (!s) return { exposed: false }
    const wt = s.activeWorktreeId
    return {
      exposed: true,
      wt,
      active: s.activeTabIdByWorktree?.[wt] ?? null,
      tabs: (s.tabsByWorktree?.[wt] ?? []).length,
      groups: (s.groupsByWorktree?.[wt] ?? []).length
    }
  })

const drain = (page) =>
  page.evaluate(() => {
    const l = window.__u138
    if (!l) return { rpc: [], frames: [] }
    const out = { rpc: l.rpc.splice(0), frames: l.frames.splice(0) }
    return out
  })

async function login(page) {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await page.locator('#loginForm').waitFor({ state: 'visible', timeout: 30_000 })
  const resp = page.waitForResponse((r) => /\/v1\/auth\/login/.test(r.url()))
  await page.fill('#username', DEV.username)
  await page.fill('#password', DEV.password)
  await page.click('#loginBtn')
  await resp
  await page.locator('#view-app').waitFor({ state: 'visible', timeout: 30_000 })
}

async function openWorkspace(context, consolePage, projectId) {
  const button = consolePage.locator(`[data-orca-web="${projectId}"]`).first()
  await button.waitFor({ state: 'visible', timeout: 60_000 })
  const popupPromise = context.waitForEvent('page', { timeout: 90_000 })
  popupPromise.catch(() => {})
  await button.click({ timeout: 30_000 })
  const popup = await popupPromise
  popup.setDefaultTimeout(120_000)
  popup.on('pageerror', (e) => result.errors.push(String(e).slice(0, 300)))
  await popup.waitForSelector('.app-layout', { timeout: 180_000 })
  await popup.waitForSelector('[data-testid="sortable-tab"]', { timeout: 120_000 }).catch(() => {})
  return popup
}

async function hostCall(page, envId, method, params) {
  return page.evaluate(
    async ({ envId, method, params }) => {
      const reply = await window.api.runtimeEnvironments.call({
        selector: envId,
        method,
        params,
        timeoutMs: 60_000
      })
      if (!reply.ok) return { ok: false, error: reply.error }
      return { ok: true, result: reply.result }
    },
    { envId, method, params }
  )
}

const brief = (r) =>
  !r?.ok
    ? r
    : {
        active: r.result?.activeTabId ?? null,
        tabs: (r.result?.tabs ?? []).map((t) => ({
          id: t.id,
          parent: t.parentTabId,
          active: t.isActive
        })),
        groups: (r.result?.tabGroups ?? []).map((g) => ({
          id: g.id,
          active: g.activeTabId,
          order: g.tabOrder
        }))
      }

async function sample(page, envId, worktree, label) {
  const dom = await tabState(page).catch(() => null)
  const store = await storeState(page).catch(() => null)
  const host = await hostCall(page, envId, 'session.tabs.list', { worktree }).catch((e) => ({
    ok: false,
    error: String(e)
  }))
  return { t: Date.now(), label, dom, store, host: brief(host) }
}

async function timeline(page, envId, worktree, label, ms, every = 250) {
  const rows = []
  const end = Date.now() + ms
  while (Date.now() < end) {
    const s = await sample(page, envId, worktree, label)
    const log = await drain(page)
    rows.push({ ...s, rpc: log.rpc, frames: log.frames })
    await sleep(every)
  }
  return rows
}

const browser = await chromium.launch({ headless: true })
try {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 }
  })
  await context.addInitScript(initScript)
  const consolePage = await context.newPage()
  await login(consolePage)
  const token = await consolePage.evaluate(() => localStorage.getItem('orca.access'))
  const projects = await fetch(BASE + '/v1/projects', {
    headers: { authorization: `Bearer ${token}` }
  })
    .then((r) => r.json())
    .then((b) => b.projects ?? [])
  const project = projects.find((p) => p.key === 'zhangsan-demo')
  result.projectId = project?.id ?? null

  let popup = await openWorkspace(context, consolePage, project.id)
  await sleep(4000)
  const envs = await popup.evaluate(() => window.api.runtimeEnvironments.list())
  const envId = envs[0]?.id
  const st0 = await storeState(popup)
  const worktree = `id:${st0.wt}`
  result.envId = envId
  result.worktree = worktree
  result.openInitial = await sample(popup, envId, worktree, 'open')

  // Pick a non-active parent and activate it through the paired path, then observe echo.
  const list0 = await hostCall(popup, envId, 'session.tabs.list', { worktree })
  const tabs = list0.result?.tabs ?? []
  const parents = [...new Set(tabs.map((t) => t.parentTabId ?? t.id))]
  result.parents = parents
  const activeParent = String(list0.result?.activeTabId ?? '').split('::')[0]
  const target = parents.find((p) => p !== activeParent)
  result.activateTarget = target
  if (target) {
    const surface = tabs.find((t) => (t.parentTabId ?? t.id) === target)
    const r = await hostCall(popup, envId, 'session.tabs.activate', {
      worktree,
      tabId: surface?.id ?? target
    })
    result.activateRpc = r.ok ? { ok: true, active: r.result?.activeTabId } : r
    result.afterActivate = await timeline(popup, envId, worktree, 'after-activate', 3000)
  }

  // Reload: focus of restored-active reassert.
  await drain(popup)
  await popup.reload({ waitUntil: 'domcontentloaded' })
  await popup.waitForSelector('.app-layout', { timeout: 180_000 })
  result.reload = await timeline(popup, envId, worktree, 'reload', 25_000)

  // Reopen x3.
  await popup.close()
  result.reopens = []
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    popup = await openWorkspace(context, consolePage, project.id)
    const cycleEnvs = await popup.evaluate(() => window.api.runtimeEnvironments.list())
    const cycleEnv = cycleEnvs[0]?.id ?? envId
    const rows = await timeline(popup, cycleEnv, worktree, `reopen-${cycle}`, 9000)
    result.reopens.push(rows)
    if (cycle < 3) await popup.close()
  }
  result.ok = true
} catch (e) {
  result.errors.push(String(e).slice(0, 800))
} finally {
  fs.writeFileSync(path.join(OUT, 'u138-probe4.json'), JSON.stringify(result, null, 1))
  await browser.close()
  console.log(
    JSON.stringify({
      ok: result.ok,
      errors: result.errors,
      phases: Object.fromEntries(
        Object.entries(result).filter(([k]) => ['openInitial', 'reload'].includes(k))
      ).reload?.length
    })
  )
}
