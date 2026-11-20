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
  await ws.keyboard.press('Escape').catch(() => {})
  const buttons = await ws.evaluate(() => [...document.querySelectorAll('button, [role="button"]')].map((el) => ({
    text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
    aria: el.getAttribute('aria-label'), title: el.getAttribute('title'),
    slot: el.getAttribute('data-slot'), visible: !!(el.offsetParent || el.getClientRects().length),
    cls: (el.className || '').toString().slice(0, 80)
  })).filter((x) => x.visible))
  console.log(JSON.stringify({ buttons }, null, 2))
} finally { await b.close() }
