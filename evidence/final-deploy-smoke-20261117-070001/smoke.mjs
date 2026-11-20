/**
 * Post-deploy headless smoke: platform console login -> Orca Web workspace ->
 * new terminal echo -> reload restore. Hidden chromium only.
 */
import { chromium } from 'playwright'
import { writeFileSync } from 'node:fs'
import path from 'node:path'

const TS = process.env.SMOKE_TS ?? String(Date.now())
const OUT = process.env.SMOKE_OUT ?? path.join(import.meta.dirname, 'smoke-result.json')
const PLATFORM = 'https://127.0.0.1:18787'
const PROJECT_KEY = 'zhangsan-demo'
const MARKER = `PROD-FINAL-${TS}`
const result = { marker: MARKER, steps: {}, errors: [] }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function step(name, data) {
  result.steps[name] = { at: new Date().toISOString(), ...data }
}

async function dismissOnboarding(page) {
  for (let i = 0; i < 6; i += 1) {
    const open = await page.evaluate(
      () =>
        !!document.querySelector('[data-slot="dialog-content"]') ||
        /Jump to a worktree with|Got it/i.test(document.body.innerText || '')
    )
    if (!open) return
    await page.keyboard.press('Escape').catch(() => {})
    await page
      .getByRole('button', { name: /Got it|Close|知道了|完成/i })
      .first()
      .click({ timeout: 1500, force: true })
      .catch(() => {})
    await sleep(400)
  }
}

async function workspaceReady(page, timeout = 90_000) {
  await page.waitForSelector('.app-layout', { timeout })
  await dismissOnboarding(page)
  const deadline = Date.now() + timeout
  let last = null
  while (Date.now() < deadline) {
    last = await page.evaluate(() => {
      const state = window.__store?.getState?.()
      return {
        worktreeId: state?.activeWorktreeId ?? null,
        tabs: [...document.querySelectorAll('[data-tab-id]')].map((el) =>
          el.getAttribute('data-tab-id')
        )
      }
    })
    if (last.tabs.length > 0) return last
    await sleep(500)
  }
  throw new Error(`workspace not ready: ${JSON.stringify(last)}`)
}

async function terminalText(page) {
  return page.evaluate(() => {
    const wrappers = [...document.querySelectorAll('.xterm')].filter((el) => el.offsetParent)
    const wrapper = wrappers[wrappers.length - 1] ?? null
    if (!wrapper) return ''
    return [...wrapper.querySelectorAll('.xterm-rows > div')].map((r) => r.textContent ?? '').join('\n')
  })
}

