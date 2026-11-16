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
}, 120_000)

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
  assert.ok(rowContaining(page, 'w2-live'), 'the live row stays in 我的项目')
  assert.equal(
    rowContaining(page, 'w2-archived'),
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
    rowContaining(page, 'w2-archived'),
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
        { ...base, id: 'proj_prep', key: 'w2-prep', name: 'w2-prep', status: 'provisioning', path: '/srv/w2-prep' },
        { ...base, id: 'proj_failed', key: 'w2-failed', name: 'w2-failed', status: 'failed', path: '/srv/w2-failed' }
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
