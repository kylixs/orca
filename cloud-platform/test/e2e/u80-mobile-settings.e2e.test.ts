import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { evidenceDir, spawnService, type Service } from './harness.ts'

/**
 * U80 M7: the phone face of 平台设置. Real Chrome proves the ≤700px single-column
 * policy card, 44px save, readable 409 conflict bar with retry, and the override
 * table turned into cards. 768/1280 keep the desktop table byte for byte.
 */

const ADMIN = ['admin', 'Adm1n!'] as const
const EV = 'u80-mobile'
const PROJECT_ID = 'proj_payment'

let service: Service
let browser: Browser

before(async () => {
  service = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN: 'u80-mobile-settings-internal' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-u80-mobile-settings'
  )
  browser = await chromium.launch({ channel: 'chrome', headless: true })
}, 180_000)

after(async () => {
  await browser?.close()
  await service?.stop()
})

async function signIn(
  viewport: { width: number; height: number },
  hash = '#/settings'
): Promise<Page> {
  const context = await browser.newContext({ viewport })
  const page = await context.newPage()
  await page.goto(`${service.url}/${hash}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#loginForm', { state: 'visible' })
  await page.fill('#username', ADMIN[0])
  await page.fill('#password', ADMIN[1])
  await page.click('#loginBtn')
  await page.waitForSelector('#view-app:not([hidden])')
  await page.waitForSelector('.settings-page .page-head')
  return page
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  )
}

async function adminToken(): Promise<string> {
  const res = await fetch(`${service.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: ADMIN[0], password: ADMIN[1], deviceName: 'u80-m7' })
  })
  assert.equal(res.status, 200, 'admin must sign in over the API')
  return ((await res.json()) as { accessToken: string }).accessToken
}