async function focusTerminal(page) {
  return page.evaluate(() => {
    const areas = [...document.querySelectorAll('.xterm-helper-textarea')].filter(
      (el) => el.offsetParent
    )
    const area = areas[areas.length - 1]
    if (!area) return false
    area.focus()
    return true
  })
}

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } })
try {
  const consolePage = await context.newPage()
  await consolePage.goto(`${PLATFORM}/#/projects`, { waitUntil: 'domcontentloaded' })
  const loginVisible = await consolePage
    .waitForSelector('#loginForm', { state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false)
  if (loginVisible) {
    await consolePage.fill('#username', 'zhangsan')
    await consolePage.fill('#password', 'Passw0rd!')
    await consolePage.click('#loginBtn')
    step('login', { submitted: true })
  } else {
    step('login', { submitted: false, existingSession: true })
  }
  await consolePage.waitForFunction(
    () => document.querySelectorAll('#projectBody tr').length > 0,
    undefined,
    { timeout: 30_000 }
  )
  const row = consolePage.locator('#projectBody tr').filter({ hasText: PROJECT_KEY }).first()
  if (!(await row.count())) throw new Error(`project row ${PROJECT_KEY} missing`)
  const entry = row.locator('button[data-orca-web]').first()
  if (!(await entry.count())) throw new Error(`no Orca Web entry for ${PROJECT_KEY}`)
  const popupPromise = consolePage.waitForEvent('popup', { timeout: 30_000 })
  await entry.click()
  const ws = await popupPromise
  await ws.waitForLoadState('domcontentloaded').catch(() => {})
  const before = await workspaceReady(ws)
  step('workspace', { worktreeId: before.worktreeId, tabs: before.tabs })

  // New terminal. Prefer the tab-strip "+"; the web strip may omit it, so fall
  // back to the same runtime RPC the web client uses (terminal.* is cloud-allowed).
  const countBefore = before.tabs.length
  const newTab = ws.getByRole('button', { name: 'New tab' })
  let created = []
  if (await newTab.isVisible().catch(() => false)) {
    await newTab.click({ timeout: 5_000 })
    await ws.getByRole('menuitem', { name: /New Terminal/ }).first().click({ timeout: 15_000 })
    const deadline = Date.now() + 30_000
    let after = before.tabs
    while (Date.now() < deadline) {
      after = await ws.evaluate(() =>
        [...document.querySelectorAll('[data-tab-id]')].map((el) => el.getAttribute('data-tab-id'))
      )
      if (after.length > countBefore) break
      await sleep(400)
    }
    created = after.filter((id) => !before.tabs.includes(id))
    step('new-terminal', { path: 'tab-strip', countBefore, countAfter: after.length, created })
  } else {
    const rpcResult = await ws.evaluate(async ({ marker }) => {
      const api = window.api
      const envs = await api.runtimeEnvironments.list()
      const env = envs.find((e) => e.name === 'zhangsan-demo') ?? envs[0]
      const call = (method, params) =>
        api.runtimeEnvironments.call({ selector: env.id, method, params, timeoutMs: 20_000 })
      const nodes = [...document.querySelectorAll('[data-worktree-id]')]
      const active =
        nodes.find((el) => /(^|\s)Active/.test(el.textContent || '')) ??
        nodes.find((el) => (el.getAttribute('data-worktree-id') || '').includes('.orca-worktrees')) ??
        nodes[0]
      const worktree = active?.getAttribute('data-worktree-id') ?? null
      const createdRes = await call('terminal.create', {
        worktree,
        clientMutationId: `final-smoke-${marker}`
      })
      const terminal = createdRes?.result?.terminal ?? createdRes?.terminal ?? createdRes?.result
      const handle =
        typeof terminal === 'string'
          ? terminal
          : (terminal?.handle ??
            createdRes?.result?.handle ??
            createdRes?.handle ??
            null)
      const send = handle
        ? await call('terminal.send', { terminal: handle, text: `echo ${marker}`, enter: true })
        : null
      await new Promise((r) => setTimeout(r, 2500))
      const read = handle ? await call('terminal.read', { terminal: handle }) : null
      return { envId: env.id, worktree, createdRes, handle, tabId: terminal?.tabId ?? null, send, read }
    }, { marker: MARKER })
    created = [rpcResult.tabId || rpcResult.handle].filter(Boolean)
    step('new-terminal', { path: 'runtime-rpc', countBefore, created, rpc: rpcResult })
  }

  await sleep(1500)
  const focused = await focusTerminal(ws)
  if (!focused || created.length === 0) {
    await ws.keyboard.insertText(`echo ${MARKER}`).catch(() => {})
    await ws.keyboard.press('Enter').catch(() => {})
  } else {
    await ws.keyboard.insertText(`echo ${MARKER}`).catch(() => {})
    await ws.keyboard.press('Enter').catch(() => {})
  }
  await sleep(3000)
  let text = await terminalText(ws)
  if (!text.includes(MARKER)) {
    await ws.waitForTimeout(1000)
    text = await terminalText(ws)
  }
  const rpc = result.steps['new-terminal'].rpc ?? {}
  const readTail = rpc.read?.result?.terminal?.tail
  const readText = JSON.stringify(rpc.read?.result ?? rpc.read ?? '')
  const markerHits = readText.split(MARKER).length - 1
  const echoed = text.split('\n').filter((line) => line.includes(MARKER))
  const outputLine = Array.isArray(readTail)
    ? readTail.some((line) => String(line).trim() === MARKER)
    : false
  step('echo', {
    focused,
    marker: MARKER,
    matchedLines: echoed,
    rpcReadOk: rpc.read?.ok === true,
    rpcMarkerHits: markerHits,
    outputLine,
    pass: (rpc.read?.ok === true && outputLine) || echoed.length >= 2,
    rpcReadTail: readText.slice(-600),
    tail: text.slice(-800)
  })

  // U166: reload restores the workspace.
  await ws.reload({ waitUntil: 'domcontentloaded' })
  const restored = await workspaceReady(ws)
  const createdRestored =
    created.length === 0 ||
    created.some((id) =>
      restored.tabs.some((tabId) => tabId === id || tabId.endsWith(`-${id}`))
    )
  step('refresh-restore', {
    worktreeId: restored.worktreeId,
    tabs: restored.tabs,
    count: restored.tabs.length,
    createdRestored,
    pass: restored.tabs.length >= countBefore && createdRestored
  })
} catch (error) {
  result.errors.push(error instanceof Error ? `${error.message}\n${error.stack}` : String(error))
} finally {
  await browser.close().catch(() => {})
  writeFileSync(OUT, JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
}
