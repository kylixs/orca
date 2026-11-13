import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { login, ROOT, saveEvidence, spawnService, type Service } from './harness.ts'

/**
 * M113: the acceptance runbook describes what a reviewer should see; this
 * captures it. Real platform process serving the real web build, headless
 * Chrome, one PNG per page a walkthrough touches. Output lands in the committed
 * test-reports directory so the report carries its own pictures.
 */

const SHOTS = join(
  ROOT,
  '..',
  'remote-connectivity/design/2026-11-13-cloud-dev-platform/test-reports/screenshots/web'
)

let service: Service
let browser: Browser

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true })
}

/** Signs in and waits for the shell; the caller then navigates. */
async function signInAs(username: string, password: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  await page.goto(`${service.url}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#loginForm', { state: 'visible' })
  await page.fill('#username', username)
  await page.fill('#password', password)
  await shot(page, 'web-login')
  await page.click('#loginBtn')
  await page.waitForFunction(() => {
    const app = document.querySelector('#view-app')
    return Boolean(app) && !app.hidden && document.querySelectorAll('#content table tbody tr').length > 0
  })
  return page
}

before(async () => {
  mkdirSync(SHOTS, { recursive: true })
  service = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN: 'm113-internal' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-shots'
  )
  browser = await chromium.launch({ channel: 'chrome', headless: true })
}, 180_000)

after(async () => {
  await browser?.close()
  await service?.stop()
})

test('M113-1 管理与开发者 Web 页面截图', async () => {
  // ---- developer: the workbench a normal user lands on ----
  const dev = await signInAs('zhangsan', 'Passw0rd!')
  await shot(dev, 'web-workbench-developer')
  // A developer's admin nav is hidden but present; the wired click renders the
  // refusal view — the same thing a DOM-tampering user would reach.
  await dev.evaluate(() => {
    document.querySelector<HTMLButtonElement>('button[data-route="hosts"]')?.click()
  })
  await dev.waitForSelector('.forbidden', { timeout: 5_000 })
  await shot(dev, 'web-forbidden-developer')
  await dev.context().close()

  // ---- admin: every management page ----
  const admin = await signInAs('admin', 'Adm1n!')
  for (const route of ['workbench', 'projects', 'hosts', 'members', 'audit', 'settings']) {
    await admin.click(`button[data-route="${route}"]`)
    await admin.waitForFunction(
      () => {
        const content = document.querySelector('#content')
        return content !== null && (content.textContent ?? '').includes('…') === false
      },
      undefined,
      { timeout: 10_000 }
    )
    await admin.waitForTimeout(300)
    await shot(admin, `web-admin-${route}`)
  }
  assert.notEqual((await admin.locator('#adminNav').count()), 0, 'admin must see the admin nav')
  await admin.context().close()

  saveEvidence('m113-acceptance-screenshots', 'web-shots.json', {
    dir: 'remote-connectivity/design/2026-11-13-cloud-dev-platform/test-reports/screenshots/web',
    shots: [
      'web-login',
      'web-workbench-developer',
      'web-forbidden-developer',
      'web-admin-workbench',
      'web-admin-projects',
      'web-admin-hosts',
      'web-admin-members',
      'web-admin-audit',
      'web-admin-settings'
    ]
  })
}, 180_000)
