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

async function apiLogin(
  username: string,
  password: string
): Promise<{ accessToken: string }> {
  const res = await fetch(`${service.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password })
  })
  assert.equal(res.status, 200, `${username} must sign in over the API`)
  return (await res.json()) as { accessToken: string }
}

/** No seeded auditor: promote lisi through the admin API the users page uses. */
async function promoteAuditor(): Promise<void> {
  const admin = await apiLogin(...ADMIN)
  await apiLogin('lisi', 'Passw0rd!')
  const headers = { authorization: `Bearer ${admin.accessToken}` }
  const directory = (await (
    await fetch(`${service.url}/v1/users`, { headers })
  ).json()) as { users: Array<{ id: string; username: string }> }
  const lisi = directory.users.find((user) => user.username === 'lisi')
  assert.ok(lisi, 'lisi is seeded after first login')
  const res = await fetch(`${service.url}/v1/users/${lisi.id}/roles`, {
    method: 'PUT',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'auditor' })
  })
  assert.equal(res.status, 200, 'admin promotes lisi to auditor')
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

test('390×844：审计员可见审计入口，「更多」无管理项，审计页可进', async () => {
  await promoteAuditor()
  const page = await signIn({ width: 390, height: 844 }, ['lisi', 'Passw0rd!'])
  try {
    assert.equal(await page.locator('#tabAudit').isVisible(), true)
    assert.equal(await page.locator('#tabbar .tabitem:visible').count(), 4)
    assert.equal(await page.locator('#roleChip').innerText(), '审计员')

    await page.click('#tabMore')
    await page.waitForSelector('#moreSheet:not([hidden])')
    assert.equal(await page.locator('#moreNav .more-item:visible').count(), 0)
    assert.equal(await page.locator('#moreLogout').isVisible(), true)
    assert.match(await page.locator('#moreAccount').innerText(), /审计员/)
    await page.click('#moreSheet', { position: { x: 5, y: 5 } })
    await page.waitForFunction(() => document.querySelector('#moreSheet')?.hidden === true)

    await page.click('#tabbar .tabitem[data-route="audit"]')
    await page.waitForFunction(() => location.hash === '#/audit')
    assert.equal(await page.locator('#crumbs').innerText(), '审计日志')
    assert.ok((await horizontalOverflow(page)) <= 1, 'auditor shell must not overflow')
  } finally {
    await page.context().close()
  }
})

test('700/701/1100/1101：grid 列数与底栏显隐的断点边界', async () => {
  const cases = [
    { width: 700, grid3: 1, grid4: 2, tabbar: true },
    { width: 701, grid3: 2, grid4: 2, tabbar: false },
    { width: 1100, grid3: 2, grid4: 2, tabbar: false },
    { width: 1101, grid3: 3, grid4: 4, tabbar: false }
  ] as const
  for (const expected of cases) {
    const page = await signIn({ width: expected.width, height: 900 }, ADMIN)
    try {
      const columns = async (selector: string) =>
        page
          .locator(`#content ${selector}`)
          .first()
          .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length)
      assert.equal(await columns('.grid-3'), expected.grid3, `${expected.width}px grid-3`)
      assert.equal(await columns('.grid-4'), expected.grid4, `${expected.width}px grid-4`)
      assert.equal(
        await page.locator('#tabbar').isVisible(),
        expected.tabbar,
        `${expected.width}px tabbar visibility`
      )
      assert.ok(
        (await horizontalOverflow(page)) <= 1,
        `${expected.width}px must not overflow horizontally`
      )
    } finally {
      await page.context().close()
    }
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
    const fieldHeights = await page
      .locator('.login-card .field input')
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))
    assert.ok(
      fieldHeights.every((height) => height >= 44),
      `login inputs keep a 44px touch target, got ${fieldHeights.join(',')}`
    )
    const passwordBox = await page.locator('#password').boundingBox()
    const toggleBox = await page.locator('#togglePassword').boundingBox()
    assert.ok(passwordBox && toggleBox, 'password row must be laid out')
    assert.ok(
      toggleBox.y >= passwordBox.y - 1 &&
        toggleBox.y + toggleBox.height <= passwordBox.y + passwordBox.height + 1,
      `password toggle stays inside the input row (input ${passwordBox.y}+${passwordBox.height}, toggle ${toggleBox.y}+${toggleBox.height})`
    )
    assert.ok(
      toggleBox.width >= 44 && toggleBox.height >= 44,
      `password toggle keeps a 44px touch target, got ${toggleBox.width}×${toggleBox.height}`
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

/* ---------------- U80 M3: 项目列表 + 详情 sheet ---------------- */

test('390×844：项目列表 chips 横滑、卡字段单行省略、操作 ≥44px、无横向溢出', async () => {
  const page = await signIn({ width: 390, height: 844 }, ADMIN, '#/projects')
  try {
    assert.equal(await page.locator('#projectChips').isVisible(), true)
    assert.deepEqual(await page.locator('#projectChips .chip').allInnerTexts(), [
      '全部状态',
      '仅在线',
      '仅离线'
    ])
    const chipsStyle = await page.locator('#projectChips').evaluate((el) => {
      const style = getComputedStyle(el)
      return { wrap: style.flexWrap, overflowX: style.overflowX }
    })
    assert.deepEqual(chipsStyle, { wrap: 'nowrap', overflowX: 'auto' })
    assert.equal(
      await page.locator('#projectChips .chip').first().evaluate((el) =>
        getComputedStyle(el).whiteSpace
      ),
      'nowrap',
      'chips never wrap onto a second line'
    )

    assert.equal(await page.locator('#projectTableWrap').isVisible(), false, 'table → cards')
    const cards = page.locator('.project-list-card')
    assert.ok((await cards.count()) > 0, 'seeded fixtures expose project cards')
    const nameStyle = await page.locator('.project-list-card .plc-name').first().evaluate((el) => {
      const style = getComputedStyle(el)
      return [style.whiteSpace, style.textOverflow, style.overflow]
    })
    assert.deepEqual(nameStyle, ['nowrap', 'ellipsis', 'hidden'])
    const fieldStyle = await page.locator('.project-list-card .plc-field .v').first().evaluate((el) => {
      const style = getComputedStyle(el)
      return [style.whiteSpace, style.textOverflow]
    })
    assert.deepEqual(fieldStyle, ['nowrap', 'ellipsis'])
    assert.equal(
      await page.locator('.project-list-card .plc-field .k').first().innerText(),
      '可见范围'
    )

    const heights = await cards
      .first()
      .locator('.plc-actions .btn')
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))
    assert.equal(heights.length, 3, '详情 + 归档 + 打开工作区')
    assert.ok(heights.every((height) => height >= 44), `actions >=44px, got ${heights.join(',')}`)
    assert.equal(
      await cards
        .first()
        .locator('.plc-actions .btn.sm')
        .count(),
      3,
      'compact buttons still hold the 44px mobile target'
    )
    assert.equal(
      await cards.first().locator('[data-archive]').count(),
      1,
      'admin card carries the 归档 entry'
    )
    const archiveHeight = await cards
      .first()
      .locator('[data-archive]')
      .evaluate((el) => el.getBoundingClientRect().height)
    assert.ok(archiveHeight >= 44, `归档 touch target >=44px, got ${archiveHeight}`)

    await page.click('#projectChips .chip[data-project-filter="offline"]')
    await page.waitForFunction(
      () => document.querySelectorAll('.project-list-card').length === 0
    )
    assert.match(await page.locator('#projectList').innerText(), /没有匹配的项目/)
    await page.click('#projectChips .chip[data-project-filter="all"]')
    await page.waitForFunction(() => document.querySelectorAll('.project-list-card').length > 0)

    assert.ok((await horizontalOverflow(page)) <= 1, '390px projects must not overflow')
    await page.screenshot({ path: join(evidenceDir(EV), '390x844-projects.png') })
  } finally {
    await page.context().close()
  }
})

