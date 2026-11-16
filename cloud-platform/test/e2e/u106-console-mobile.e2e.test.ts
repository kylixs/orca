import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { chromium, type Browser, type Page } from 'playwright'
import { spawnService, type Service } from './harness.ts'

/**
 * U106-R6/T14: the 404/403 views share one schema and stay readable in a narrow
 * browser viewport. happy-dom has no layout, so this one case runs real Chrome.
 */

const ADMIN = ['admin', 'Adm1n!'] as const
const DEVELOPER = ['zhangsan', 'Passw0rd!'] as const
const VIEWPORT = { width: 390, height: 844 }

let service: Service
let browser: Browser

before(async () => {
  service = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN: 'u106-mobile-internal' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-u106-mobile'
  )
  browser = await chromium.launch({ channel: 'chrome', headless: true })
}, 180_000)

after(async () => {
  await browser?.close()
  await service?.stop()
})

/** Opens a deep link at phone width and signs in; the target hash survives login. */
async function signInAt(
  hash: string,
  [username, password]: readonly [string, string]
): Promise<Page> {
  const context = await browser.newContext({ viewport: VIEWPORT })
  const page = await context.newPage()
  await page.goto(`${service.url}/${hash}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#loginForm', { state: 'visible' })
  await page.fill('#username', username)
  await page.fill('#password', password)
  await page.click('#loginBtn')
  await page.waitForSelector('#view-app:not([hidden])')
  await page.waitForSelector('.forbidden')
  return page
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  )
}

async function assertSameViewSchema(page: Page, title: string): Promise<void> {
  assert.equal(page.viewportSize()?.width, VIEWPORT.width)
  assert.equal(await page.locator('#crumbs').innerText(), title)
  assert.equal(await page.locator('.forbidden .box h1').innerText(), title)
  assert.equal(await page.locator('.forbidden .box p').count(), 1)
  assert.equal(await page.locator('.forbidden .box button').count(), 1)
  assert.equal(await page.locator('.forbidden .box button').isVisible(), true)
}

test('R6 窄视口：404 与 403 同 schema 可读且无横向溢出', async () => {
  const notFound = await signInAt('#/members', ADMIN)
  try {
    await assertSameViewSchema(notFound, '页面不存在')
    assert.match(await notFound.locator('.forbidden .box p').innerText(), /#\/members/)
    assert.ok((await horizontalOverflow(notFound)) <= 1, '404 must not overflow at 390px')
    assert.equal(await notFound.evaluate(() => location.hash), '#/members')
  } finally {
    await notFound.context().close()
  }

  const forbidden = await signInAt('#/hosts', DEVELOPER)
  try {
    await assertSameViewSchema(forbidden, '无权访问')
    assert.match(await forbidden.locator('.forbidden .box p').innerText(), /没有平台管理权限/)
    assert.ok((await horizontalOverflow(forbidden)) <= 1, '403 must not overflow at 390px')
    assert.equal(await forbidden.evaluate(() => location.hash), '#/hosts')
  } finally {
    await forbidden.context().close()
  }
})
