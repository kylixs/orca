/**
 * Final unified-build web smoke: relay form sign-in (default project) ->
 * workspace -> reload restore. Hidden chromium; console/pageerror counted.
 */
import { chromium } from 'playwright'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import https from 'node:https'
import path from 'node:path'

const OUT = import.meta.dirname
const RELAY =
  process.env.SMOKE_RELAY_URL ??
  'https://100.67.197.59:18444/h/dev-local-02/web-index.html'
const PLATFORM = process.env.SMOKE_PLATFORM ?? 'https://127.0.0.1:18787'
const OUT_WEB_INDEX = path.resolve('out/web/web-index.html')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const result = { relay: RELAY, platform: PLATFORM, steps: {}, consoleErrors: [], pageErrors: [] }

const sha = (buf) => createHash('sha256').update(buf).digest('hex')

async function fetchBytes(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { rejectUnauthorized: false }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }))
      })
      .on('error', reject)
  })
}

async function servedSha() {
  let res
  try {
    res = await fetchBytes(RELAY)
  } catch {
    return { ok: false, status: 0 }
  }
  const disk = readFileSync(OUT_WEB_INDEX)
  return {
    ok: res.status === 200,
    status: res.status,
    served: sha(res.body),
    disk: sha(disk),
    match: sha(res.body) === sha(disk),
    size: res.body.length
  }
}

async function dismissOnboarding(page) {
  for (let i = 0; i < 8; i += 1) {
    const open = await page.evaluate(
      () =>
        !!document.querySelector('[data-slot="dialog-content"]') ||
        /Jump to a worktree with|Got it|Skip/i.test(document.body.innerText || '')
    )
    if (!open) return
    await page.keyboard.press('Escape').catch(() => {})
    await page
      .getByRole('button', { name: /Got it|Close|Skip|知道了|完成|开始/i })
      .first()
      .click({ timeout: 1500, force: true })
      .catch(() => {})
    await sleep(400)
  }
}

async function workspaceState(page) {
  return page.evaluate(() => ({
    appLayout: !!document.querySelector('.app-layout'),
    loginForm: !!document.querySelector('#web-cloud-username'),
    tabs: [...document.querySelectorAll('[data-tab-id]')].map((el) =>
      el.getAttribute('data-tab-id')
    ),
    worktreeNodes: [...document.querySelectorAll('[data-worktree-id]')].length,
    text: (document.body.innerText || '').slice(0, 240)
  }))
}

async function waitWorkspace(page, timeout = 120_000) {
  const deadline = Date.now() + timeout
  let last = null
  while (Date.now() < deadline) {
    await dismissOnboarding(page)
    last = await workspaceState(page)
    if (last.appLayout && last.tabs.length > 0) return last
    await sleep(500)
  }
  throw new Error(`workspace not ready: ${JSON.stringify(last)}`)
}

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1440, height: 900 }
})
const page = await context.newPage()
page.on('console', (m) => {
  if (m.type() === 'error') result.consoleErrors.push(m.text())
})
page.on('pageerror', (e) => result.pageErrors.push(`${e.message}`))

try {
  const served = await servedSha()
  result.steps['served-sha'] = served

  await page.goto(RELAY, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#web-cloud-username', { timeout: 30_000 })
  const apiValue = await page.inputValue('#web-cloud-api-url').catch(() => '')
  if (!apiValue.trim()) await page.fill('#web-cloud-api-url', PLATFORM)
  await page.fill('#web-cloud-username', 'zhangsan')
  await page.fill('#web-cloud-password', 'Passw0rd!')
  result.steps.login = { submitted: true, apiUrl: apiValue.trim() || PLATFORM }
  await page.getByRole('button', { name: /Sign in and connect|登录并连接/i }).click()

  const before = await waitWorkspace(page)
  result.steps.workspace = {
    appLayout: before.appLayout,
    tabCount: before.tabs.length,
    tabs: before.tabs,
    worktreeNodes: before.worktreeNodes,
    url: page.url()
  }
  await page.screenshot({ path: path.join(OUT, 'workspace.png') })

  await page.reload({ waitUntil: 'domcontentloaded' })
  const restored = await waitWorkspace(page)
  result.steps['refresh-restore'] = {
    appLayout: restored.appLayout,
    loginForm: restored.loginForm,
    tabCount: restored.tabs.length,
    tabs: restored.tabs,
    worktreeNodes: restored.worktreeNodes,
    url: page.url(),
    pass:
      restored.appLayout &&
      !restored.loginForm &&
      restored.tabs.length >= before.tabs.length &&
      before.tabs.every((id) => restored.tabs.includes(id))
  }
  await page.screenshot({ path: path.join(OUT, 'restored.png') })
} catch (error) {
  result.failure = error instanceof Error ? `${error.message}\n${error.stack}` : String(error)
} finally {
  await browser.close().catch(() => {})
  result.consoleErrorCount = result.consoleErrors.length
  result.pageErrorCount = result.pageErrors.length
  writeFileSync(path.join(OUT, 'smoke-result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
  if (result.failure) process.exitCode = 1
}