test('390×844：项目详情全屏 sheet，信息/权限可切换，权限三卡纵向可读，按钮关闭', async () => {
  const page = await signIn({ width: 390, height: 844 }, ADMIN, '#/projects')
  try {
    await page.click('.project-list-card [data-detail]')
    await page.waitForSelector('.dialog-backdrop.dialog-sheet')
    const sheet = await page.locator('.dialog-backdrop.dialog-sheet .dialog').boundingBox()
    assert.ok(sheet, 'sheet must be laid out')
    assert.ok(sheet.width >= 389, `sheet spans the viewport, got ${sheet.width}`)
    assert.ok(sheet.height >= 843, `sheet spans the viewport, got ${sheet.height}`)
    assert.equal(await page.locator('.dialog-sheet-close').isVisible(), true, 'back button')

    const tabHeight = await page
      .locator('[data-auth-tab="info"]')
      .evaluate((el) => el.getBoundingClientRect().height)
    assert.ok(tabHeight >= 44, `tabs are touch targets, got ${tabHeight}`)

    await page.click('[data-auth-tab="perms"]')
    await page.waitForFunction(
      () => document.querySelectorAll('#projectPermCards .perm-card').length === 3
    )
    assert.deepEqual(
      await page.locator('#projectPermCards .perm-card-head strong').allInnerTexts(),
      ['查看', '控制', '管理']
    )
    const boxes = await page
      .locator('#projectPermCards .perm-card')
      .evaluateAll((els) =>
        els.map((el) => {
          const rect = el.getBoundingClientRect()
          return { x: rect.x, y: rect.y, width: rect.width }
        })
      )
    assert.ok(
      boxes.every((box) => box.width >= 300),
      `cards fill the sheet width, got ${boxes.map((box) => box.width).join(',')}`
    )
    for (let i = 1; i < boxes.length; i += 1) {
      assert.ok(boxes[i].y > boxes[i - 1].y, 'cards stack vertically')
    }

    await page.click('[data-auth-tab="info"]')
    const overflowing = await page.locator('.dialog-sheet .kv dd').evaluateAll((els) => {
      const limit = document.documentElement.clientWidth
      return els.filter((el) => {
        const rect = el.getBoundingClientRect()
        return rect.width > 0 && rect.right > limit + 1
      }).length
    })
    assert.equal(overflowing, 0, 'info values wrap inside the sheet')
    assert.ok((await horizontalOverflow(page)) <= 1, 'open sheet must not overflow horizontally')
    await page.screenshot({ path: join(evidenceDir(EV), '390x844-project-sheet.png') })

    await page.click('.dialog-sheet .foot [data-action="close"]')
    await page.waitForFunction(() => !document.querySelector('.dialog-backdrop'))
    assert.equal(await currentHash(page), '#/projects')
    assert.ok((await horizontalOverflow(page)) <= 1)
  } finally {
    await page.context().close()
  }
})

