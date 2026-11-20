import { chromium } from 'playwright'
import fs from 'node:fs'
const BASE = 'https://127.0.0.1:18787'
const b = await chromium.launch({ headless: true })
const c = await b.newContext({ ignoreHTTPSErrors: true })
const p = await c.newPage()
p.setDefaultTimeout(45000)
p.on('dialog', (d) => d.accept())
const out = {}
try {
  await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await p.locator('#loginForm').waitFor({ state: 'visible' })
  await p.fill('#username', 'admin')
  await p.fill('#password', 'Adm1n!')
  await p.click('#loginBtn')
  await p.locator('#view-app').waitFor({ state: 'visible' })
  const w = c.waitForEvent('page', { timeout: 60000 })
  await p.locator('tr', { hasText: 'demo' }).first().locator('[data-orca-web]').click()
  const popup = await w
  popup.setDefaultTimeout(120000)
  await popup.waitForSelector('.app-layout', { timeout: 150000 })
  out.info = await popup.evaluate(async () => {
    const r = await window.api.cloudWorkspace.info()
    return {
      ok: !!r,
      hasCapabilities: r && Object.prototype.hasOwnProperty.call(r, 'capabilities'),
      keys: r ? Object.keys(r) : null
    }
  })
  await popup.close()
} catch (e) {
  out.error = String(e).slice(0, 800)
} finally {
  fs.writeFileSync('evidence/u104/u104-info-result.json', JSON.stringify(out, null, 2))
  await b.close()
}
