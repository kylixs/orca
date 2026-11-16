import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { evidenceDir, login, registerHost, spawnService, type Service } from './harness.ts'

/**
 * U116① W6: the mobile face of archived groups/details and the archive confirm.
 *
 * - 390px: the 已归档 chip sits in the scrolling chip row, archived cards reuse
 *   the live card shell, and only 详情 (+admin 恢复) remain
 * - the archived detail sheet is compact (no tabs) with a readable banner and a
 *   44px 恢复项目 footer
 * - the archive confirm card stays inside 390px with readable consequences
 * - 768/1280 keep the desktop table/dialog byte for byte
 */

const EV = 'u116-w6'

let service: Service
let browser: Browser
let adminToken = ''
let hostId = ''
let archivedId = ''

async function adminApi(
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${service.url}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${adminToken}`,
      ...(init.headers ?? {})
    },
    body: init.body
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

async function createProject(key: string, name: string): Promise<string> {
  const created = await adminApi('/v1/projects', {
    method: 'POST',
    body: JSON.stringify({ key, name, hostId, path: `/srv/work/${key}` })
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  return (created.body as { id: string }).id
}

async function archiveProject(id: string): Promise<void> {
  const res = await adminApi(`/v1/projects/${id}/archive`, { method: 'POST' })
  assert.equal(res.status, 200, JSON.stringify(res.body))
}

before(async () => {
  service = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN: 'u116-w6-token' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-u116-w6'
  )
  adminToken = await login(service.url, 'admin', 'Adm1n!')
  const host = await registerHost({
    apiUrl: service.url,
    adminToken,
    name: 'u116-w6-host',
    directAddr: '127.0.0.1:17119',
    relayTarget: '127.0.0.1:17119'
  })
  hostId = host.hostId
  await createProject('w6-live', 'w6-live')
  archivedId = await createProject('w6-archived', 'w6-archived')
  await archiveProject(archivedId)
  browser = await chromium.launch({ channel: 'chrome', headless: true })
}, 180_000)

after(async () => {
  await browser?.close()
  await service?.stop()
})

async function signIn(
  viewport: { width: number; height: number },
  hash = '#/projects'
): Promise<Page> {
  const context = await browser.newContext({ viewport })
  const page = await context.newPage()
  await page.goto(`${service.url}/${hash}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#loginForm', { state: 'visible' })
  await page.fill('#username', 'admin')
  await page.fill('#password', 'Adm1n!')
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

async function openArchivedView(page: Page): Promise<void> {
  await page.click('#projectChips .chip[data-project-filter="archived"]')
  await page.waitForFunction(
    () => document.querySelectorAll('.archived-group .project-list-card').length > 0
  )
}

test('W6-1 390：已归档 chip 单行横滑、归档卡复用项目卡、仅详情/恢复、44px', async () => {
  const page = await signIn({ width: 390, height: 844 })
  try {
    const chips = page.locator('#projectChips .chip')
    const texts = await chips.allInnerTexts()
    assert.deepEqual(texts, ['全部状态', '仅在线', '仅离线', '已归档 1'])
    assert.deepEqual(
      await page.locator('#projectChips').evaluate((el) => {
        const style = getComputedStyle(el)
        return { wrap: style.flexWrap, overflowX: style.overflowX }
      }),
      { wrap: 'nowrap', overflowX: 'auto' },
      'the extra 已归档 chip scrolls instead of wrapping'
    )
    const tops = await chips.evaluateAll((els) =>
      els.map((el) => Math.round(el.getBoundingClientRect().top))
    )
    assert.equal(new Set(tops).size, 1, 'all chips stay on one row')
    const chipHeights = await chips.evaluateAll((els) =>
      els.map((el) => el.getBoundingClientRect().height)
    )
    assert.ok(
      chipHeights.every((height) => height >= 44),
      `chips are touch targets, got ${chipHeights.join(',')}`
    )

    await openArchivedView(page)
    assert.equal(await page.locator('#projectTableWrap').isVisible(), false)
    assert.equal(await page.locator('#projectList').isVisible(), false)
    assert.equal(
      await page.locator('.archived-group > summary').innerText(),
      '已归档项目（1）'
    )

    const card = page.locator('.archived-group .project-list-card').first()
    assert.match(await card.getAttribute('class'), /project-list-card/)
    assert.equal(await card.getAttribute('data-archived'), 'true')
    const actions = card.locator('.plc-actions .btn')
    assert.deepEqual(await actions.allInnerTexts(), ['详情', '恢复'])
    assert.equal(await card.locator('[data-open]').count(), 0, 'archived cards never open')
    const heights = await actions.evaluateAll((els) =>
      els.map((el) => el.getBoundingClientRect().height)
    )
    assert.ok(
      heights.every((height) => height >= 44),
      `archived actions >=44px, got ${heights.join(',')}`
    )
    assert.ok((await horizontalOverflow(page)) <= 1, '390px archived cards must not overflow')
    await page.screenshot({ path: join(evidenceDir(EV), '390-archived-group.png') })
  } finally {
    await page.context().close()
  }
})

test('W6-2 390：归档详情 sheet 无页签、横幅可读、恢复项目页脚 ≥44px', async () => {
  const page = await signIn({ width: 390, height: 844 })
  try {
    await openArchivedView(page)
    await page.click('.archived-group .project-list-card [data-detail]')
    await page.waitForSelector('.dialog-backdrop.dialog-sheet')
    await page.waitForSelector('[data-archived-banner]')

    const metrics = await page.evaluate(() => {
      const dialog = document.querySelector<HTMLElement>('.dialog-backdrop.dialog-sheet .dialog')!
      const note = document.querySelector<HTMLElement>('[data-archived-banner]')!
      const rect = note.getBoundingClientRect()
      const restore = [...document.querySelectorAll<HTMLElement>('.dialog-sheet .foot .btn')].find(
        (el) => el.textContent === '恢复项目'
      )
      return {
        dialogWidth: dialog.getBoundingClientRect().width,
        dialogHeight: dialog.getBoundingClientRect().height,
        noteRight: rect.right,
        noteWidth: rect.width,
        tabs: document.querySelectorAll('.dialog-sheet [data-auth-tab]').length,
        restoreHeight: restore?.getBoundingClientRect().height ?? 0,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
      }
    })
    assert.equal(Math.round(metrics.dialogWidth), 390, 'sheet spans the viewport')
    assert.ok(metrics.dialogHeight >= 800, 'sheet is full height')
    assert.equal(metrics.tabs, 0, 'the archived detail has no permission tabs')
    assert.ok(metrics.noteRight <= 390, 'banner stays inside the viewport')
    assert.ok(metrics.noteWidth > 300, 'banner keeps a readable line length')
    assert.ok(metrics.restoreHeight >= 44, `恢复项目 >=44px, got ${metrics.restoreHeight}`)
    assert.ok(metrics.overflow <= 1, 'open archived sheet must not overflow')
    assert.match(
      await page.locator('[data-archived-banner]').innerText(),
      /该项目已归档，仅供查看/
    )
    await page.screenshot({ path: join(evidenceDir(EV), '390-archived-detail.png') })
  } finally {
    await page.context().close()
  }
})

test('W6-3 390：归档确认卡后果可读、按钮 ≥44px、无横向溢出', async () => {
  const page = await signIn({ width: 390, height: 844 })
  try {
    await page.locator('.project-list-card [data-archive]').first().click()
    await page.waitForSelector('.dialog-backdrop:not(.dialog-sheet)')
    const metrics = await page.evaluate(() => {
      const backdrop = document.querySelector<HTMLElement>('.dialog-backdrop')!
      const dialog = backdrop.querySelector<HTMLElement>('.dialog')!
      const items = [...backdrop.querySelectorAll<HTMLElement>('.dialog-consequences li')]
      const buttons = [...backdrop.querySelectorAll<HTMLElement>('.foot .btn')]
      return {
        sheet: backdrop.classList.contains('dialog-sheet'),
        dialogWidth: dialog.getBoundingClientRect().width,
        itemCount: items.length,
        maxRight: Math.max(...items.map((el) => el.getBoundingClientRect().right)),
        lineHeights: items.map((el) => parseFloat(getComputedStyle(el).lineHeight)),
        heights: buttons.map((el) => el.getBoundingClientRect().height),
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
      }
    })
    assert.equal(metrics.sheet, false, 'the confirm stays a centered card, not a sheet')
    assert.ok(metrics.dialogWidth <= 358, `card fits 390px, got ${metrics.dialogWidth}`)
    assert.equal(metrics.itemCount, 5, 'every archive consequence is shown')
    assert.ok(metrics.maxRight <= 390, 'consequences stay inside the viewport')
    assert.ok(
      metrics.lineHeights.every((height) => height >= 18),
      `consequences keep a readable leading, got ${metrics.lineHeights.join(',')}`
    )
    assert.ok(
      metrics.heights.length >= 3 && metrics.heights.every((height) => height >= 44),
      `confirm buttons >=44px, got ${metrics.heights.join(',')}`
    )
    assert.ok(metrics.overflow <= 1, 'confirm card must not overflow')
    await page.screenshot({ path: join(evidenceDir(EV), '390-archive-confirm.png') })

    await page.click('.dialog-backdrop .foot [data-action="close"]')
    await page.waitForFunction(() => !document.querySelector('.dialog-backdrop'))
  } finally {
    await page.context().close()
  }
})

test('W6-4 768/1280：归档分组与确认卡保持桌面表格/居中弹框', async () => {
  for (const viewport of [
    { width: 768, height: 1024 },
    { width: 1280, height: 800 }
  ]) {
    const page = await signIn(viewport)
    try {
      assert.equal(await page.locator('#projectChips').isVisible(), false)
      assert.equal(await page.locator('#projectTableWrap').isVisible(), true)
      assert.equal(await page.locator('#projectList').isVisible(), false)

      await page.locator('.archived-group > summary').click()
      assert.equal(await page.locator('.archived-group .archived-table').isVisible(), true)
      assert.equal(
        await page.locator('.archived-group .project-list').isVisible(),
        false,
        'desktop archived group keeps the table, not cards'
      )
      assert.ok((await page.locator('.archived-group tbody tr').count()) >= 1)

      await page.locator('#projectBody [data-archive]').first().click()
      await page.waitForSelector('.dialog-backdrop')
      assert.equal(await page.locator('.dialog-backdrop.dialog-sheet').count(), 0)
      const box = await page.locator('.dialog').boundingBox()
      assert.ok(box, 'confirm dialog must be laid out')
      assert.ok(box.width <= 520, `desktop confirm keeps its width, got ${box.width}`)
      assert.ok(
        Math.abs(box.x - (viewport.width - box.x - box.width)) <= 2,
        'desktop confirm stays centered'
      )
      await page.click('.dialog .foot [data-action="close"]')
      await page.waitForFunction(() => !document.querySelector('.dialog-backdrop'))
      assert.ok(
        (await horizontalOverflow(page)) <= 1,
        `${viewport.width}px must not overflow horizontally`
      )
    } finally {
      await page.context().close()
    }
  }
})
