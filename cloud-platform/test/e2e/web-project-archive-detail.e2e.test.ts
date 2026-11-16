import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { evidenceDir, login, registerHost, spawnService, type Service } from './harness.ts'
import { loadWebConsolePage, type WebConsolePage } from './web-console-page.ts'

/**
 * U116① W5: the archived project detail is read-only.
 *
 * - banner states the archive/session/disk facts; no permission tab; no open entry
 * - grants/policy/host-grants are never requested for an archived detail
 * - old platform 404 on the opt-in GET degrades to an explicit unsupported note
 * - restore closes the detail and returns to the live list
 * - a non-admin deep link never learns the archived id exists
 * - at 390px the archived detail is a full-screen sheet with a readable banner
 */

let service: Service
let browser: Browser
let adminToken = ''
let hostId = ''
let archivedId = ''
let restoreId = ''

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
  const id = (created.body as { id: string }).id
  const archived = await adminApi(`/v1/projects/${id}/archive`, { method: 'POST' })
  assert.equal(archived.status, 200, JSON.stringify(archived.body))
  return id
}

before(async () => {
  service = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN: 'u116-w5-token' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-u116-w5'
  )
  adminToken = await login(service.url, 'admin', 'Adm1n!')
  const host = await registerHost({
    apiUrl: service.url,
    adminToken,
    name: 'u116-w5-host',
    directAddr: '127.0.0.1:17118',
    relayTarget: '127.0.0.1:17118'
  })
  hostId = host.hostId
  archivedId = await createProject('w5-archived', 'w5-archived')
  restoreId = await createProject('w5-restore', 'w5-restore')
  browser = await chromium.launch({ channel: 'chrome', headless: true })
}, 180_000)

after(async () => {
  await browser?.close()
  await service?.stop()
})

function doc(page: WebConsolePage): Document {
  return page.window.document
}

function banner(page: WebConsolePage): HTMLElement | null {
  return doc(page).querySelector<HTMLElement>('[data-archived-banner]')
}

function footerLabels(page: WebConsolePage): string[] {
  const foot = doc(page).querySelector<HTMLElement>('.dialog .foot')
  return [...(foot?.querySelectorAll('button') ?? [])].map((b) => b.textContent ?? '')
}

async function openArchivedDetail(id = archivedId): Promise<WebConsolePage> {
  const page = loadWebConsolePage(service.url, { hash: `#/projects/${id}` })
  await page.settle()
  await page.submitLogin('admin', 'Adm1n!')
  return page
}

test('W5-1 归档详情只读：横幅、无权限 tab、无打开、无 grants/policy 请求', async () => {
  const page = loadWebConsolePage(service.url)
  await page.settle()
  await page.submitLogin('admin', 'Adm1n!')
  await page.clickNav('projects')
  const archivedRow = [...doc(page).querySelectorAll<HTMLElement>('.archived-group tbody tr')].find(
    (row) => row.textContent?.includes('w5-archived')
  )
  assert.ok(archivedRow, 'precondition: archived row visible with 详情')
  const listCallCount = page.calls().length
  archivedRow.querySelector<HTMLButtonElement>('[data-detail]')!.click()
  await page.settle()

  const note = banner(page)
  assert.ok(note, 'archived detail carries the read-only banner')
  assert.match(note.textContent ?? '', /该项目已归档，仅供查看；会话已断开，磁盘代码未删除/)

  assert.equal(doc(page).querySelector('[data-auth-tab="perms"]'), null, 'permission tab is hidden')
  assert.equal(doc(page).querySelector('[data-auth-tab]'), null, 'no tabs at all')
  assert.equal(doc(page).querySelector('#projectPermCards'), null, 'no permission cards')
  assert.equal(
    footerLabels(page).includes('打开项目'),
    false,
    'archived detail offers no open entry'
  )
  assert.ok(footerLabels(page).includes('恢复项目'), 'footer keeps 恢复项目')

  const text = doc(page).querySelector('.dialog .body')?.textContent ?? ''
  assert.match(text, /基本信息/)
  assert.match(text, /运行配置/)
  assert.match(text, /项目路径/)
  assert.doesNotMatch(text, /授权与策略/, 'grants and policy are not rendered')

  // Only calls made by opening the detail: the list's own policy read predates it.
  const detailCalls = page.calls().slice(listCallCount)
  assert.equal(
    detailCalls.some((call) => /^GET \/v1\/projects\/[^/]+\/grants$/.test(call)),
    false,
    'archived detail never requests project grants'
  )
  assert.equal(
    detailCalls.some((call) => call.startsWith('GET /v1/policies/download')),
    false,
    'archived detail never requests the download policy'
  )
  assert.equal(
    detailCalls.some((call) => /^GET \/v1\/hosts\/[^/]+\/grants$/.test(call)),
    false,
    'archived detail never requests host grants'
  )
  assert.deepEqual(
    detailCalls.filter((call) => call.startsWith(`GET /v1/projects/${archivedId}`)),
    [`GET /v1/projects/${archivedId}?includeArchived=1`],
    'exactly one opt-in read'
  )
})

