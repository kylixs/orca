import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { login, registerHost, spawnService, type Service } from './harness.ts'
import { loadWebConsolePage, type WebConsolePage } from './web-console-page.ts'

/**
 * U106 R3 (D3): 项目 / 主机 / 用户详情是可深链的 URL 状态。
 * `#/projects/<id>?tab=info|perms`、`#/hosts/<id>?tab=…`、`#/users/<id>` 直接进入
 * 即打开既有弹框/抽屉；刷新保持；关闭回父路由；未知或不可见 id 按 404 语义；
 * 列表点击与 URL 双向同步，浏览器后退可关层。
 */

const ADMIN = ['admin', 'Adm1n!'] as const

let service: Service
let adminToken = ''
let projectId = ''
let hostId = ''
let userId = ''
let userName = ''

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${service.url}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${adminToken}`,
      ...init.headers
    }
  })
  const body = (await res.json().catch(() => ({}))) as T
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} failed: ${JSON.stringify(body)}`)
  return body
}

before(async () => {
  service = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN: 'u106-detail-internal-token' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-u106-detail'
  )
  adminToken = await login(service.url, ADMIN[0], ADMIN[1])
  const host = await registerHost({
    apiUrl: service.url,
    adminToken,
    name: 'r3-host',
    directAddr: '127.0.0.1:17011',
    relayTarget: '127.0.0.1:17011'
  })
  hostId = host.hostId
  const created = await api<{ id: string }>('/v1/projects', {
    method: 'POST',
    body: JSON.stringify({
      key: 'r3-project',
      name: 'r3-project',
      hostId,
      path: '/srv/work/r3-project'
    })
  })
  projectId = created.id
  const listed = await api<{ users: { id: string; username: string; displayName: string }[] }>(
    '/v1/users'
  )
  const target = listed.users.find((user) => user.username === 'zhangsan')
  assert.ok(target, 'the seeded developer must exist')
  userId = target.id
  userName = target.displayName
}, 120_000)

after(async () => {
  await service?.stop()
})

/** A fresh window on `hash` (this is what a reload of a deep link looks like). */
async function openDeepLink(hash: string): Promise<WebConsolePage> {
  const page = loadWebConsolePage(service.url, { hash })
  await page.settle()
  await page.submitLogin(ADMIN[0], ADMIN[1])
  return page
}

function dialog(page: WebConsolePage): HTMLElement | null {
  return page.window.document.querySelector<HTMLElement>('.dialog-backdrop')
}

test('R3 项目详情深链：直开、刷新保持、关闭回列表', async () => {
  const hash = `#/projects/${projectId}`
  const page = await openDeepLink(hash)
  assert.ok(dialog(page), 'a project deep link opens the detail dialog')
  assert.match(page.text('#crumbs'), /我的项目/)
  assert.equal(page.window.location.hash, hash, 'the deep link stays canonical')
  assert.equal(
    (dialog(page)!.querySelector('[data-auth-tab="info"]') as HTMLElement).classList.contains(
      'active'
    ),
    true,
    'info is the default tab'
  )

  // Reload: a second window on the same hash still opens the dialog.
  const reloaded = await openDeepLink(hash)
  assert.ok(dialog(reloaded), 'a reload of the deep link reopens the dialog')
  assert.equal(reloaded.window.location.hash, hash)

  ;(dialog(reloaded)!.querySelector('[data-action="close"]') as HTMLElement).click()
  await reloaded.settle()
  assert.equal(dialog(reloaded), null, 'closing removes the dialog')
  assert.equal(reloaded.window.location.hash, '#/projects', 'a direct deep link closes to its list')
  assert.match(reloaded.text('#content'), /我的项目/)
})

test('R3 项目权限页签：?tab=perms 直开并保持；页签切换写回 URL', async () => {
  const hash = `#/projects/${projectId}?tab=perms`
  const page = await openDeepLink(hash)
  assert.ok(dialog(page), 'the permission deep link opens the dialog')
  assert.equal(page.window.location.hash, hash, 'the query survives the login view and render')
  assert.equal(
    (dialog(page)!.querySelector('[data-auth-tab="perms"]') as HTMLElement).classList.contains(
      'active'
    ),
    true,
    'tab=perms selects the permission tab'
  )
  assert.equal(
    (dialog(page)!.querySelector('[data-auth-panel="perms"]') as HTMLElement).hidden,
    false
  )
  assert.equal(
    (dialog(page)!.querySelector('[data-auth-panel="info"]') as HTMLElement).hidden,
    true
  )

  ;(dialog(page)!.querySelector('[data-auth-tab="info"]') as HTMLElement).click()
  assert.equal(page.window.location.hash, `#/projects/${projectId}`, 'switching back drops tab')
  ;(dialog(page)!.querySelector('[data-auth-tab="perms"]') as HTMLElement).click()
  assert.equal(page.window.location.hash, hash, 'switching to perms restores the query')
})

