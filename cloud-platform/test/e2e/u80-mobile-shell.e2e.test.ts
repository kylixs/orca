import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { evidenceDir, spawnService, type Service } from './harness.ts'

/**
 * U80 M1: the responsive shell base. Real Chrome at phone/tablet/desktop widths
 * proves the bottom tabbar exists only below 700px, navigates the same routes as
 * the desktop sidebar, and never introduces horizontal overflow.
 */

const ADMIN = ['admin', 'Adm1n!'] as const
const DEVELOPER = ['zhangsan', 'Passw0rd!'] as const
const EV = 'u80-mobile'

let service: Service
let browser: Browser

before(async () => {
  service = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN: 'u80-mobile-internal' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-u80-mobile'
  )
  browser = await chromium.launch({ channel: 'chrome', headless: true })
}, 180_000)

after(async () => {
  await browser?.close()
  await service?.stop()
})

async function signIn(
  viewport: { width: number; height: number },
  [username, password]: readonly [string, string],
  hash = '#/workbench'
): Promise<Page> {
  const context = await browser.newContext({ viewport })
  const page = await context.newPage()
  await page.goto(`${service.url}/${hash}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#loginForm', { state: 'visible' })
  await page.fill('#username', username)
  await page.fill('#password', password)
  await page.click('#loginBtn')
  await page.waitForSelector('#view-app:not([hidden])')
  await page.waitForSelector('#content .page-head')
  return page
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  )
}

async function currentHash(page: Page): Promise<string> {
  return page.evaluate(() => location.hash)
}

async function isActive(page: Page, selector: string): Promise<boolean> {
  return page.locator(selector).evaluate((el) => el.classList.contains('active'))
}

test('390×844：底栏四项可点、导航生效、无横向溢出', async () => {
  const page = await signIn({ width: 390, height: 844 }, ADMIN)
  try {
    assert.equal(await page.locator('#tabbar').isVisible(), true)
    assert.equal(await page.locator('.sidebar').isVisible(), false)
    assert.deepEqual(await page.locator('#tabbar .tabitem span').allInnerTexts(), [
      '工作台',
      '项目',
      '审计',
      '更多'
    ])
    assert.equal(await isActive(page, '#tabbar .tabitem[data-route="workbench"]'), true)

    await page.click('#tabbar .tabitem[data-route="projects"]')
    await page.waitForFunction(() => location.hash === '#/projects')
    assert.equal(await page.locator('#crumbs').innerText(), '我的项目')
    assert.equal(await isActive(page, '#tabbar .tabitem[data-route="projects"]'), true)

    await page.click('#tabbar .tabitem[data-route="audit"]')
    await page.waitForFunction(() => location.hash === '#/audit')
    assert.equal(await page.locator('#crumbs').innerText(), '审计日志')
    assert.equal(await isActive(page, '#tabbar #tabAudit'), true)

    await page.click('#tabMore')
    await page.waitForSelector('#moreSheet:not([hidden])')
    assert.equal(await page.locator('#tabMore').getAttribute('aria-expanded'), 'true')
    const moreItems = page.locator('#moreNav .more-item')
    assert.deepEqual(await moreItems.allInnerTexts(), ['主机', '中继', '用户管理', '平台设置'])
    assert.equal(await moreItems.first().isVisible(), true)

    await page.click('#moreNav .more-item[data-route="hosts"]')
    await page.waitForFunction(() => location.hash === '#/hosts')
    assert.equal(await page.locator('#crumbs').innerText(), '平台设置 / 主机')
    assert.equal(await page.locator('#moreSheet').isVisible(), false)
    assert.equal(await isActive(page, '#tabMore'), true)

    assert.ok((await horizontalOverflow(page)) <= 1, '390px must not overflow horizontally')
    await page.screenshot({ path: join(evidenceDir(EV), '390x844-shell.png') })
    assert.equal(await currentHash(page), '#/hosts')
  } finally {
    await page.context().close()
  }
})

test('768×1024：底栏隐藏、侧栏可见、内容双列', async () => {
  const page = await signIn({ width: 768, height: 1024 }, ADMIN)
  try {
    assert.equal(await page.locator('#tabbar').isVisible(), false)
    assert.equal(await page.locator('.sidebar').isVisible(), true)
    const columns = await page
      .locator('#content .grid-3')
      .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length)
    assert.equal(columns, 2)
    assert.ok((await horizontalOverflow(page)) <= 1, '768px must not overflow horizontally')
    await page.screenshot({ path: join(evidenceDir(EV), '768x1024-shell.png') })
  } finally {
    await page.context().close()
  }
})

test('1280×800：底栏隐藏、侧栏导航可点（桌面零回归）', async () => {
  const page = await signIn({ width: 1280, height: 800 }, ADMIN)
  try {
    assert.equal(await page.locator('#tabbar').isVisible(), false)
    assert.equal(await page.locator('#moreSheet').isVisible(), false)
    assert.equal(await page.locator('.sidebar').isVisible(), true)
    await page.click('.sidebar .nav-item[data-route="projects"]')
    await page.waitForFunction(() => location.hash === '#/projects')
    assert.equal(await page.locator('#crumbs').innerText(), '我的项目')
    assert.equal(await isActive(page, '.sidebar .nav-item[data-route="projects"]'), true)
    assert.ok((await horizontalOverflow(page)) <= 1, '1280px must not overflow horizontally')
    await page.screenshot({ path: join(evidenceDir(EV), '1280x800-shell.png') })
  } finally {
    await page.context().close()
  }
})

test('390×844：开发者无审计入口，「更多」仅保留账号与退出', async () => {
  const page = await signIn({ width: 390, height: 844 }, DEVELOPER)
  try {
    const visibleTabs = await page.locator('#tabbar .tabitem:visible').count()
    assert.equal(visibleTabs, 3)
    assert.equal(await page.locator('#tabAudit').isVisible(), false)
    await page.click('#tabMore')
    await page.waitForSelector('#moreSheet:not([hidden])')
    assert.equal(await page.locator('#moreNav .more-item:visible').count(), 0)
    assert.equal(await page.locator('#moreLogout').isVisible(), true)
    assert.match(await page.locator('#moreAccount').innerText(), /开发者/)
    assert.ok((await horizontalOverflow(page)) <= 1, 'developer shell must not overflow')
  } finally {
    await page.context().close()
  }
})