test('W5-2 旧平台 404：明确“不支持归档详情”，保留返回按钮与列表摘要', async () => {
  const page = loadWebConsolePage(service.url, { hash: `#/projects/${archivedId}` })
  await page.settle()
  page.fail('GET', `/v1/projects/${archivedId}?includeArchived=1`, {
    status: 404,
    body: { error: { code: 'PROJECT_NOT_FOUND', message: '项目不存在或无权访问。' } }
  })
  await page.submitLogin('admin', 'Adm1n!')

  const note = banner(page)
  assert.ok(note, 'fallback keeps the banner slot')
  assert.match(note.textContent ?? '', /当前平台不支持归档详情/)
  assert.doesNotMatch(note.textContent ?? '', /未能刷新项目信息/, 'not reported as a read failure')
  assert.ok(
    doc(page).querySelector('.dialog-sheet-close'),
    'the sheet back button remains reachable'
  )
  assert.match(
    doc(page).querySelector('.dialog .body')?.textContent ?? '',
    /基本信息/,
    'the cached list summary stays visible'
  )
  page.clearFails()
})

test('W5-3 详情页脚恢复：确认后关闭详情并回到在营列表', async () => {
  const page = await openArchivedDetail(restoreId)
  const restore = [...doc(page).querySelectorAll<HTMLButtonElement>('.dialog .foot button')].find(
    (button) => button.textContent === '恢复项目'
  )
  assert.ok(restore, 'precondition: archived detail footer has 恢复项目')
  restore.click()
  await page.settle()
  const confirm = [...doc(page).querySelectorAll<HTMLElement>('.dialog-backdrop')].at(-1)!
  confirm.querySelector<HTMLButtonElement>('[data-action="1"]')!.click()
  await page.settle()

  assert.equal(
    doc(page).querySelectorAll('.dialog-backdrop').length,
    0,
    'restore closes the detail and its confirm card'
  )
  assert.deepEqual(
    page.calls().filter((call) => /^POST \/v1\/projects\/[^/]+\/restore$/.test(call)),
    [`POST /v1/projects/${restoreId}/restore`]
  )
  assert.ok(
    [...doc(page).querySelectorAll<HTMLElement>('.toast')].some((toast) =>
      toast.textContent?.includes('已恢复')
    ),
    'restore toasts'
  )
  assert.equal(page.window.location.hash.includes(restoreId), false, 'detail route is left')
  assert.ok(
    [...doc(page).querySelectorAll<HTMLElement>('#projectTableWrap tbody tr')].some((row) =>
      row.textContent?.includes('w5-restore')
    ),
    'the restored project is back in the live list'
  )
})

test('W5-4 非 admin 深链归档 id：不泄露、不请求 includeArchived', async () => {
  const page = loadWebConsolePage(service.url, { hash: `#/projects/${archivedId}` })
  await page.settle()
  await page.submitLogin('zhangsan', 'Passw0rd!')

  assert.equal(banner(page), null, 'no archived banner for a non-admin')
  assert.equal(
    doc(page).querySelector('.forbidden h1')?.textContent,
    '无权访问',
    'existing forbidden semantics are kept'
  )
  assert.equal(
    page.calls().some((call) => call.includes('includeArchived=1')),
    false,
    'a non-admin never asks for archived rows'
  )
})

test('W5-5 390：归档详情为全屏 sheet，横幅可读且不溢出', async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  await page.goto(`${service.url}/#/projects/${archivedId}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#loginForm', { state: 'visible' })
  await page.fill('#username', 'admin')
  await page.fill('#password', 'Adm1n!')
  await page.click('#loginBtn')
  await page.waitForSelector('.dialog-backdrop.dialog-sheet')
  await page.waitForSelector('[data-archived-banner]')

  const metrics = await page.evaluate(() => {
    const backdrop = document.querySelector<HTMLElement>('.dialog-backdrop.dialog-sheet')!
    const dialog = backdrop.querySelector<HTMLElement>('.dialog')!
    const note = document.querySelector<HTMLElement>('[data-archived-banner]')!
    const rect = note.getBoundingClientRect()
    return {
      backdropPosition: getComputedStyle(backdrop).position,
      dialogWidth: dialog.getBoundingClientRect().width,
      dialogHeight: dialog.getBoundingClientRect().height,
      noteRight: rect.right,
      noteWidth: rect.width,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      noteText: note.textContent ?? ''
    }
  })
  assert.equal(metrics.backdropPosition, 'fixed', 'sheet covers the viewport')
  assert.equal(Math.round(metrics.dialogWidth), 390, 'sheet is full width')
  assert.ok(metrics.dialogHeight >= 800, 'sheet is full height')
  assert.ok(metrics.noteRight <= 390, 'banner stays inside the viewport')
  assert.ok(metrics.noteWidth > 300, 'banner keeps a readable line length')
  assert.ok(metrics.overflow <= 1, 'no horizontal overflow at 390px')
  assert.match(metrics.noteText, /该项目已归档，仅供查看/)
  await page.screenshot({
    path: join(evidenceDir('u116-w5'), '390-archived-detail.png')
  })
  await context.close()
})