test('R3 主机详情深链：抽屉直开、刷新保持、关闭回主机列表', async () => {
  const hash = `#/hosts/${hostId}`
  const page = await openDeepLink(hash)
  const drawer = page.window.document.querySelector<HTMLElement>('.drawer-backdrop')
  assert.ok(drawer, 'a host deep link opens the drawer')
  assert.match(drawer!.textContent ?? '', /r3-host/)
  assert.equal(page.window.location.hash, hash)
  assert.equal(
    (drawer!.querySelector('[data-auth-tab="info"]') as HTMLElement).classList.contains('active'),
    true
  )

  const reloaded = await openDeepLink(hash)
  assert.ok(
    reloaded.window.document.querySelector<HTMLElement>('.drawer-backdrop'),
    'a reload reopens the drawer'
  )

  reloaded.window.document.querySelector<HTMLElement>('.drawer-backdrop .icon-btn')!.click()
  await reloaded.settle()
  assert.equal(reloaded.window.document.querySelector('.drawer-backdrop'), null)
  assert.equal(reloaded.window.location.hash, '#/hosts', 'a direct deep link closes to its list')
})

test('R3 主机权限深链：?tab=perms 选中权限页签', async () => {
  const page = await openDeepLink(`#/hosts/${hostId}?tab=perms`)
  const drawer = page.window.document.querySelector<HTMLElement>('.drawer-backdrop')
  assert.ok(drawer, 'the permission deep link opens the drawer')
  assert.equal(
    (drawer!.querySelector('[data-auth-tab="perms"]') as HTMLElement).classList.contains('active'),
    true
  )
  assert.equal((drawer!.querySelector('[data-auth-panel="perms"]') as HTMLElement).hidden, false)
  assert.equal(page.window.location.hash, `#/hosts/${hostId}?tab=perms`)
})

test('R3 用户详情深链：直开、刷新保持、关闭回用户列表', async () => {
  const hash = `#/users/${userId}`
  const page = await openDeepLink(hash)
  assert.ok(dialog(page), 'a user deep link opens the detail dialog')
  assert.match(dialog(page)!.textContent ?? '', new RegExp(userName))
  assert.equal(page.window.location.hash, hash)

  const reloaded = await openDeepLink(hash)
  assert.ok(dialog(reloaded), 'a reload reopens the dialog')

  ;(dialog(reloaded)!.querySelector('[data-action="close"]') as HTMLElement).click()
  await reloaded.settle()
  assert.equal(dialog(reloaded), null)
  assert.equal(reloaded.window.location.hash, '#/users', 'a direct deep link closes to its list')
})

test('R3 非管理员项目详情深链：403 保留 URL、不打开弹框（Q5/T5）', async () => {
  const hash = `#/projects/${projectId}`
  const page = loadWebConsolePage(service.url, { hash })
  await page.settle()
  await page.submitLogin('zhangsan', 'Passw0rd!')
  assert.equal(page.text('#crumbs'), '无权访问')
  assert.match(page.text('#content'), /没有平台管理权限/)
  assert.equal(dialog(page), null, 'a developer never reaches the admin detail dialog')
  assert.equal(page.window.location.hash, hash, 'the refused URL stays in the address bar')
})

test('R3 未知/不可见 id：404 语义、不打开弹框、保留 URL', async () => {
  const cases = [
    { hash: '#/projects/proj_missing', noun: '项目' },
    { hash: '#/hosts/host_missing', noun: '主机' },
    { hash: '#/users/user_missing', noun: '用户' }
  ]
  for (const item of cases) {
    const page = await openDeepLink(item.hash)
    assert.equal(dialog(page), null, `${item.hash} must not open a dialog`)
    assert.equal(
      page.window.document.querySelector('.drawer-backdrop'),
      null,
      `${item.hash} must not open a drawer`
    )
    assert.match(page.text('#content'), /页面不存在/)
    assert.match(page.text('#content'), new RegExp(item.noun))
    assert.equal(page.window.location.hash, item.hash, 'the unknown id URL is preserved')
  }
})

test('R3 列表点击与 URL 互操作：push 详情、浏览器后退关层', async () => {
  const page = loadWebConsolePage(service.url)
  await page.settle()
  await page.submitLogin(ADMIN[0], ADMIN[1])
  await page.clickNav('projects')

  const button = page.window.document.querySelector<HTMLButtonElement>('[data-detail]')
  assert.ok(button, 'the projects list carries 详情')
  const id = button!.dataset.detail
  button!.click()
  await page.settle()

  assert.ok(dialog(page), 'clicking 详情 opens the dialog')
  assert.equal(page.window.location.hash, `#/projects/${id}`, 'the row click syncs the URL')

  page.window.history.back()
  await page.settle()
  assert.equal(dialog(page), null, 'browser back closes the dialog')
  assert.equal(page.window.location.hash, '#/projects', 'back returns to the list route')
  assert.ok(
    page.window.document.querySelector('[data-detail]'),
    'the list is rendered again after back'
  )
})
