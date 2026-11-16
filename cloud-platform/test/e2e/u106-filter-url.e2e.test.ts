import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnService, type Service } from './harness.ts'
import { loadWebConsolePage, type WebConsolePage } from './web-console-page.ts'

/**
 * U106 R5 (T7/C3) + U120: list filters are URL state (deep link, reload, reset),
 * and logout drops the protected deep link so a reload only reaches the login page.
 */

const ADMIN = ['admin', 'Adm1n!'] as const

let service: Service

before(async () => {
  service = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN: 'u106-filter-internal-token' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-u106-filter'
  )
}, 120_000)

after(async () => {
  await service?.stop()
})

/** A fresh window on `hash` (this is what a reload of a deep link looks like). */
async function openWithAdmin(hash: string): Promise<WebConsolePage> {
  const page = loadWebConsolePage(service.url, { hash })
  await page.settle()
  await page.submitLogin(ADMIN[0], ADMIN[1])
  return page
}

function element<T extends HTMLElement>(page: WebConsolePage, selector: string): T {
  const found = page.window.document.querySelector<T>(selector)
  if (!found) throw new Error(`missing ${selector}`)
  return found
}

test('C3 用户筛选深链：输入与选中值还原，刷新后行一致；重置清 query', async () => {
  const hash = '#/users?query=zhang&role=developer&status=active'
  const page = await openWithAdmin(hash)

  assert.equal(element<HTMLInputElement>(page, '#userSearch').value, 'zhang')
  assert.equal(element<HTMLSelectElement>(page, '#userRoleFilter').value, 'developer')
  assert.equal(element<HTMLSelectElement>(page, '#userStatusFilter').value, 'active')
  assert.match(page.text('#usersBody'), /张伟/)
  assert.doesNotMatch(page.text('#usersBody'), /李静|李四/, 'role/query filters exclude the others')
  assert.equal(page.window.location.hash, hash)

  // Reload: the same URL restores the same controls and rows.
  const reloaded = await openWithAdmin(hash)
  assert.equal(element<HTMLInputElement>(reloaded, '#userSearch').value, 'zhang')
  assert.match(reloaded.text('#usersBody'), /张伟/)
  assert.doesNotMatch(reloaded.text('#usersBody'), /李静|李四/)

  // Typing rewrites the URL without a reload (replaceState) and stays canonical.
  const search = element<HTMLInputElement>(reloaded, '#userSearch')
  search.value = ''
  search.dispatchEvent(new reloaded.window.Event('input', { bubbles: true }))
  await reloaded.settle()
  assert.equal(reloaded.text('#usersBody').includes('张伟'), true, 'the developer now matches')
  assert.equal(
    reloaded.window.location.hash,
    '#/users?role=developer&status=active',
    'typing writes the filter into the URL'
  )

  // Reset clears every condition and the query is gone.
  element<HTMLButtonElement>(reloaded, '#userFilterReset').click()
  await reloaded.settle()
  assert.equal(reloaded.window.location.hash, '#/users')
  assert.equal(element<HTMLInputElement>(reloaded, '#userSearch').value, '')
  assert.equal(element<HTMLSelectElement>(reloaded, '#userRoleFilter').value, 'all')
  assert.equal(element<HTMLSelectElement>(reloaded, '#userStatusFilter').value, 'all')
  assert.match(reloaded.text('#usersBody'), /李静/)
})

test('C3 项目搜索深链：q 还原并过滤；输入写 URL，清空移除 query', async () => {
  const page = await openWithAdmin('#/projects?q=payment')
  assert.equal(element<HTMLInputElement>(page, '#projectSearch').value, 'payment')
  assert.match(page.text('#projectBody'), /payment-service/)
  assert.equal(page.window.location.hash, '#/projects?q=payment')

  const reloaded = await openWithAdmin('#/projects?q=payment')
  assert.equal(element<HTMLInputElement>(reloaded, '#projectSearch').value, 'payment')
  assert.match(reloaded.text('#projectBody'), /payment-service/)

  const search = element<HTMLInputElement>(reloaded, '#projectSearch')
  search.value = 'no-such-project'
  search.dispatchEvent(new reloaded.window.Event('input', { bubbles: true }))
  await reloaded.settle()
  assert.equal(reloaded.window.location.hash, '#/projects?q=no-such-project')
  assert.match(reloaded.text('#projectBody'), /没有匹配的项目/)

  search.value = ''
  search.dispatchEvent(new reloaded.window.Event('input', { bubbles: true }))
  await reloaded.settle()
  assert.equal(reloaded.window.location.hash, '#/projects')
})

