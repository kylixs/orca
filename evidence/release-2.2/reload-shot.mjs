import { chromium } from 'playwright'
const BASE = 'https://127.0.0.1:18787',
  OUT = 'evidence/release-2.2'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1440, height: 900 }
})
const admin = await ctx.newPage()
admin.on('dialog', (d) => d.accept())
const out = {}
try {
  await admin.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await admin.locator('#loginForm').waitFor({ state: 'visible', timeout: 30000 })
  await admin.fill('#username', 'zhangsan')
  await admin.fill('#password', 'Passw0rd!')
  await admin.click('#loginBtn')
  await admin.locator('#view-app').waitFor({ state: 'visible', timeout: 30000 })
  const ids = await admin.evaluate(async () => {
    const t = localStorage.getItem('orca.access')
    const r = await fetch('/v1/projects', { headers: { authorization: `Bearer ${t}` } })
    return Object.fromEntries(((await r.json()).projects ?? []).map((p) => [p.name, p.id]))
  })
  const btn = admin.locator(`[data-orca-web="${ids['infra-tools']}"]`).first()
  await btn.waitFor({ state: 'visible', timeout: 30000 })
  const pp = ctx.waitForEvent('page', { timeout: 90000 })
  pp.catch(() => {})
  await btn.click()
  const p = await pp
  p.setDefaultTimeout(120000)
  p.on('dialog', (d) => d.accept())
  await p.waitForSelector('.app-layout', { timeout: 120000 })
  const dismiss = async (ms = 10000) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      const d = p.locator('[role="dialog"]').first()
      if ((await d.count()) && (await d.isVisible().catch(() => false))) {
        const c = d.locator('[data-slot="dialog-close"]').first()
        if (await c.count()) await c.click({ timeout: 3000 }).catch(() => {})
        else await p.keyboard.press('Escape')
        await sleep(700)
      } else await sleep(400)
    }
  }
  const tabInfo = () =>
    p.evaluate(() => ({
      tabs: [...document.querySelectorAll('[data-testid="sortable-tab"]')].map((e) => ({
        id: e.getAttribute('data-tab-id'),
        title: e.getAttribute('data-tab-title'),
        sel: e.getAttribute('aria-selected')
      })),
      xterm: document.querySelectorAll('.xterm').length
    }))
  await dismiss(6000)
  out.before = await tabInfo()
  const tabs = p.locator('[data-testid="sortable-tab"]')
  if ((await tabs.count()) >= 3)
    await tabs
      .nth(2)
      .click()
      .catch(() => {})
  await sleep(800)
  await p.screenshot({ path: `${OUT}/content-before-reload-clear.png` })
  const t0 = Date.now()
  await p.reload({ waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.app-layout', { timeout: 120000 })
  await dismiss(8000)
  let s = null,
    tabsMs = null
  for (const end = Date.now() + 60000; Date.now() < end;) {
    s = await tabInfo()
    if (s.tabs.length >= 3) {
      if (tabsMs === null) tabsMs = Date.now() - t0
      break
    }
    await sleep(300)
  }
  if ((await tabs.count()) >= 3)
    await tabs
      .nth(2)
      .click()
      .catch(() => {})
  await sleep(1200)
  await p.screenshot({ path: `${OUT}/content-after-reload-clear.png` })
  out.after = {
    tabsMs,
    tabCount: s?.tabs.length,
    xterm: s?.xterm,
    tabs: s?.tabs,
    dialogs: await p.locator('[role="dialog"]').count()
  }
} catch (e) {
  out.failure = String(e).slice(0, 600)
} finally {
  console.log(JSON.stringify(out, null, 2))
  await browser.close()
}
