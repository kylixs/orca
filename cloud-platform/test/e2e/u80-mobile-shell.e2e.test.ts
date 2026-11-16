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
    const statColumns = await page
      .locator('#content .grid-4')
      .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length)
    assert.equal(statColumns, 2)
    assert.equal(await page.locator('#workspaceTip').isVisible(), false)
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
    const statColumns = await page
      .locator('#content .grid-4')
      .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length)
    assert.equal(statColumns, 4)
    assert.equal(await page.locator('#workspaceTip').isVisible(), false)
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

test('390×844：登录页单列居中、16px 输入、错误/禁用态、44px 主按钮', async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  // Delay the login response so the in-flight disabled state is observable.
  await page.route('**/v1/auth/login', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 400))
    await route.continue()
  })
  try {
    await page.goto(`${service.url}/#/workbench`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('#loginForm', { state: 'visible' })

    const box = await page.locator('.login-card').boundingBox()
    assert.ok(box, 'login card must be laid out')
    assert.ok(box.width <= 358, `card fits the 390px viewport, got ${box.width}`)
    const leftGap = box.x
    const rightGap = 390 - box.x - box.width
    assert.ok(Math.abs(leftGap - rightGap) <= 2, 'card stays horizontally centered')
    assert.equal(
      await page.locator('#username').evaluate((el) => getComputedStyle(el).fontSize),
      '16px'
    )
    assert.ok(
      (await page.locator('#loginBtn').evaluate((el) => el.getBoundingClientRect().height)) >= 44,
      'primary button keeps a 44px touch target'
    )

    await page.click('#loginBtn')
    assert.equal(await page.locator('#loginError').innerText(), '请输入域账号和密码。')
    assert.equal(await page.locator('#loginError').isVisible(), true)

    await page.fill('#username', 'u80-nobody')
    await page.fill('#password', 'wrong-pass')
    await page.click('#loginBtn')
    await page.waitForFunction(() => document.querySelector('#loginBtn')?.disabled === true)
    assert.equal(await page.locator('#loginBtn').innerText(), '登录中…')
    await page.waitForFunction(() =>
      document.querySelector('#loginError')?.textContent?.includes('账号或密码错误')
    )
    assert.equal(await page.locator('#loginBtn').isEnabled(), true)
    assert.equal(await page.locator('#loginBtn').innerText(), '登录')
    assert.ok((await horizontalOverflow(page)) <= 1, 'login must not overflow horizontally')
    await page.screenshot({ path: join(evidenceDir(EV), '390x844-login.png') })
  } finally {
    await context.close()
  }
})

test('390×844：工作台统计 2×2、提示条一次可关、最近项目触控 ≥44px', async () => {
  const page = await signIn({ width: 390, height: 844 }, ADMIN)
  try {
    const statColumns = await page
      .locator('#content .grid-4')
      .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length)
    assert.equal(statColumns, 2)
    assert.equal(await page.locator('#content .grid-4 .stat').count(), 4)
    assert.deepEqual(await page.locator('#content .stat-label').allInnerTexts(), [
      '可访问项目',
      '主机在线',
      '禁用下载项目',
      '下载默认策略'
    ])
    const projectRows = await page.locator('#content tbody tr').count()
    assert.ok(projectRows > 0, 'seeded fixtures expose projects')
    assert.equal(
      Number(await page.locator('#content .stat-value').first().innerText()),
      projectRows,
      '可访问项目 stays derived from the visible project list'
    )

    const tip = page.locator('#workspaceTip')
    assert.equal(await tip.isVisible(), true)
    assert.match(await tip.innerText(), /移动端工作区请打开 Orca Web 工作区（自带移动端支持）/)
    await page.click('#workspaceTipClose')
    assert.equal(await page.locator('#workspaceTip').count(), 0)
    assert.equal(await page.evaluate(() => localStorage.getItem('orca.mobile-workspace-tip')), '1')

    const heights = await page
      .locator('#content .project-card .foot .btn')
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))
    assert.ok(heights.length > 0)
    assert.ok(
      heights.every((height) => height >= 44),
      `actions >=44px, got ${heights.join(',')}`
    )

    await page.reload()
    await page.waitForSelector('#content .grid-4')
    assert.equal(await page.locator('#workspaceTip').count(), 0, 'dismissal survives reload')
    assert.ok((await horizontalOverflow(page)) <= 1, 'workbench must not overflow horizontally')
    await page.screenshot({ path: join(evidenceDir(EV), '390x844-workbench.png') })
  } finally {
    await page.context().close()
  }
})