async function setProjectPolicy(body: { downloadPolicy: string } | { inherit: true }): Promise<void> {
  const res = await fetch(`${service.url}/v1/projects/${PROJECT_ID}/policy`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${await adminToken()}`
    },
    body: JSON.stringify(body)
  })
  assert.equal(res.status, 200, 'project policy fixture must be writable')
}

test('390×844：全局策略单选单列、44px 保存、版本号可见', async () => {
  const page = await signIn({ width: 390, height: 844 })
  try {
    const choices = page.locator('.settings-choice')
    assert.equal(await choices.count(), 2, 'two global policy choices')
    const boxes = await choices.evaluateAll((els) =>
      els.map((el) => {
        const rect = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        return { x: rect.x, y: rect.y, height: rect.height, display: style.display }
      })
    )
    assert.ok(boxes.every((box) => box.display === 'flex'), 'choices stack as blocks')
    assert.equal(boxes[0].x, boxes[1].x, 'single column: same left edge')
    assert.ok(boxes[1].y >= boxes[0].y + boxes[0].height, 'choices stack vertically')
    assert.ok(
      boxes.every((box) => box.height >= 44),
      `touch targets >=44px, got ${boxes.map((box) => box.height).join(',')}`
    )

    const radios = await page.locator('.settings-choice input').evaluateAll((els) =>
      els.map((el) => {
        const rect = el.getBoundingClientRect()
        return { width: rect.width, height: rect.height }
      })
    )
    assert.ok(
      radios.every((radio) => radio.width >= 20 && radio.height >= 20),
      'radio marks stay tappable'
    )

    const save = page.locator('#savePolicy')
    const saveBox = await save.boundingBox()
    assert.ok(saveBox && saveBox.height >= 44, `保存 >=44px, got ${saveBox?.height}`)

    const version = page.locator('#policyVersion')
    assert.equal(await version.isVisible(), true, 'the version must be visible')
    assert.match(await version.innerText(), /^当前版本 v\d+$/)

    assert.ok((await horizontalOverflow(page)) <= 1, '390px settings must not overflow')
    await page.screenshot({ path: join(evidenceDir(EV), '390x844-settings-policy.png') })
  } finally {
    await page.context().close()
  }
})

test('390×844：409 冲突条可读、刷新后重试 ≥44px 且重放选择', async () => {
  const page = await signIn({ width: 390, height: 844 })
  const puts: { body: unknown }[] = []
  let attempt = 0
  try {
    await page.route('**/v1/policies/download', (route) => {
      if (route.request().method() !== 'PUT') return route.continue()
      puts.push({ body: route.request().postDataJSON() })
      attempt += 1
      if (attempt === 1) {
        return route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            error: {
              code: 'POLICY_VERSION_CONFLICT',
              message: '下载策略已被他人修改，请刷新后重试。',
              details: { version: 99, downloadDefault: 'deny' }
            }
          })
        })
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ version: 100, downloadDefault: 'allow' })
      })
    })

    await page.locator('.settings-choice input[value=allow]').check()
    await page.click('#savePolicy')
    await page.waitForFunction(
      () => !document.querySelector<HTMLElement>('#policyConflict')?.hidden
    )

    const note = page.locator('#policyConflict')
    const text = await note.innerText()
    assert.match(text, /策略已被他人修改/)
    assert.match(text, /服务端当前版本 v99/)
    assert.match(text, /全局默认 禁止/)
    assert.match(text, /你选择的「允许」尚未保存/)

    const retry = page.locator('#policyConflictRetry')
    assert.equal(await retry.innerText(), '刷新后重试')
    const retryBox = await retry.boundingBox()
    assert.ok(retryBox && retryBox.height >= 44, `刷新后重试 >=44px, got ${retryBox?.height}`)
    const noteBox = await note.boundingBox()
    assert.ok(noteBox, 'conflict bar must be laid out')
    assert.ok(noteBox.x + noteBox.width <= 391, 'conflict copy stays inside the phone')

    const fresh = (await (
      await fetch(`${service.url}/v1/policies/download`, {
        headers: { authorization: `Bearer ${await adminToken()}` }
      })
    ).json()) as { version: number }

    await retry.click()
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('.toast')].some((el) => el.textContent?.includes('已保存'))
    )
    assert.equal(puts.length, 2, 'retry replays the write exactly once')
    assert.deepEqual(
      puts[1].body,
      { downloadDefault: 'allow', expectedVersion: fresh.version },
      'retry re-reads the fresh version and replays the admin choice'
    )
    assert.ok((await horizontalOverflow(page)) <= 1, 'conflict bar must not overflow')
    await page.screenshot({ path: join(evidenceDir(EV), '390x844-settings-conflict.png') })
  } finally {
    await page.unroute('**/v1/policies/download')
    await page.context().close()
  }
})

test('390×844：项目覆盖表转卡片、行内下拉 ≥44px、长路径不溢出', async () => {
  await setProjectPolicy({ downloadPolicy: 'allow' })
  const page = await signIn({ width: 390, height: 844 })
  try {
    const row = page.locator('tr[data-policy-row]').first()
    await row.waitFor()
    assert.equal(await page.locator('.settings-policy-table thead').isVisible(), false)
    const layout = await row.evaluate((el) => {
      const style = getComputedStyle(el)
      const cell = el.querySelector('td[data-label="覆盖策略"]')
      return {
        display: style.display,
        background: style.backgroundColor,
        radius: style.borderRadius,
        before: cell ? getComputedStyle(cell, '::before').content : ''
      }
    })
    assert.equal(layout.display, 'block', 'each override row is a card')
    assert.notEqual(layout.background, 'rgba(0, 0, 0, 0)', 'the card has a surface')
    assert.notEqual(layout.radius, '0px', 'the card is rounded')
    assert.match(layout.before, /覆盖策略/, 'cells gain a visible label')

    const select = row.locator('[data-policy-select]')
    const selectBox = await select.boundingBox()
    assert.ok(selectBox && selectBox.height >= 44, `行内下拉 >=44px, got ${selectBox?.height}`)
    assert.ok(selectBox && selectBox.width > 200, `select fills the card, got ${selectBox?.width}`)
    assert.equal(await select.inputValue(), 'allow', 'the fixture override is reflected')
    assert.match(await row.innerText(), /当前生效：允许/)

    const rowBox = await row.boundingBox()
    assert.ok(rowBox && rowBox.x + rowBox.width <= 391, 'override card stays inside the phone')
    assert.ok((await horizontalOverflow(page)) <= 1, '390px override cards must not overflow')
    await page.screenshot({ path: join(evidenceDir(EV), '390x844-settings-overrides.png') })
  } finally {
    await page.context().close()
    await setProjectPolicy({ inherit: true })
  }
})

test('768/1101/1280：设置页保持桌面表格与行内布局（M7 桌面零回归）', async () => {
  await setProjectPolicy({ downloadPolicy: 'allow' })
  try {
    for (const viewport of [
      { width: 768, height: 1024 },
      { width: 1101, height: 900 },
      { width: 1280, height: 800 }
    ]) {
      const page = await signIn(viewport)
      try {
        const row = page.locator('tr[data-policy-row]').first()
        await row.waitFor()
        assert.equal(
          await page.locator('.settings-policy-table thead').isVisible(),
          true,
          `${viewport.width}px keeps the table header`
        )
        const display = await row.evaluate((el) => getComputedStyle(el).display)
        assert.equal(display, 'table-row', `${viewport.width}px keeps table rows`)
        const cellDisplay = await row.locator('td').first().evaluate((el) => getComputedStyle(el).display)
        assert.equal(cellDisplay, 'table-cell', `${viewport.width}px keeps table cells`)

        const choice = await page.locator('.settings-choice').first().evaluate((el) => {
          const rect = el.getBoundingClientRect()
          return { display: getComputedStyle(el).display, marginBottom: getComputedStyle(el).marginBottom }
        })
        assert.equal(choice.display, 'flex', 'desktop choice is unchanged')
        assert.equal(choice.marginBottom, '12px')

        const select = page.locator('[data-policy-select]').first()
        const selectBox = await select.boundingBox()
        assert.ok(selectBox && selectBox.height < 44, `desktop select keeps 32px, got ${selectBox?.height}`)
        const saveBox = await page.locator('#savePolicy').boundingBox()
        assert.ok(saveBox && saveBox.height < 44, 'desktop save keeps its compact height')
        assert.equal(await page.locator('#policyVersion').isVisible(), true)

        assert.ok(
          (await horizontalOverflow(page)) <= 1,
          `${viewport.width}px must not overflow horizontally`
        )
        if (viewport.width === 768) {
          await page.screenshot({ path: join(evidenceDir(EV), '768x1024-settings.png') })
        }
      } finally {
        await page.context().close()
      }
    }
  } finally {
    await setProjectPolicy({ inherit: true })
  }
})
