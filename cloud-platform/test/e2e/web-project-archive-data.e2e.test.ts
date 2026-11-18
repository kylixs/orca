import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { login, registerHost, spawnService, type Service } from './harness.ts'
import { loadWebConsolePage, type WebConsolePage } from './web-console-page.ts'

/**
 * U116① W2: the console data layer keeps archived projects out of every live
 * view, but an admin can still resolve one directly by URL.
 *
 * - the workbench never requests includeArchived; the admin project page asks once
 * - the live list excludes archived rows even when a stale payload contains one
 * - the admin deep link `#/projects/<archivedId>` opens the detail dialog through
 *   `GET /v1/projects/<id>?includeArchived=1`
 * - a developer sends no includeArchived and keeps the existing 403/404 semantics
 * - provisioning/failed rows are disabled with an explicit reason (design T5)
 */

let service: Service
let adminToken = ''
let hostId = ''
let liveId = ''
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

async function createProject(key: string): Promise<string> {
  const created = await adminApi('/v1/projects', {
    method: 'POST',
    body: JSON.stringify({ key, name: key, hostId, path: `/srv/work/${key}` })
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  return (created.body as { id: string }).id
}

before(async () => {
  service = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN: 'u116-w2-token' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-u116-w2'
  )
  adminToken = await login(service.url, 'admin', 'Adm1n!')
  const host = await registerHost({
    apiUrl: service.url,
    adminToken,
    name: 'u116-w2-host',
    directAddr: '127.0.0.1:17116',
    relayTarget: '127.0.0.1:17116'
  })
  hostId = host.hostId
  liveId = await createProject('w2-live')
  archivedId = await createProject('w2-archived')
  const archived = await adminApi(`/v1/projects/${archivedId}/archive`, { method: 'POST' })
  assert.equal(archived.status, 200, JSON.stringify(archived.body))
}, { timeout: 120_000 })

after(async () => {
  await service?.stop()
})

function dialog(page: WebConsolePage): HTMLElement | null {
  return page.window.document.querySelector<HTMLElement>('.dialog-backdrop')
}

function rowContaining(page: WebConsolePage, text: string): HTMLElement | undefined {
  return [...page.window.document.querySelectorAll<HTMLElement>('#content tbody tr')].find((row) =>
    row.textContent?.includes(text)
  )
}

/** Live-table row on 我的项目, excluding the archived history group. */
function liveRowContaining(page: WebConsolePage, text: string): HTMLElement | undefined {
  return [...page.window.document.querySelectorAll<HTMLElement>('#projectTableWrap tbody tr')].find(
    (row) => row.textContent?.includes(text)
  )
}

function archivedGroup(page: WebConsolePage): HTMLDetailsElement | null {
  return page.window.document.querySelector<HTMLDetailsElement>('.archived-group')
}

function archivedRows(page: WebConsolePage, text: string): HTMLElement[] {
  const group = archivedGroup(page)
  if (!group) return []
  return [...group.querySelectorAll<HTMLElement>('tbody tr')].filter((row) =>
    row.textContent?.includes(text)
  )
}

function projectChip(page: WebConsolePage, filter: string): HTMLButtonElement | null {
  return page.window.document.querySelector<HTMLButtonElement>(
    `#projectChips [data-project-filter="${filter}"]`
  )
}

async function searchProjects(page: WebConsolePage, value: string): Promise<void> {
  const input = page.window.document.querySelector<HTMLInputElement>('#projectSearch')!
  input.value = value
  input.dispatchEvent(new page.window.Event('input', { bubbles: true }))
  await page.settle()
}

test('W2-1 admin 项目页请求 includeArchived，工作台不请求，归档不进在营列表', async () => {
  const page = loadWebConsolePage(service.url)
  await page.settle()
  await page.submitLogin('admin', 'Adm1n!')
  assert.equal(
    page.calls().some((call) => call.includes('includeArchived=1')),
    false,
    'the workbench must never ask for archived rows'
  )
  assert.ok(rowContaining(page, 'w2-live'), 'precondition: the live project is on the workbench')

  await page.clickNav('projects')
  assert.equal(
    page.calls().filter((call) => call === 'GET /v1/projects?includeArchived=1').length,
    1,
    'the admin project page asks for the archive exactly once'
  )
  assert.ok(liveRowContaining(page, 'w2-live'), 'the live row stays in 我的项目')
  assert.equal(
    liveRowContaining(page, 'w2-archived'),
    undefined,
    'archived projects stay out of the live list (group UI is W3)'
  )
  assert.equal(
    page.calls().some((call) => call === `GET /v1/projects/${archivedId}`),
    false,
    'the live table does not fetch archived detail'
  )
})

test('W2-2 admin 直达归档项目 URL 可解析（数据层/路由，无 UI 入口）', async () => {
  const hash = `#/projects/${archivedId}`
  const page = loadWebConsolePage(service.url, { hash })
  await page.settle()
  await page.submitLogin('admin', 'Adm1n!')

  assert.ok(dialog(page), 'the archived deep link opens the detail dialog')
  assert.equal(page.text('#crumbs'), '我的项目')
  assert.doesNotMatch(page.text('#content'), /页面不存在/)
  assert.match(dialog(page)!.textContent ?? '', /w2-archived/)
  assert.ok(
    page.calls().includes(`GET /v1/projects/${archivedId}?includeArchived=1`),
    'the detail read opts into the archived row'
  )
  assert.equal(
    liveRowContaining(page, 'w2-archived'),
    undefined,
    'resolving the archive does not put it back into the live table'
  )
})

test('W2-3 非 admin 从不请求 includeArchived，归档深链维持 403', async () => {
  const page = loadWebConsolePage(service.url)
  await page.settle()
  await page.submitLogin('zhangsan', 'Passw0rd!')
  await page.clickNav('projects')
  assert.equal(
    page.calls().some((call) => call.includes('includeArchived=1')),
    false,
    'a developer console never asks for archived rows'
  )
  assert.equal(projectChip(page, 'archived'), null, 'a developer sees no 已归档 chip')
  assert.equal(archivedGroup(page), null, 'a developer sees no archived group')

  const deepLink = loadWebConsolePage(service.url, { hash: `#/projects/${archivedId}` })
  await deepLink.settle()
  await deepLink.submitLogin('zhangsan', 'Passw0rd!')
  assert.equal(dialog(deepLink), null, 'a developer deep link never opens the admin dialog')
  assert.equal(deepLink.text('#crumbs'), '无权访问')
  assert.equal(
    deepLink.calls().some((call) => call.includes('includeArchived=1')),
    false,
    'the existing 403 path sends no archive query'
  )
})

test('W3-1 admin 归档分组默认折叠、计数与 chip，归档行只留详情', async () => {
  const page = loadWebConsolePage(service.url)
  await page.settle()
  await page.submitLogin('admin', 'Adm1n!')
  await page.clickNav('projects')

  const group = archivedGroup(page)
  assert.ok(group, 'admin sees the archived history group')
  assert.equal(group.open, false, 'the history group starts folded')
  assert.match(group.querySelector('summary')?.textContent ?? '', /已归档项目（1）/)

  const chip = projectChip(page, 'archived')
  assert.ok(chip, 'the archive filter chip exists when history is non-empty')
  assert.match(chip.textContent ?? '', /已归档 1/)

  assert.ok(liveRowContaining(page, 'w2-live'), 'live rows stay in the live table')
  assert.equal(
    liveRowContaining(page, 'w2-archived'),
    undefined,
    'archived rows never enter the live table'
  )

  const [archivedRow] = archivedRows(page, 'w2-archived')
  assert.ok(archivedRow, 'the archived row lives inside the history group')
  assert.match(archivedRow.textContent ?? '', /已归档/)
  assert.equal(
    archivedRow.querySelector('[data-open]'),
    null,
    'archived rows expose no workspace entry'
  )
  assert.ok(archivedRow.querySelector('[data-detail]'), 'archived rows keep 详情 only')

  const archivedCard = group.querySelector<HTMLElement>('.project-list-card')
  assert.ok(archivedCard, 'the same card renderer carries the archive on mobile')
  assert.match(archivedCard.textContent ?? '', /已归档/)
  assert.equal(
    archivedCard.querySelector('[data-open]'),
    null,
    'archived cards expose no 打开工作区'
  )
  assert.ok(archivedCard.querySelector('[data-detail]'))
})

test('W3-2 已归档 chip 只看归档，与在营 chip 互斥', async () => {
  const page = loadWebConsolePage(service.url)
  await page.settle()
  await page.submitLogin('admin', 'Adm1n!')
  await page.clickNav('projects')

  projectChip(page, 'archived')!.click()
  await page.settle()

  assert.equal(page.hidden('#projectTableWrap'), true, 'live table hides in archive view')
  assert.equal(page.hidden('#projectList'), true, 'live cards hide in archive view')
  const group = archivedGroup(page)
  assert.ok(group, 'archive view keeps the history group')
  assert.equal(group.open, true, 'archive view expands the group')
  assert.ok(archivedRows(page, 'w2-archived').length > 0, 'the archived row is visible')
  assert.equal(
    archivedRows(page, 'w2-live').length,
    0,
    'live rows stay out of the archive-only view'
  )
  assert.equal(
    page.window.document.querySelectorAll('#projectList .project-list-card').length,
    0,
    'no live card leaks into the archive view'
  )

  projectChip(page, 'online')!.click()
  await page.settle()

  assert.equal(archivedGroup(page), null, '仅在线 hides the history group')
  assert.equal(page.hidden('#projectTableWrap'), false, 'the live table returns')
  assert.ok(liveRowContaining(page, 'w2-live'))
})

test('W3-3 搜索同时过滤归档分组，计数按过滤后数量', async () => {
  const page = loadWebConsolePage(service.url)
  await page.settle()
  await page.submitLogin('admin', 'Adm1n!')
  await page.clickNav('projects')

  await searchProjects(page, 'w2-archived')
  let group = archivedGroup(page)
  assert.ok(group, 'a matching archive keeps the group')
  assert.match(group.querySelector('summary')?.textContent ?? '', /已归档项目（1）/)
  assert.ok(archivedRows(page, 'w2-archived').length > 0)
  assert.match(page.text('#projectBody'), /没有匹配的项目/, 'live rows filter with the same query')

  await searchProjects(page, 'w2-live')
  group = archivedGroup(page)
  assert.equal(group, null, 'a query that misses history hides the group')
  assert.ok(liveRowContaining(page, 'w2-live'), 'the live row still matches')

  await searchProjects(page, 'w2-archived')
  projectChip(page, 'archived')!.click()
  await page.settle()
  assert.ok(archivedRows(page, 'w2-archived').length > 0, 'archive chip keeps the query filter')
})

test('W3-4 没有归档项目时不渲染分组与 chip', async () => {
  const listing = await adminApi('/v1/projects?includeArchived=1')
  const live = listing.body.projects.filter((p: { status: string }) => p.status !== 'archived')
  const page = loadWebConsolePage(service.url)
  await page.settle()
  await page.submitLogin('admin', 'Adm1n!')
  page.fail('GET', '/v1/projects?includeArchived=1', {
    status: 200,
    body: { projects: live }
  })
  await page.clickNav('projects')

  assert.equal(archivedGroup(page), null, 'an empty history renders no group')
  assert.equal(projectChip(page, 'archived'), null, 'an empty history renders no 已归档 chip')
  page.clearFails()
})

test('W2-4 准备中/准备失败的行禁用打开并给出因由', async () => {
  const page = loadWebConsolePage(service.url)
  await page.settle()
  await page.submitLogin('admin', 'Adm1n!')

  const base = {
    hostStatus: 'online',
    permissions: ['open'],
    defaultBranch: 'main',
    repoUrl: '',
    createdAt: Date.now(),
    downloadPolicy: 'allow',
    downloadPolicyExplicit: false
  }
  page.fail('GET', '/v1/projects', {
    status: 200,
    body: {
      projects: [
        {
          ...base,
          id: 'proj_prep',
          key: 'w2-prep',
          name: 'w2-prep',
          status: 'provisioning',
          path: '/srv/w2-prep'
        },
        {
          ...base,
          id: 'proj_failed',
          key: 'w2-failed',
          name: 'w2-failed',
          status: 'failed',
          path: '/srv/w2-failed'
        }
      ]
    }
  })
  await page.clickNav('workbench')

  const prep = rowContaining(page, 'w2-prep')!.querySelector<HTMLButtonElement>('[data-open]')!
  assert.equal(prep.disabled, true, 'provisioning cannot open')
  assert.equal(prep.title, '项目准备中，暂时无法打开')

  const failed = rowContaining(page, 'w2-failed')!.querySelector<HTMLButtonElement>('[data-open]')!
  assert.equal(failed.disabled, true, 'failed cannot open')
  assert.equal(failed.title, '项目准备失败')
  page.clearFails()
})
