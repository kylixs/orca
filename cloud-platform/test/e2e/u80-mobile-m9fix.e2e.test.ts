import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { evidenceDir, spawnService, type Service } from './harness.ts'

/**
 * U148 / M9 探索四缺陷：工作台卡片溢出、主机页签 44px、主机卡操作折叠、
 * 下线样式化确认卡。全部在真实 Chrome 390px 下断言。
 */

const ADMIN = ['admin', 'Adm1n!'] as const
const EV = 'u80-mobile'

let service: Service
let browser: Browser

before(async () => {
  service = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN: 'u148-internal' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-u148-m9fix'
  )
  browser = await chromium.launch({ channel: 'chrome', headless: true })
}, 180_000)

after(async () => {
  await browser?.close()
  await service?.stop()
})

async function signIn(hash: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  await page.goto(`${service.url}/${hash}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#loginForm', { state: 'visible' })
  await page.fill('#username', ADMIN[0])
  await page.fill('#password', ADMIN[1])
  await page.click('#loginBtn')
  await page.waitForSelector('#view-app:not([hidden])')
  await page.waitForSelector('#content .page-head')
  return page
}

function contentOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const content = document.querySelector<HTMLElement>('#content')!
    return content.scrollWidth - content.clientWidth
  })
}

async function openHostCardMenu(page: Page, hostId: string): Promise<void> {
  await page.locator(`.host-list-card[data-host-card="${hostId}"] [data-host-more]`).click()
  await page.waitForSelector('.dialog-backdrop')
}

function firstHostId(page: Page): Promise<string> {
  return page
    .locator('.host-list-card')
    .first()
    .evaluate((el) => (el as HTMLElement).dataset.hostCard ?? '')
}

test('390：工作台项目卡不横向溢出，路径单行省略，打开按钮完整可见', async () => {
  const page = await signIn('#/workbench')
  try {
    assert.ok((await contentOverflow(page)) <= 1, 'content must not scroll horizontally')
    const grid = await page
      .locator('#content .grid-3')
      .evaluate((el) => getComputedStyle(el).gridTemplateColumns)
    assert.equal(grid.split(' ').length, 1, 'phone grid is one column')
    const cards = page.locator('#content .grid-3 .project-card')
    assert.ok((await cards.count()) > 0, 'recent projects render')
    const metrics = await cards.first().evaluate((el) => {
      const box = el.getBoundingClientRect()
      return {
        width: box.width,
        right: box.right,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        pathWhiteSpace: getComputedStyle(el.querySelector('.path')!).whiteSpace
      }
    })
    assert.ok(metrics.width <= 390, `card fits 390px, got ${metrics.width}`)
    assert.ok(metrics.right <= 390, `card right edge inside viewport, got ${metrics.right}`)
    assert.ok(
      metrics.scrollWidth <= metrics.clientWidth + 1,
      `card does not scroll, got ${metrics.scrollWidth}/${metrics.clientWidth}`
    )
    assert.equal(metrics.pathWhiteSpace, 'nowrap', 'path stays on one line (ellipsis)')
    const open = await cards.first().locator('[data-open]').boundingBox()
    assert.ok(open, '打开 button must lay out')
    assert.ok(open.x + open.width <= 390, `打开 stays inside viewport, got ${open.x + open.width}`)
    await page.screenshot({ path: join(evidenceDir(EV), '390-m9fix-workbench.png') })
  } finally {
    await page.context().close()
  }
})

test('390：主机详情页签触控高度 ≥44px', async () => {
  const page = await signIn('#/hosts')
  try {
    await page.locator('.host-list-card').first().locator('[data-host]').click()
    await page.waitForSelector('.drawer')
    const heights = await page
      .locator('.drawer .detail-tab')
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))
    assert.ok(heights.length >= 2, 'info/permission tabs render')
    assert.ok(
      heights.every((height) => height >= 44),
      `detail tabs >=44px, got ${heights.join(',')}`
    )
    await page.screenshot({ path: join(evidenceDir(EV), '390-m9fix-host-detail.png') })
  } finally {
    await page.context().close()
  }
})

test('390：主机卡只留 详情+更多，更多菜单项 ≥44px，维护行为与 toast 不变', async () => {
  const page = await signIn('#/hosts')
  try {
    const hostId = await firstHostId(page)
    const card = page.locator(`.host-list-card[data-host-card="${hostId}"]`)
    const actions = card.locator('.hlc-actions .btn')
    assert.equal(await actions.count(), 2, '只有 详情 / 更多')
    assert.deepEqual(await actions.allInnerTexts(), ['详情', '更多'])

    await openHostCardMenu(page, hostId)
    const menu = page.locator('.dialog-backdrop')
    assert.equal(await menu.locator('[data-action="0"]').innerText(), '进入维护模式')
    assert.equal(await menu.locator('[data-action="1"]').innerText(), '下线主机')
    const menuHeights = await menu
      .locator('[data-action]')
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))
    assert.ok(
      menuHeights.every((height) => height >= 44),
      `menu items >=44px, got ${menuHeights.join(',')}`
    )

    const maintenancePath = `/v1/hosts/${hostId}/maintenance`
    const calls: string[] = []
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (url.pathname === maintenancePath) {
        calls.push(request.method())
      }
    })
    await menu.locator('[data-action="0"]').click()
    await page.waitForFunction(
      (id) =>
        document.querySelector(`.host-list-card[data-host-card="${id}"] .badge`)?.textContent ===
        '维护中',
      hostId
    )
    assert.deepEqual(calls, ['POST'], 'menu maintenance sends one POST')

    await page.route('**/v1/hosts/*/maintenance', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'SIMULATED_FAILURE', message: '模拟平台故障' } })
      })
    )
    await openHostCardMenu(page, hostId)
    await page.locator('.dialog-backdrop [data-action="0"]').click()
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.toast')].some((el) => el.textContent?.includes('失败'))
    )
    assert.match(
      await page.locator('.toast').last().innerText(),
      /结束维护失败：模拟平台故障/,
      'failure toast unchanged'
    )
    await page.unroute('**/v1/hosts/*/maintenance')
    await page.screenshot({ path: join(evidenceDir(EV), '390-m9fix-hosts-menu.png') })
  } finally {
    await page.context().close()
  }
})

test('390：下线用样式化确认卡，取消零 DELETE、确认一次 DELETE', async () => {
  const page = await signIn('#/hosts')
  const nativeDialogs: string[] = []
  const deletes: string[] = []
  page.on('dialog', (dialog) => {
    nativeDialogs.push(dialog.message())
    void dialog.dismiss()
  })
  page.on('request', (request) => {
    if (request.method() === 'DELETE' && new URL(request.url()).pathname.startsWith('/v1/hosts/')) {
      deletes.push(request.url())
    }
  })
  try {
    const hostId = await firstHostId(page)
    await openHostCardMenu(page, hostId)
    await page.locator('.dialog-backdrop [data-action="1"]').click()
    await page.waitForFunction(() =>
      document.querySelector('.dialog-backdrop')?.textContent?.includes('不可撤销')
    )

    const confirm = page.locator('.dialog-backdrop').last()
    const text = await confirm.innerText()
    assert.match(text, /下线后/, '确认卡说明后果')
    assert.match(text, /凭证失效/)
    assert.match(text, /不可撤销/)
    assert.equal(await confirm.locator('.foot .btn.danger').count(), 1, 'danger 确认按钮')
    assert.deepEqual(nativeDialogs, [], 'no native window.confirm')

    await confirm.locator('[data-action="0"]').click()
    await page.waitForTimeout(300)
    assert.deepEqual(deletes, [], '取消零 DELETE')
    assert.equal(
      await page.locator(`.host-list-card[data-host-card="${hostId}"]`).count(),
      1,
      '取消后主机仍在'
    )

    await openHostCardMenu(page, hostId)
    await page.locator('.dialog-backdrop [data-action="1"]').click()
    await page.waitForFunction(() =>
      document.querySelector('.dialog-backdrop')?.textContent?.includes('不可撤销')
    )
    await page.locator('.dialog-backdrop').last().locator('[data-action="1"]').click()
    await page.waitForFunction(
      (id) =>
        document.querySelector(`.host-list-card[data-host-card="${id}"] .badge`)?.textContent ===
        '已吊销',
      hostId
    )
    assert.equal(deletes.length, 1, '确认一次 DELETE')
    await page.screenshot({ path: join(evidenceDir(EV), '390-m9fix-host-confirm.png') })
  } finally {
    await page.context().close()
  }
})
