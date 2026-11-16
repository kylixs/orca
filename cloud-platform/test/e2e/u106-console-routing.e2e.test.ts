import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnService, type Service } from './harness.ts'
import { loadWebConsolePage } from './web-console-page.ts'

/**
 * U106 (C1/C4/C5/C6/C8): the console's URL is the recovery carrier. A deep link
 * must survive a reload, login must return to the requested page, an admin-only
 * route must keep its URL while rendering 403, and an unknown route must render
 * a visible 404 instead of silently falling back to the workbench.
 */

const ADMIN = ['admin', 'Adm1n!'] as const
const DEVELOPER = ['zhangsan', 'Passw0rd!'] as const

let service: Service

before(async () => {
  service = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN: 'u106-internal-token' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-u106-routing'
  )
}, 120_000)

after(async () => {
  await service?.stop()
})

test('静态清单：router/routes.js 随发布提供，哈希与旧路径都可取', async () => {
  const release = (await (await fetch(`${service.url}/v1/web/release`)).json()) as {
    assets: Record<string, { path: string }>
  }
  const asset = release.assets['router/routes.js']
  assert.ok(asset, 'the release must ship the router module')
  assert.equal(asset.path.includes('/router/routes.js'), true)

  const hashed = await fetch(`${service.url}${asset.path}`)
  assert.equal(hashed.status, 200, 'app.js is served hashed, so its relative import must resolve')
  assert.match(await hashed.text(), /export function parseHash/)

  const legacy = await fetch(`${service.url}/router/routes.js`)
  assert.equal(legacy.status, 200, 'the unhashed path keeps working too')
})

test('C1/C4 深链刷新：projects/hosts/audit 登录后回到原 URL 与页面', async () => {
  const cases = [
    { hash: '#/projects', crumbs: '我的项目' },
    { hash: '#/hosts', crumbs: '平台设置 / 主机' },
    { hash: '#/audit', crumbs: '审计日志' }
  ]
  for (const item of cases) {
    const page = loadWebConsolePage(service.url, { hash: item.hash })
    await page.settle()
    assert.equal(page.hidden('#view-login'), false, 'a deep link without a session shows login')
    assert.equal(
      page.window.location.hash,
      item.hash,
      'the requested hash must survive the login view'
    )

    await page.submitLogin(ADMIN[0], ADMIN[1])
    assert.equal(page.hidden('#view-app'), false)
    assert.equal(page.window.location.hash, item.hash, `${item.hash} must stay in the URL`)
    assert.equal(page.text('#crumbs'), item.crumbs)
  }
})

test('C6 未知路由保留 URL 并渲染 404，返回工作台恢复默认路由', async () => {
  const page = loadWebConsolePage(service.url, { hash: '#/members' })
  await page.settle()
  await page.submitLogin(ADMIN[0], ADMIN[1])

  assert.equal(page.text('#crumbs'), '页面不存在')
  assert.match(page.text('#content'), /页面不存在/)
  assert.match(page.text('#content'), /返回工作台/)
  assert.equal(page.window.location.hash, '#/members', 'an unknown URL is never rewritten (D5)')

  page.window.document.querySelector<HTMLButtonElement>('#backToWorkbench')?.click()
  await page.settle()
  assert.equal(page.text('#crumbs'), '工作台')
  assert.equal(page.window.location.hash, '#/workbench')
})

test('C6 未知路由矩阵：已删页面/旧原型/畸形编码一律 404，且不回落工作台', async () => {
  const cases = [
    '#/members',
    '#/diagnostics',
    '#/project/payment-service',
    '#/projects/%E0%A4%A',
    '#/members/extra'
  ]
  for (const hash of cases) {
    const page = loadWebConsolePage(service.url, { hash })
    await page.settle()
    await page.submitLogin(ADMIN[0], ADMIN[1])

    assert.equal(page.text('#crumbs'), '页面不存在', `${hash} must render the 404 breadcrumb`)
    assert.match(page.text('#content'), /页面不存在/, `${hash} must render the 404 view`)
    assert.match(page.text('#content'), /返回工作台/)
    assert.ok(
      page.text('#content').includes(hash),
      `the 404 view must show the original hash (${hash})`
    )
    assert.equal(page.window.location.hash, hash, `${hash} must never be rewritten`)
    assert.equal(
      page.window.document.querySelectorAll('#content table').length,
      0,
      `${hash} must not fall back to a list/workbench page`
    )
  }
})

test('C6/T5 403 与 404 不混用：无权管理路由 403，未知路由对同一非管理员 404', async () => {
  const forbidden = loadWebConsolePage(service.url, { hash: '#/hosts' })
  await forbidden.settle()
  await forbidden.submitLogin(DEVELOPER[0], DEVELOPER[1])
  assert.equal(forbidden.text('#crumbs'), '无权访问')
  assert.match(forbidden.text('#content'), /没有平台管理权限/)
  assert.equal(forbidden.window.location.hash, '#/hosts')

  const unknown = loadWebConsolePage(service.url, { hash: '#/members' })
  await unknown.settle()
  await unknown.submitLogin(DEVELOPER[0], DEVELOPER[1])
  assert.equal(unknown.text('#crumbs'), '页面不存在')
  assert.match(unknown.text('#content'), /页面不存在/)
  assert.doesNotMatch(unknown.text('#content'), /没有平台管理权限/)
  assert.equal(unknown.window.location.hash, '#/members')
})

test('C5/C8 登录回跳与 403：非管理员深链保留 URL，刷新后仍是 403', async () => {
  const page = loadWebConsolePage(service.url, { hash: '#/hosts' })
  await page.settle()
  assert.equal(page.window.location.hash, '#/hosts')

  await page.submitLogin(DEVELOPER[0], DEVELOPER[1])
  assert.equal(page.text('#crumbs'), '无权访问')
  assert.match(page.text('#content'), /没有平台管理权限/)
  assert.equal(page.window.location.hash, '#/hosts', 'the refused URL stays in the address bar')

  // Reloading the same deep link re-evaluates the session and stays 403 (D6).
  const reloaded = loadWebConsolePage(service.url, { hash: '#/hosts' })
  await reloaded.settle()
  await reloaded.submitLogin(DEVELOPER[0], DEVELOPER[1])
  assert.equal(reloaded.text('#crumbs'), '无权访问')
  assert.equal(reloaded.window.location.hash, '#/hosts')
})

test('C8 #/login 兼容入口登录后落到工作台；空 hash 规范化为 #/workbench', async () => {
  const loginPage = loadWebConsolePage(service.url, { hash: '#/login' })
  await loginPage.settle()
  assert.equal(loginPage.hidden('#view-login'), false)
  await loginPage.submitLogin(ADMIN[0], ADMIN[1])
  assert.equal(loginPage.text('#crumbs'), '工作台')
  assert.equal(loginPage.window.location.hash, '#/workbench')

  const rootPage = loadWebConsolePage(service.url)
  await rootPage.settle()
  await rootPage.submitLogin(ADMIN[0], ADMIN[1])
  assert.equal(rootPage.text('#crumbs'), '工作台')
  assert.equal(rootPage.window.location.hash, '#/workbench')
})
