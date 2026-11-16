import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { evidenceDir, spawnService, type Service } from './harness.ts'

/**
 * U80 M8: global shapes and the mobile workspace deep-link guard. Real Chrome
 * proves ≤700px direct links/refresh to #/workspace/<id> keep the URL but never
 * mount the embedded overlay, and that toast/banner/empty/error/guard pages stay
 * readable. 768/1280 keep the desktop overlay byte for byte.
 */

const ADMIN = ['admin', 'Adm1n!'] as const
const DEVELOPER = ['zhangsan', 'Passw0rd!'] as const
const PROJECT_ID = 'proj_payment'
const PROJECT_NAME = 'payment-service'
const BANNER = '移动端工作区请打开 Orca Web 工作区（自带移动端支持）'
const TOAST = '请在 Orca Web 工作区打开（自带移动端支持）'
const EV = 'u80-mobile'

let service: Service
let browser: Browser

before(async () => {
  service = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN: 'u80-mobile-global-internal', ORCA_CLOUD_HOST_OFFLINE_MS: '600000' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-u80-mobile-global'
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
  hash = '#/workbench',
  ready = '#content .page-head'
): Promise<Page> {
  const context = await browser.newContext({ viewport })
  const page = await context.newPage()
  await page.goto(`${service.url}/${hash}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#loginForm', { state: 'visible' })
  await page.fill('#username', username)
  await page.fill('#password', password)
  await page.click('#loginBtn')
  await page.waitForSelector('#view-app:not([hidden])')
  await page.waitForSelector(ready)
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

/** Every visible page primitive must sit inside the viewport. */
async function rightmostOverflow(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const limit = document.documentElement.clientWidth
    return [...document.querySelectorAll(sel)].reduce(
      (max, el) => Math.max(max, el.getBoundingClientRect().right - limit),
      0
    )
  }, selector)
}

async function assertNoOverlay(page: Page): Promise<void> {
  assert.equal(await page.locator('#workspaceOverlay').count(), 0)
  assert.equal(await page.locator('.workspace-overlay').count(), 0)
  assert.equal(await page.locator('.workspace-frame').count(), 0)
}

async function buttonHeight(page: Page, selector: string): Promise<number> {
  return page.locator(selector).evaluate((el) => el.getBoundingClientRect().height)
}

test('390×844：深链 #/workspace/<id> 显示占位，不挂覆盖层、hash 保持', async () => {
  const page = await signIn({ width: 390, height: 844 }, DEVELOPER, `#/workspace/${PROJECT_ID}`, '#mobileWorkspaceBack')
  try {
    const text = await page.locator('#content').innerText()
    assert.match(text, new RegExp(BANNER))
    assert.match(text, new RegExp(PROJECT_NAME))
    await assertNoOverlay(page)
    assert.equal(await currentHash(page), `#/workspace/${PROJECT_ID}`, 'deep link keeps its URL')
    assert.ok((await horizontalOverflow(page)) <= 1, 'guard page must not overflow horizontally')
    assert.ok((await buttonHeight(page, '#mobileWorkspaceBack')) >= 44, 'back button is a 44px target')
    await page.screenshot({
      path: join(evidenceDir(EV), '390x844-workspace-deeplink-guard.png'),
      fullPage: true
    })

    await page.click('#mobileWorkspaceBack')
    await page.waitForSelector('#projectList .project-list-card')
    assert.equal(await currentHash(page), '#/projects')
  } finally {
    await page.context().close()
  }
})

test('390×844：刷新深链仍显示占位，不恢复内嵌覆盖层', async () => {
  const page = await signIn({ width: 390, height: 844 }, DEVELOPER, `#/workspace/${PROJECT_ID}`, '#mobileWorkspaceBack')
  try {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('#mobileWorkspaceBack')
    assert.match(await page.locator('#content').innerText(), new RegExp(BANNER))
    await assertNoOverlay(page)
    assert.equal(await currentHash(page), `#/workspace/${PROJECT_ID}`)
    assert.ok((await horizontalOverflow(page)) <= 1)
    await page.screenshot({
      path: join(evidenceDir(EV), '390x844-workspace-deeplink-refresh.png'),
      fullPage: true
    })
  } finally {
    await page.context().close()
  }
})

test('390×844：toast 整宽换行、不越界且不遮挡底栏', async () => {
  const page = await signIn({ width: 390, height: 844 }, DEVELOPER, '#/projects')
  try {
    await page.locator('.project-list-card [data-open]').first().click()
    await page.waitForSelector('.toast')
    const toast = page.locator('.toast')
    assert.equal(await toast.innerText(), TOAST)
    const box = await toast.boundingBox()
    assert.ok(box, 'toast must be laid out')
    assert.ok(box.width <= 390 && box.x >= 0, `toast stays inside the phone width, got ${JSON.stringify(box)}`)
    assert.ok((await rightmostOverflow(page, '.toast')) <= 1)
    const tabbar = await page.locator('#tabbar').boundingBox()
    if (tabbar) {
      assert.ok(box.y + box.height <= tabbar.y + 1, 'toast sits above the bottom tabbar')
    }
    await assertNoOverlay(page)
    assert.equal(await currentHash(page), '#/projects')
    await page.screenshot({ path: join(evidenceDir(EV), '390x844-global-toast.png') })
  } finally {
    await page.context().close()
  }
})

test('390×844：工作台横幅与项目空态可读、无横向溢出', async () => {
  const page = await signIn({ width: 390, height: 844 }, ADMIN)
  try {
    const tip = page.locator('#workspaceTip')
    assert.match(await tip.innerText(), new RegExp(BANNER))
    const tipBox = await tip.boundingBox()
    assert.ok(tipBox && tipBox.width <= 390, 'banner fits the phone width')
    assert.ok((await rightmostOverflow(page, '#workspaceTip')) <= 1)
    assert.ok((await buttonHeight(page, '#workspaceTipClose')) >= 44)

    await page.click('#tabbar [data-route="projects"]')
    await page.waitForSelector('#projectChips')
    await page.click('#projectChips .chip[data-project-filter="offline"]')
    await page.waitForFunction(
      () => document.querySelectorAll('.project-list-card').length === 0
    )
    const empty = page.locator('#projectList .card')
    assert.equal(await empty.innerText(), '没有匹配的项目')
    assert.ok((await rightmostOverflow(page, '#projectList .card')) <= 1)
    assert.ok((await horizontalOverflow(page)) <= 1)
    await page.screenshot({ path: join(evidenceDir(EV), '390x844-global-banner-empty.png') })
  } finally {
    await page.context().close()
  }
})

test('390×844：404 与 403 守卫页同桌面 schema、按钮 44px、hash 保留', async () => {
  const notFound = await signIn(
    { width: 390, height: 844 },
    DEVELOPER,
    '#/workspace/proj_missing',
    '#backToParent'
  )
  try {
    assert.equal(await notFound.locator('.forbidden h1').innerText(), '页面不存在')
    assert.match(await notFound.locator('.forbidden').innerText(), /不存在或当前账号不可见/)
    assert.equal(await currentHash(notFound), '#/workspace/proj_missing')
    assert.ok((await buttonHeight(notFound, '#backToParent')) >= 44)
    assert.ok((await rightmostOverflow(notFound, '.forbidden .box')) <= 1)
    assert.ok((await horizontalOverflow(notFound)) <= 1)
    await notFound.screenshot({ path: join(evidenceDir(EV), '390x844-global-404.png') })
  } finally {
    await notFound.context().close()
  }

  const forbidden = await signIn(
    { width: 390, height: 844 },
    DEVELOPER,
    '#/hosts',
    '#backToWorkbench'
  )
  try {
    assert.equal(await forbidden.locator('.forbidden h1').innerText(), '无权访问')
    assert.match(await forbidden.locator('.forbidden').innerText(), /没有平台管理权限/)
    assert.equal(await currentHash(forbidden), '#/hosts')
    assert.ok((await buttonHeight(forbidden, '#backToWorkbench')) >= 44)
    assert.ok((await rightmostOverflow(forbidden, '.forbidden .box')) <= 1)
    assert.ok((await horizontalOverflow(forbidden)) <= 1)
    await forbidden.screenshot({ path: join(evidenceDir(EV), '390x844-global-403.png') })
  } finally {
    await forbidden.context().close()
  }
})

test('390×844：加载失败错误态可读，重试 44px 且能恢复列表', async () => {
  const page = await signIn({ width: 390, height: 844 }, ADMIN)
  try {
    await page.route('**/v1/projects', (route) => route.abort())
    await page.evaluate(() => {
      location.hash = '#/projects'
    })
    await page.waitForSelector('#retryContent')
    assert.equal(await page.locator('#content .forbidden h1').innerText(), '加载失败')
    assert.ok((await buttonHeight(page, '#retryContent')) >= 44)
    assert.ok((await rightmostOverflow(page, '.forbidden .box')) <= 1)
    assert.ok((await horizontalOverflow(page)) <= 1)
    await page.screenshot({ path: join(evidenceDir(EV), '390x844-global-load-error.png') })

    await page.unroute('**/v1/projects')
    await page.click('#retryContent')
    await page.waitForSelector('#projectList .project-list-card')
    assert.ok((await horizontalOverflow(page)) <= 1)
  } finally {
    await page.context().close()
  }
})

test('768/1280：工作区深链仍挂载桌面覆盖层（M8 桌面零回归）', async () => {
  for (const viewport of [
    { width: 768, height: 1024 },
    { width: 1280, height: 800 }
  ]) {
    const page = await signIn(viewport, DEVELOPER, `#/workspace/${PROJECT_ID}`, '#workspaceOverlay')
    try {
      assert.equal(await page.locator('#workspaceOverlay').count(), 1)
      assert.equal(await page.locator('.workspace-frame').count(), 1, 'desktop keeps the iframe')
      assert.equal(await page.locator('#mobileWorkspaceBack').count(), 0, 'no mobile guard above 700px')
      assert.equal(await currentHash(page), `#/workspace/${PROJECT_ID}`)
      await page.screenshot({
        path: join(evidenceDir(EV), `${viewport.width}x${viewport.height}-workspace-overlay.png`)
      })
    } finally {
      await page.context().close()
    }
  }
})