test('390×844：打开工作区提示 Orca Web 且不加载桌面覆盖层', async () => {
  const page = await signIn({ width: 390, height: 844 }, DEVELOPER, '#/projects')
  try {
    const open = page.locator('.project-list-card [data-open]').first()
    assert.equal(await open.isEnabled(), true)
    await open.click()
    await page.waitForSelector('.toast')
    assert.equal(
      await page.locator('.toast').innerText(),
      '请在 Orca Web 工作区打开（自带移动端支持）'
    )
    assert.equal(await page.locator('#workspaceOverlay').count(), 0)
    assert.equal(await page.evaluate(() => document.querySelectorAll('.workspace-overlay').length), 0)
    assert.equal(await currentHash(page), '#/projects')
    assert.ok((await horizontalOverflow(page)) <= 1)
  } finally {
    await page.context().close()
  }
})

test('768/1280：项目列表保持表格、详情居中弹框（M3 桌面零回归）', async () => {
  for (const viewport of [
    { width: 768, height: 1024 },
    { width: 1280, height: 800 }
  ]) {
    const page = await signIn(viewport, ADMIN, '#/projects')
    try {
      assert.equal(await page.locator('#projectChips').isVisible(), false)
      assert.equal(await page.locator('.project-list').isVisible(), false)
      assert.equal(await page.locator('#projectTableWrap').isVisible(), true)
      assert.ok((await page.locator('#projectBody tr').count()) > 0)

      await page.click('#projectBody [data-detail]')
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
    } finally {
      await page.context().close()
    }
  }
})

