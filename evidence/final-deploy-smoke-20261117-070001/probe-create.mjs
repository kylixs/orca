import { chromium } from 'playwright'
const b = await chromium.launch({ headless: true })
const c = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } })
try {
  const p = await c.newPage()
  await p.goto('https://127.0.0.1:18787/#/projects', { waitUntil: 'domcontentloaded' })
  if (await p.locator('#loginForm').isVisible().catch(() => false)) {
    await p.fill('#username', 'zhangsan'); await p.fill('#password', 'Passw0rd!'); await p.click('#loginBtn')
  }
  await p.waitForFunction(() => document.querySelectorAll('#projectBody tr').length > 0)
  const row = p.locator('#projectBody tr').filter({ hasText: 'zhangsan-demo' }).first()
  const popupP = p.waitForEvent('popup', { timeout: 30000 })
  await row.locator('button[data-orca-web]').first().click()
  const ws = await popupP
  await ws.waitForSelector('.app-layout', { timeout: 60000 })
  await ws.waitForTimeout(3000)
  const res = await ws.evaluate(async () => {
    const envs = await window.api.runtimeEnvironments.list()
    const env = envs.find((e) => e.name === 'zhangsan-demo') ?? envs[0]
    const worktree = document.querySelector('[data-worktree-id]')?.getAttribute('data-worktree-id')
    const create = await window.api.runtimeEnvironments.call({
      selector: env.id, method: 'terminal.create',
      params: { worktree, clientMutationId: 'probe-final' }, timeoutMs: 20000
    })
    const status = await window.api.runtimeEnvironments.call({ selector: env.id, method: 'status.get', params: {}, timeoutMs: 10000 })
    const list = await window.api.runtimeEnvironments.call({ selector: env.id, method: 'terminal.list', params: { worktree }, timeoutMs: 10000 })
    return { envId: env.id, envKeys: Object.keys(env), worktree, create, status, list }
  })
  console.log(JSON.stringify(res, null, 2))
} finally { await b.close() }