test('C3 审计筛选深链：控件与请求参数一致；查询 push 入 URL；清除还原', async () => {
  const hash = '#/audit?range=24&event=file_download&username=zhangsan&projectId=proj_payment'
  const page = await openWithAdmin(hash)

  assert.equal(element<HTMLSelectElement>(page, '#auditRange').value, '24')
  assert.equal(element<HTMLSelectElement>(page, '#auditType').value, 'file_download')
  assert.equal(element<HTMLInputElement>(page, '#auditActor').value, 'zhangsan')
  assert.equal(element<HTMLSelectElement>(page, '#auditProject').value, 'proj_payment')
  assert.equal(page.window.location.hash, hash)

  const query = page.calls().find((call) => call.startsWith('GET /v1/audit/events?'))
  assert.ok(query, 'the audit page queries the events endpoint')
  assert.match(query, /eventType=file_download/)
  assert.match(query, /username=zhangsan/)
  assert.match(query, /projectId=proj_payment/)
  assert.match(query, /since=/, 'the URL range drives the computed window')

  // Reload keeps the same request conditions.
  const reloaded = await openWithAdmin(hash)
  const reloadedQuery = reloaded.calls().find((call) => call.startsWith('GET /v1/audit/events?'))
  assert.ok(reloadedQuery)
  assert.match(reloadedQuery, /eventType=file_download/)
  assert.match(reloadedQuery, /username=zhangsan/)

  // Explicit 查询 pushes the edited conditions back into the URL.
  element<HTMLInputElement>(reloaded, '#auditKeyword').value = 'deploy'
  element<HTMLButtonElement>(reloaded, '#auditApply').click()
  await reloaded.settle()
  assert.equal(
    reloaded.window.location.hash,
    '#/audit?q=deploy&range=24&event=file_download&username=zhangsan&projectId=proj_payment'
  )

  // Reopen the pushed URL: the keyword is restored.
  const pushed = await openWithAdmin(reloaded.window.location.hash)
  assert.equal(element<HTMLInputElement>(pushed, '#auditKeyword').value, 'deploy')
  assert.equal(element<HTMLSelectElement>(pushed, '#auditType').value, 'file_download')

  // 清除 drops every condition, including the URL query.
  element<HTMLButtonElement>(pushed, '#auditReset').click()
  await pushed.settle()
  assert.equal(pushed.window.location.hash, '#/audit')
  assert.equal(element<HTMLInputElement>(pushed, '#auditKeyword').value, '')
  assert.equal(element<HTMLSelectElement>(pushed, '#auditType').value, '')
})

test('U120 登出清 hash：刷新只回登录页，再登录落工作台', async () => {
  const page = await openWithAdmin('#/users?query=zhang')
  assert.equal(page.text('#crumbs'), '用户管理')

  element<HTMLButtonElement>(page, '#logoutBtn').click()
  await page.settle()
  assert.equal(page.hidden('#view-login'), false, 'logout shows the login view')
  assert.equal(page.hidden('#view-app'), true)
  assert.equal(page.window.location.hash, '#/login', 'logout drops the protected deep link')

  // Reload after logout: the URL no longer restores any protected page.
  const reloaded = loadWebConsolePage(service.url, { hash: page.window.location.hash })
  await reloaded.settle()
  assert.equal(reloaded.hidden('#view-login'), false)
  assert.equal(reloaded.window.location.hash, '#/login')

  await reloaded.submitLogin(ADMIN[0], ADMIN[1])
  assert.equal(reloaded.text('#crumbs'), '工作台')
  assert.equal(reloaded.window.location.hash, '#/workbench')
})