/* ---------------- U80 M4: 主机 / 中继移动适配 ---------------- */

const FAILURE_BODY = { error: { code: 'SIMULATED_FAILURE', message: '模拟平台故障' } }

/** A relay node exists only after it registers: seed one through the internal edge. */
async function registerRelayFixture(): Promise<void> {
  const res = await fetch(`${service.url}/v1/internal/relay-endpoint`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-token': 'u80-mobile-internal' },
    body: JSON.stringify({ id: 'relay-u80-mobile', host: '127.0.0.1', port: 17080 })
  })
  assert.equal(res.status, 200, 'the relay fixture must register')
}

async function hostCard(page: Page, id = 'host_dev001') {
  const card = page.locator(`.host-list-card[data-host-card="${id}"]`)
  await card.waitFor()
  return card
}

/** U148: 维护/下线收进「更多」菜单；0=维护/结束维护，1=下线。 */
async function hostMenuAction(page: Page, id: string, action: 0 | 1): Promise<void> {
  await page.locator(`.host-list-card[data-host-card="${id}"] [data-host-more]`).click()
  await page.waitForSelector('.dialog-backdrop')
  await page.locator(`.dialog-backdrop [data-action="${action}"]`).click()
}

test('390×844：主机卡片化、字段省略、动作 ≥44px、维护成功/失败、下线取消零 DELETE', async () => {
  const page = await signIn({ width: 390, height: 844 }, ADMIN, '#/hosts')
  try {
    assert.equal(await page.locator('#hostTableWrap').isVisible(), false, 'table → cards')
    const card = await hostCard(page)
    const nameStyle = await card.locator('.hlc-name').evaluate((el) => {
      const style = getComputedStyle(el)
      return [style.whiteSpace, style.textOverflow, style.overflow]
    })
    assert.deepEqual(nameStyle, ['nowrap', 'ellipsis', 'hidden'])
    const lineStyle = await card.locator('.hlc-line').first().evaluate((el) => {
      const style = getComputedStyle(el)
      return [style.whiteSpace, style.textOverflow, style.overflow]
    })
    assert.deepEqual(lineStyle, ['nowrap', 'ellipsis', 'hidden'], 'address/heartbeat stay one line')
    assert.match(await card.innerText(), /最后心跳/)

    const actions = card.locator('.hlc-actions .btn')
    assert.equal(await actions.count(), 2, '详情 / 更多')
    assert.deepEqual(await actions.allInnerTexts(), ['详情', '更多'])
    const heights = await actions.evaluateAll((els) =>
      els.map((el) => el.getBoundingClientRect().height)
    )
    assert.ok(heights.every((height) => height >= 44), `actions >=44px, got ${heights.join(',')}`)

    await card.locator('[data-host-more]').click()
    await page.waitForSelector('.dialog-backdrop')
    const menuHeights = await page
      .locator('.dialog-backdrop [data-action]')
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))
    assert.ok(menuHeights.every((height) => height >= 44), 'menu items >=44px')
    await page.locator('.dialog-backdrop [data-action="0"]').click()

    // Enter maintenance: the sealed-in-place failure path reuses the desktop toast.
    await page.waitForFunction(
      () =>
        document.querySelector('.host-list-card[data-host-card="host_dev001"] .badge')
          ?.textContent === '维护中'
    )
    assert.match(await (await hostCard(page)).innerText(), /维护中/)

    await page.route('**/v1/hosts/*/maintenance', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify(FAILURE_BODY)
      })
    )
    await hostMenuAction(page, 'host_dev001', 0)
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.toast')].some((el) => el.textContent?.includes('失败'))
    )
    assert.match(
      await page.locator('.toast').last().innerText(),
      /结束维护失败：模拟平台故障/,
      'failure toast must carry the platform reason'
    )
    assert.match(
      await (await hostCard(page)).innerText(),
      /维护中/,
      'a failed call leaves state untouched'
    )
    await page.unroute('**/v1/hosts/*/maintenance')

    await hostMenuAction(page, 'host_dev001', 0)
    await page.waitForFunction(
      () =>
        document.querySelector('.host-list-card[data-host-card="host_dev001"] .badge')
          ?.textContent !== '维护中'
    )

    // Revoke asks first through the styled card; cancel must send no DELETE.
    const deletes: string[] = []
    page.on('request', (request) => {
      if (request.method() === 'DELETE' && request.url().includes('/v1/hosts/')) {
        deletes.push(request.url())
      }
    })
    await hostMenuAction(page, 'host_dev001', 1)
    await page.waitForFunction(() =>
      document.querySelector('.dialog-backdrop')?.textContent?.includes('不可撤销')
    )
    await page.locator('.dialog-backdrop [data-action="0"]').click()
    await page.waitForTimeout(300)
    assert.deepEqual(deletes, [], 'cancelling the confirm must issue zero DELETE')

    assert.ok((await horizontalOverflow(page)) <= 1, '390px hosts must not overflow')
    await page.screenshot({ path: join(evidenceDir(EV), '390x844-hosts.png') })
  } finally {
    await page.context().close()
  }
})

