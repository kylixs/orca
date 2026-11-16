import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { evidenceDir, spawnService, type Service } from './harness.ts'

/**
 * U80 M5: the phone face of 用户管理. Real Chrome proves the ≤700px card list,
 * the full-screen detail sheet, the U135 409 copy, and the LDAP badge states.
 * Desktop stays the byte-for-byte table at 768, 1101 and 1280.
 */

const ADMIN = ['admin', 'Adm1n!'] as const
const EV = 'u80-mobile'

let service: Service
let browser: Browser

before(async () => {
  service = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN: 'u80-mobile-users-internal' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-u80-mobile-users'
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

async function apiToken(username: string, password: string): Promise<string> {
  const res = await fetch(`${service.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password })
  })
  assert.equal(res.status, 200, `${username} must sign in over the API`)
  return ((await res.json()) as { accessToken: string }).accessToken
}

/** Admin-side role write used to restore the seeded fixture after a UI change. */
async function setUserRole(username: string, role: string): Promise<void> {
  const headers = { authorization: `Bearer ${await apiToken(...ADMIN)}` }
  const directory = (await (
    await fetch(`${service.url}/v1/users`, { headers })
  ).json()) as { users: { id: string; username: string }[] }
  const user = directory.users.find((item) => item.username === username)
  if (!user) return
  await fetch(`${service.url}/v1/users/${user.id}/roles`, {
    method: 'PUT',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ role })
  })
}

test('390×844：用户卡片化、字段单行省略、详情 ≥44px、筛选与空态', async () => {
  const page = await signIn({ width: 390, height: 844 }, ADMIN, '#/users')
  try {
    assert.equal(await page.locator('#userTableWrap').isVisible(), false, 'table → cards')
    assert.equal(await page.locator('#userList').isVisible(), true)
    const cards = page.locator('.user-list-card')
    assert.ok((await cards.count()) > 0, 'seeded fixtures expose user cards')

    const nameStyle = await cards.first().locator('.ulc-name').evaluate((el) => {
      const style = getComputedStyle(el)
      return [style.whiteSpace, style.textOverflow, style.overflow]
    })
    assert.deepEqual(nameStyle, ['nowrap', 'ellipsis', 'hidden'])
    const lineStyle = await cards.first().locator('.ulc-line').evaluate((el) => {
      const style = getComputedStyle(el)
      return [style.whiteSpace, style.textOverflow, style.overflow]
    })
    assert.deepEqual(lineStyle, ['nowrap', 'ellipsis', 'hidden'], '账号 · 部门 stays one line')
    assert.equal(await cards.first().locator('.ulc-role .badge').count(), 1, '角色徽标')
    assert.match(await cards.first().innerText(), /活跃|已停用/, '状态 is readable on the card')

    const heights = await cards
      .first()
      .locator('.ulc-actions .btn')
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))
    assert.equal(heights.length, 1, 'the row keeps its single 详情 action')
    assert.ok(heights.every((height) => height >= 44), `详情 >=44px, got ${heights.join(',')}`)

    await page.fill('#userSearch', 'zhang')
    await page.waitForFunction(() => document.querySelectorAll('.user-list-card').length === 1)
    assert.match(await page.locator('.user-list-card').innerText(), /张伟/)
    await page.fill('#userSearch', '没有这个账号')
    await page.waitForFunction(() => document.querySelector('.user-list-card') === null)
    assert.match(await page.locator('#userList').innerText(), /没有符合筛选条件的账号/)

    assert.ok((await horizontalOverflow(page)) <= 1, '390px users must not overflow')
    await page.screenshot({ path: join(evidenceDir(EV), '390x844-users.png') })
  } finally {
    await page.context().close()
  }
})

test('390×844：用户详情全屏 sheet、字段换行、角色下拉 ≥44px、启用账号改角色成功', async () => {
  const page = await signIn({ width: 390, height: 844 }, ADMIN, '#/users')
  try {
    const card = page.locator('.user-list-card').filter({ hasText: '张伟' }).first()
    await card.locator('[data-user-detail]').click()
    await page.waitForSelector('.dialog-backdrop.dialog-sheet')
    const sheet = await page.locator('.dialog-backdrop.dialog-sheet .dialog').boundingBox()
    assert.ok(sheet, 'sheet must be laid out')
    assert.ok(sheet.width >= 389, `sheet spans the viewport, got ${sheet.width}`)
    assert.ok(sheet.height >= 843, `sheet spans the viewport, got ${sheet.height}`)
    assert.equal(await page.locator('.dialog-sheet-close').isVisible(), true, 'back button')

    const overflowing = await page.locator('.dialog-sheet .kv dd').evaluateAll((els) => {
      const limit = document.documentElement.clientWidth
      return els.filter((el) => {
        const rect = el.getBoundingClientRect()
        return rect.width > 0 && rect.right > limit + 1
      }).length
    })
    assert.equal(overflowing, 0, 'detail values wrap inside the sheet')

    const role = page.locator('[data-detail-role]')
    assert.equal(await role.isDisabled(), false)
    const roleBox = await role.boundingBox()
    assert.ok(roleBox && roleBox.height >= 44, `角色下拉 >=44px, got ${roleBox?.height}`)

    const stored = await role.inputValue()
    const next = stored === 'auditor' ? 'admin' : 'auditor'
    await role.selectOption(next)
    await page.waitForFunction(() => document.querySelectorAll('.dialog-backdrop').length === 2)
    const confirm = page.locator('.dialog-backdrop').last()
    assert.match(await confirm.innerText(), /角色变更/)
    await confirm.locator('[data-action="0"]').click()
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('.toast')].some((el) =>
          el.textContent?.includes('已将 张伟 的角色更新为')
        )
    )
    await page.waitForFunction(
      (expected) => document.querySelector('[data-detail-role]')?.value === expected,
      next
    )
    assert.ok((await horizontalOverflow(page)) <= 1, 'open user sheet must not overflow')
    await page.screenshot({ path: join(evidenceDir(EV), '390x844-user-sheet.png') })

    await page.click('.dialog-sheet .foot [data-action="close"]')
    await page.waitForFunction(() => !document.querySelector('.dialog-backdrop'))
  } finally {
    await page.context().close()
    await setUserRole('zhangsan', 'developer')
  }
})

test('390×844：停用账号改角色 → 服务端 409 文案逐字展示（U135）', async () => {
  const disabledUser = {
    id: 'usr_disabled_u80',
    username: 'wangwu',
    displayName: '王五',
    dept: '支付研发部',
    groups: ['developers'],
    roles: ['platform:auditor'],
    status: 'disabled',
    role: 'auditor',
    roleSource: 'admin-override'
  }
  const page = await signIn({ width: 390, height: 844 }, ADMIN)
  try {
    // The public API cannot disable an account; inject the fact at the API
    // boundary and drop the route again in the teardown to restore the directory.
    await page.route('**/v1/users', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ldap: {}, users: [disabledUser] })
      })
    )
    const roleWrites: string[] = []
    await page.route('**/v1/users/*/roles', (route) => {
      roleWrites.push(route.request().method())
      return route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'USER_DISABLED', message: '账号已停用，不能修改角色。' }
        })
      })
    })
    await page.evaluate(() => {
      location.hash = '#/users'
    })
    await page.waitForSelector('.user-list-card')

    await page.locator('.user-list-card [data-user-detail]').click()
    await page.waitForSelector('.dialog-backdrop.dialog-sheet')
    const role = page.locator('[data-detail-role]')
    assert.equal(await role.isDisabled(), false, 'mobile lets the attempt reach the server')
    const roleBox = await role.boundingBox()
    assert.ok(roleBox && roleBox.height >= 44, `角色下拉 >=44px, got ${roleBox?.height}`)
    assert.match(await page.locator('.dialog-sheet .body').innerText(), /已停用账号不可修改角色/)

    await role.selectOption('admin')
    await page.waitForFunction(() => document.querySelectorAll('.dialog-backdrop').length === 2)
    await page.locator('.dialog-backdrop').last().locator('[data-action="0"]').click()
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('.toast')].some((el) =>
          el.textContent?.includes('账号已停用，不能修改角色。')
        )
    )
    assert.deepEqual(roleWrites, ['PUT'], 'the mobile attempt writes once')
    assert.equal(
      await page.locator('.toast').last().innerText(),
      '保存失败：账号已停用，不能修改角色。',
      'U135 copy is shown verbatim'
    )
    assert.ok((await horizontalOverflow(page)) <= 1)
    await page.screenshot({ path: join(evidenceDir(EV), '390x844-user-disabled-409.png') })
  } finally {
    await page.unroute('**/v1/users/*/roles')
    await page.unroute('**/v1/users')
    await page.context().close()
  }
})

test('390×844：LDAP 准入徽标三态可读、长组名不溢出', async () => {
  const page = await signIn({ width: 390, height: 844 }, ADMIN)
  let usersBody: unknown = {
    ldap: { requiredGroup: 'platform-admins-platform-observers-very-long-group-name' },
    users: []
  }
  const goUsers = async () => {
    await page.evaluate(() => {
      location.hash = '#/workbench'
    })
    await page.waitForFunction(() => location.hash === '#/workbench')
    await page.evaluate(() => {
      location.hash = '#/users'
    })
    await page.waitForFunction(() => location.hash === '#/users')
    await page.waitForSelector('#content .page-head')
  }
  try {
    await page.route('**/v1/users', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(usersBody)
      })
    )

    await goUsers()
    await page.waitForFunction(() =>
      document.querySelector('#content .page-head .toolbar .badge')?.textContent?.startsWith('LDAP')
    )
    const badge = page.locator('.page-head .toolbar .badge').first()
    assert.equal(
      await badge.innerText(),
      'LDAP 准入组：platform-admins-platform-observers-very-long-group-name'
    )
    const badgeBox = await badge.boundingBox()
    assert.ok(badgeBox && badgeBox.x + badgeBox.width <= 391, 'the badge stays inside the phone')
    assert.ok((await horizontalOverflow(page)) <= 1, 'a long LDAP group must not overflow')

    usersBody = { ldap: {}, users: [] }
    await goUsers()
    await page.waitForFunction(
      () =>
        document.querySelector('#content .page-head .toolbar .badge')?.textContent ===
        'LDAP 准入：未配置'
    )
    assert.ok((await horizontalOverflow(page)) <= 1)

    usersBody = { users: [] }
    await goUsers()
    await page.waitForFunction(
      () =>
        document.querySelector('#content .page-head .toolbar .badge')?.textContent === 'LDAP 分组准入'
    )
    assert.equal(
      await page.locator('.page-head .toolbar .badge').first().innerText(),
      'LDAP 分组准入',
      'an older server without the field falls back to neutral copy'
    )
    assert.ok((await horizontalOverflow(page)) <= 1)
    await page.screenshot({ path: join(evidenceDir(EV), '390x844-users-ldap.png') })
  } finally {
    await page.unroute('**/v1/users')
    await page.context().close()
  }
})

test('768/1101/1280：用户管理保持表格、详情居中弹框（M5 桌面零回归）', async () => {
  for (const viewport of [
    { width: 768, height: 1024 },
    { width: 1101, height: 900 },
    { width: 1280, height: 800 }
  ]) {
    const page = await signIn(viewport, ADMIN, '#/users')
    try {
      assert.equal(await page.locator('.user-list').isVisible(), false)
      assert.equal(await page.locator('#userTableWrap').isVisible(), true)
      assert.ok((await page.locator('#usersBody tr').count()) > 0)

      await page.click('#usersBody [data-user-detail]')
      await page.waitForSelector('.dialog-backdrop')
      assert.equal(
        await page.locator('.dialog-sheet-close').isVisible(),
        false,
        'desktop keeps the centered dialog: no sheet back bar'
      )
      const box = await page.locator('.dialog').boundingBox()
      assert.ok(box, 'dialog must be laid out')
      assert.ok(box.width <= 720, `dialog keeps its desktop width, got ${box.width}`)
      const leftGap = box.x
      const rightGap = viewport.width - box.x - box.width
      assert.ok(Math.abs(leftGap - rightGap) <= 2, 'dialog stays centered')
      await page.click('.dialog .foot [data-action="close"]')
      await page.waitForFunction(() => !document.querySelector('.dialog-backdrop'))
      assert.ok(
        (await horizontalOverflow(page)) <= 1,
        `${viewport.width}px must not overflow horizontally`
      )
      if (viewport.width === 768) {
        await page.screenshot({ path: join(evidenceDir(EV), '768x1024-users.png') })
      }
    } finally {
      await page.context().close()
    }
  }
})
