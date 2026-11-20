import { chromium } from 'playwright'
const BASE = 'https://127.0.0.1:18788',
  PROJECT = 'proj_fd19e4ff'
const out = { console: [], failed: [], responses: [] }
const b = await chromium.launch({ headless: true })
const c = await b.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1440, height: 900 },
  permissions: ['clipboard-read', 'clipboard-write']
})
const p = await c.newPage()
p.on('console', (m) => out.console.push(m.type() + ': ' + m.text().slice(0, 300)))
p.on('requestfailed', (r) =>
  out.failed.push(r.url().slice(0, 200) + ' :: ' + r.failure()?.errorText)
)
p.on('response', (r) => {
  if (r.status() >= 400) out.responses.push(r.status() + ' ' + r.url().slice(0, 200))
})
try {
  await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await p.locator('#loginForm').waitFor({ timeout: 30000 })
  await p.fill('#username', 'admin')
  await p.fill('#password', 'Adm1n!')
  await p.click('#loginBtn')
  await p.locator('#view-app').waitFor({ timeout: 30000 })
  await p.goto(BASE + '/#/workspace/' + PROJECT, { waitUntil: 'domcontentloaded' })
  await p.locator('iframe.workspace-frame').first().waitFor({ state: 'attached', timeout: 60000 })
  await new Promise((r) => setTimeout(r, 12000))
  const f = p.frames().find((x) => x !== p.mainFrame())
  out.frameUrl = f?.url().slice(0, 300)
  out.bodyText = await f
    .evaluate(() => document.body.innerText.slice(0, 600))
    .catch((e) => String(e))
  out.testids = await f
    .evaluate(() =>
      [...document.querySelectorAll('[data-testid]')]
        .map((e) => e.getAttribute('data-testid'))
        .slice(0, 40)
    )
    .catch((e) => [String(e)])
  out.status = await p
    .locator('[data-workspace-status]')
    .innerText()
    .catch(() => null)
} catch (e) {
  out.error = String(e).slice(0, 800)
} finally {
  await b.close()
}
console.log(JSON.stringify(out, null, 2))