test('390×844：主机详情全屏 sheet 换行不溢出，注册命令可横滑、复制 ≥44px', async () => {
  const page = await signIn({ width: 390, height: 844 }, ADMIN, '#/hosts')
  try {
    await (await hostCard(page)).locator('[data-host]').click()
    await page.waitForSelector('.drawer')
    const box = await page.locator('.drawer').boundingBox()
    assert.ok(box, 'drawer must be laid out')
    assert.ok(box.width >= 389, `phone drawer spans the viewport, got ${box.width}`)
    assert.ok(box.height >= 843, `phone drawer is full height, got ${box.height}`)
    const closeSize = await page
      .locator('.drawer-head .icon-btn')
      .evaluate((el) => el.getBoundingClientRect().height)
    assert.ok(closeSize >= 44, `close target >=44px, got ${closeSize}`)
    const ddWrap = await page.locator('.drawer dd').first().evaluate((el) => {
      const style = getComputedStyle(el)
      return [style.wordBreak, style.overflowWrap]
    })
    assert.equal(ddWrap[0], 'break-word')
    assert.equal(ddWrap[1], 'anywhere')
    assert.ok((await horizontalOverflow(page)) <= 1, 'the host sheet must not overflow')
    const maintenance = await page
      .locator('#maintenanceBtn')
      .evaluate((el) => el.getBoundingClientRect().height)
    const revoke = await page
      .locator('#revokeHostBtn')
      .evaluate((el) => el.getBoundingClientRect().height)
    assert.ok(maintenance >= 44 && revoke >= 44, 'drawer actions >=44px')
    await page.click('.drawer-head .icon-btn')
    await page.waitForFunction(() => !document.querySelector('.drawer'))

    await page.click('#registerHostBtn')
    await page.waitForSelector('#installCmd')
    const pre = await page.locator('#installCmd').evaluate((el) => {
      const style = getComputedStyle(el)
      return {
        overflowX: style.overflowX,
        scrolls: el.scrollWidth > el.clientWidth,
        right: el.getBoundingClientRect().right
      }
    })
    assert.equal(pre.overflowX, 'auto')
    assert.equal(pre.scrolls, true, 'the one-liner is wider than the phone dialog')
    assert.ok(pre.right <= 391, 'the command block stays inside the viewport')
    const copy = page.locator('.dialog .foot .btn', { hasText: '复制命令' })
    const copyHeight = await copy.evaluate((el) => el.getBoundingClientRect().height)
    assert.ok(copyHeight >= 44, `copy target >=44px, got ${copyHeight}`)
    await copy.click()
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.toast')].some((el) => el.textContent === '已复制')
    )
    await page.click('.dialog .foot [data-action="close"]')
    assert.ok((await horizontalOverflow(page)) <= 1)
    await page.screenshot({ path: join(evidenceDir(EV), '390x844-host-detail.png') })
  } finally {
    await page.context().close()
  }
})

