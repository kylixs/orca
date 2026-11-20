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
  await ws.waitForTimeout(4000)
  const info = await ws.evaluate(() => {
    const api = window.api || {}
    const sidebar = [...document.querySelectorAll('[data-worktree-id], [data-testid*="worktree"], .worktree-item')].slice(0, 10).map((el) => ({
      tag: el.tagName, text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      wt: el.getAttribute('data-worktree-id'), visible: !!(el.offsetParent || el.getClientRects().length)
    }))
    const rows = [...document.querySelectorAll('a,button,div')].filter((el) => /zhangsan-demo|demo-app/i.test(el.textContent || '')).slice(0, 10).map((el) => ({
      tag: el.tagName, text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      cls: (el.className || '').toString().slice(0, 60)
    }))
    return {
      url: location.href,
      apiKeys: Object.keys(api).slice(0, 40),
      runtimeEnvs: typeof api.runtimeEnvironments?.list,
      runtimeCall: typeof api.runtime?.call,
      tabsVisible: [...document.querySelectorAll('[data-tab-id]')].map((el) => ({ id: el.getAttribute('data-tab-id'), visible: !!(el.offsetParent || el.getClientRects().length) })),
      sidebar,
      textRows: rows,
      bodyText: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 600)
    }
  })
  console.log(JSON.stringify(info, null, 2))
} finally { await b.close() }
