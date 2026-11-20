#!/usr/bin/env node
// U138 second probe: create-time vs explicit-activate persistence + F5 flip.
import { chromium } from '/Users/gongdewei/work/projects/orca/node_modules/playwright/index.mjs'
import { execFileSync } from 'node:child_process'

const BASE = 'https://127.0.0.1:18787'
const DEV = { username: 'zhangsan', password: 'Passw0rd!' }
const DB = `file:${process.env.HOME}/orca-local-env/host/ud/profiles/local-default/profile-state.db?mode=ro`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const STAMP = Date.now()
const TITLE = `U138 probe ${STAMP}`

function dbState(wt) {
  const out = execFileSync(
    'sqlite3',
    [
      DB,
      "select payload||'||'||updated_at||'||'||revision from profile_state_documents where domain='workspaceSession';"
    ],
    { encoding: 'utf8' }
  )
  const idx = out.indexOf('||')
  const payload = JSON.parse(out.slice(0, idx))
  const [updatedAt, revision] = out
    .slice(idx + 2)
    .trim()
    .split('||')
  return {
    active: payload.activeTabIdByWorktree?.[wt] ?? null,
    tabs: (payload.tabsByWorktree?.[wt] ?? []).map((t) => t.id),
    updatedAt: Number(updatedAt),
    revision: Number(revision)
  }
}
const storeState = (page) =>
  page.evaluate(() => {
    const s = window.__store?.getState?.()
    const wt = s?.activeWorktreeId
    return {
      wt,
      active: s?.activeTabIdByWorktree?.[wt] ?? null,
      tabs: (s?.tabsByWorktree?.[wt] ?? []).map((t) => t.id)
    }
  })
const domActive = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="sortable-tab"]')]
      .filter((el) => el.getAttribute('data-active') === 'true')
      .map((el) => el.getAttribute('data-tab-id'))
  )
async function hostCall(page, envId, method, params) {
  return page.evaluate(
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
}

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1440, height: 900 }
})
const consolePage = await ctx.newPage()
consolePage.on('dialog', (d) => d.accept())
await consolePage.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
await consolePage.locator('#loginForm').waitFor({ state: 'visible', timeout: 30_000 })
await consolePage.fill('#username', DEV.username)
await consolePage.fill('#password', DEV.password)
await consolePage.click('#loginBtn')
await consolePage.locator('#view-app').waitFor({ state: 'visible', timeout: 30_000 })
const projects = await consolePage.evaluate(async () => {
  const token = localStorage.getItem('orca.access')
  return (
    await (await fetch('/v1/projects', { headers: { authorization: `Bearer ${token}` } })).json()
  ).projects
})
const project = projects.find((p) => p.key === 'zhangsan-demo')
const btn = consolePage.locator(`[data-orca-web="${project.id}"]`).first()
const popupP = ctx.waitForEvent('page', { timeout: 90_000 })
btn
  .waitFor({ state: 'visible', timeout: 60_000 })
  .then(() => btn.click())
  .catch(() => {})
const page = await popupP
page.setDefaultTimeout(120_000)
page.on('dialog', (d) => d.accept())
await page.waitForSelector('.app-layout', { timeout: 180_000 })
const envs = await page.evaluate(() => window.api.runtimeEnvironments.list())
const envId = envs[0]?.id
let st = null
for (let i = 0; i < 80; i++) {
  st = await storeState(page)
  if (st.wt && st.tabs.length > 0) break
  await sleep(500)
}
const wt = st.wt
const wtId = `id:${wt}`
const db0 = dbState(wt)
console.log(
  'ENV',
  envId,
  'WT',
  wt,
  'DB0',
  JSON.stringify({ active: db0.active, tabs: db0.tabs, rev: db0.revision })
)

const t0 = Date.now()
const sample = async (label) => {
  const host = await hostCall(page, envId, 'session.tabs.list', { worktree: wtId })
  const db = dbState(wt)
  const dom = await domActive(page)
  const store = await storeState(page)
  const row = {
    t: ((Date.now() - t0) / 1000).toFixed(1) + 's',
    label,
    hostActive: host.ok ? host.result.activeTabId : host.error,
    hostTabs: host.ok
      ? host.result.tabs.map((t) => `${String(t.parentTabId).slice(0, 8)}${t.isActive ? '*' : ''}`)
      : null,
    dbActive: db.active ? String(db.active).slice(0, 8) : null,
    dbRev: db.revision,
    dbTabs: db.tabs.map((x) => String(x).slice(0, 8)),
    dom: dom.map((x) => String(x).replace('web-terminal-', '').slice(0, 8)),
    store: store.active ? String(store.active).replace('web-terminal-', '').slice(0, 8) : null
  }
  console.log(JSON.stringify(row))
  return row
}
await sample('baseline')

// Create one terminal: host's create-time focused write is the precondition's "wrong" durable tab.
const created = await hostCall(page, envId, 'terminal.create', {
  worktree: wtId,
  title: TITLE,
  tabId: `u138-tab-${STAMP}`,
  leafId: `u138-leaf-${STAMP}`
})
console.log('CREATE', JSON.stringify(created).slice(0, 160))
await sleep(1500)
const createRow = await sample('post-create')

const list = await hostCall(page, envId, 'session.tabs.list', { worktree: wtId })
const createdParent = created.ok ? created.result.terminal.tabId : null
const others = list.result.tabs.filter((t) => t.parentTabId !== createdParent)
const target = others[0]
console.log(
  'CREATED_PARENT',
  createdParent,
  'ACTIVATE_TARGET',
  target?.parentTabId,
  'surface',
  target?.id
)
await hostCall(page, envId, 'session.tabs.activate', { worktree: wtId, tabId: target.id })
await sleep(1000)
const actRow = await sample('post-activate')
await sleep(3000)
await sample('post-activate+4s')

await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForSelector('.app-layout', { timeout: 180_000 })
await sleep(800)
await sample('f5+0.8s')
await sleep(1700)
await sample('f5+2.5s')
await sleep(3000)
await sample('f5+5.5s')
await sleep(5000)
await sample('f5+10.5s')
await sleep(10000)
await sample('f5+20.5s')
console.log(
  'SUMMARY',
  JSON.stringify({
    createdParent,
    activated: target?.parentTabId,
    createPersisted: createRow.dbActive === createdParent,
    activatePersisted: actRow.dbActive === target?.parentTabId,
    dbBefore: db0.active,
    dbAfter: dbState(wt).active
  })
)
await browser.close()