test('390×844：中继卡片化、刷新 ≥44px、失败横幅可读且旧数据保留', async () => {
  await registerRelayFixture()
  const page = await signIn({ width: 390, height: 844 }, ADMIN, '#/relays')
  try {
    assert.equal(await page.locator('#relayTableWrap').isVisible(), false, 'table → cards')
    const cards = page.locator('.relay-list-card')
    assert.ok((await cards.count()) > 0, 'the registered relay renders as a card')
    const card = cards.filter({ hasText: 'relay-u80-mobile' }).first()
    assert.match(await card.innerText(), /127\.0\.0\.1:17080/)
    assert.equal(await card.locator('.hlc-line').count(), 2, 'address + last seen')
    assert.match(await card.innerText(), /最近注册/)
    const refreshHeight = await page
      .locator('#refreshRelaysBtn')
      .evaluate((el) => el.getBoundingClientRect().height)
    assert.ok(refreshHeight >= 44, `refresh target >=44px, got ${refreshHeight}`)

    await page.route('**/v1/relays', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify(FAILURE_BODY)
      })
    )
    await page.click('#refreshRelaysBtn')
    await page.waitForSelector('#relayRefreshWarning')
    const warning = page.locator('#relayRefreshWarning')
    assert.match(await warning.innerText(), /刷新失败：模拟平台故障/)
    assert.equal(await page.locator('.relay-list-card').count(), await cards.count(), 'old cards stay')
    const warningBox = await warning.boundingBox()
    assert.ok(warningBox && warningBox.x + warningBox.width <= 391, 'warning fits the phone')
    const retryHeight = await page
      .locator('#retryRelaysBtn')
      .evaluate((el) => el.getBoundingClientRect().height)
    assert.ok(retryHeight >= 44, `retry target >=44px, got ${retryHeight}`)
    assert.ok((await horizontalOverflow(page)) <= 1, '390px relays must not overflow')
    await page.screenshot({ path: join(evidenceDir(EV), '390x844-relays-warning.png') })

    await page.unroute('**/v1/relays')
    await page.click('#retryRelaysBtn')
    await page.waitForFunction(() => !document.querySelector('#relayRefreshWarning'))
    assert.ok((await page.locator('.relay-list-card').count()) > 0, 'retry renders the cards')
  } finally {
    await page.context().close()
  }
})

test('768/1280：主机/中继保持表格、主机详情为侧栏抽屉（M4 桌面零回归）', async () => {
  for (const viewport of [
    { width: 768, height: 1024 },
    { width: 1280, height: 800 }
  ]) {
    const page = await signIn(viewport, ADMIN, '#/hosts')
    try {
      assert.equal(await page.locator('.host-list').isVisible(), false)
      assert.equal(await page.locator('#hostTableWrap').isVisible(), true)
      assert.ok((await page.locator('#hostTableWrap tbody tr').count()) > 0)
      await page.click('#hostTableWrap [data-host]')
      await page.waitForSelector('.drawer')
      const box = await page.locator('.drawer').boundingBox()
      assert.ok(box, 'desktop drawer must be laid out')
      assert.ok(box.width <= 441, `desktop keeps the side drawer, got ${box.width}`)
      assert.ok(
        box.x + box.width >= viewport.width - 1,
        'desktop drawer stays docked to the right edge'
      )
      await page.click('.drawer-head .icon-btn')
      await page.waitForFunction(() => !document.querySelector('.drawer'))

      await page.click('.sidebar .nav-item[data-route="relays"]')
      await page.waitForFunction(() => location.hash === '#/relays')
      await page.waitForSelector('#relayTableWrap')
      assert.equal(await page.locator('.relay-list').isVisible(), false)
      assert.equal(await page.locator('#relayTableWrap').isVisible(), true)
      assert.ok((await horizontalOverflow(page)) <= 1, `${viewport.width}px must not overflow`)
    } finally {
      await page.context().close()
    }
  }
})
