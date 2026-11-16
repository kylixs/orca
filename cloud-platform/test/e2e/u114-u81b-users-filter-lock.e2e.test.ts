import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnService, type Service } from './harness.ts'
import { loadWebConsolePage, type WebConsolePage } from './web-console-page.ts'

/**
 * U114 D4 (audit B, U81b): two behaviours that until now held only by code
 * reading.
 *
 * 1. The query filter survives the role-change re-render (`userFilter` replay)
 *    and is re-applied to the fresh server rows.
 * 2. A disabled account's role control is locked (disabled + copy) and emits
 *    no write even if a change event is forced.
 */

const ADMIN = ['admin', 'Adm1n!'] as const

let service: Service

before(async () => {
  service = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN: 'u114-d4-internal-token' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-u114-d4'
  )
}, 120_000)

after(async () => {
  await service?.stop()
})

function element<T extends HTMLElement>(page: WebConsolePage, selector: string): T {
  const found = page.window.document.querySelector<T>(selector)
  if (!found) throw new Error(`missing ${selector}`)
  return found
}

const rows = (page: WebConsolePage) => [...page.window.document.querySelectorAll('#usersBody tr')]
const bodyText = (page: WebConsolePage) => element(page, '#usersBody').textContent ?? ''
const backdrops = (page: WebConsolePage) => [
  ...page.window.document.querySelectorAll<HTMLElement>('.dialog-backdrop')
]

function select(page: WebConsolePage, target: HTMLSelectElement, value: string): void {
  target.value = value
  target.dispatchEvent(new page.window.Event('change', { bubbles: true }))
}

test('D4-a 角色变更重绘后筛选保持，且行集按新角色重新判定', async () => {
  const listUrl = '#/users?query=zhang&status=active'
  const listPage = loadWebConsolePage(service.url, { hash: listUrl })
  await listPage.settle()
  await listPage.submitLogin(ADMIN[0], ADMIN[1])

  // Baseline: the query + status filter already excludes 李静/李四.
  assert.equal(rows(listPage).length, 1)
  assert.match(bodyText(listPage), /张伟/)
  assert.doesNotMatch(bodyText(listPage), /李静|李四/)
  const detailButton = element<HTMLButtonElement>(listPage, '#usersBody [data-user-detail]')
  const userId = detailButton.dataset.userDetail ?? ''
  assert.ok(userId, 'the row carries the user id')

  // Why deep link the detail: happy-dom fires a synthetic hashchange after the
  // list's pushState, which clears state.routeQuery before the change runs — an
  // artifact a real browser does not have. Loading the detail route with the
  // filter in its URL keeps the same filter-replay path (renderUsersPage reads
  // state.routeQuery) without relying on that polyfill difference.
  const page = loadWebConsolePage(service.url, {
    hash: `#/users/${userId}?query=zhang&status=active`
  })
  await page.settle()
  await page.submitLogin(ADMIN[0], ADMIN[1])
  assert.equal(backdrops(page).length, 1, 'the detail deep link opens the modal')

  // The filter is already replayed on the list behind the modal.
  assert.equal(element<HTMLInputElement>(page, '#userSearch').value, 'zhang')
  assert.equal(element<HTMLSelectElement>(page, '#userStatusFilter').value, 'active')

  const role = element<HTMLSelectElement>(page, '[data-detail-role]')
  assert.equal(role.value, 'developer')
  select(page, role, 'auditor')
  assert.equal(backdrops(page).length, 2, 'a change opens the confirm dialog')

  const confirm = backdrops(page)[backdrops(page).length - 1]
  assert.match(confirm.textContent ?? '', /张伟（zhangsan）：普通 → 审计/)
  confirm.querySelector<HTMLButtonElement>('[data-action="0"]')!.click()
  await page.settle()

  assert.ok(
    page.calls().includes(`PUT /v1/users/${userId}/roles`),
    `the confirm must PUT the role: ${page.calls().join(', ')}`
  )

  // The filter controls are replayed, and the re-fetched rows still honour them.
  assert.equal(element<HTMLInputElement>(page, '#userSearch').value, 'zhang')
  assert.equal(element<HTMLSelectElement>(page, '#userStatusFilter').value, 'active')
  assert.equal(element<HTMLSelectElement>(page, '#userRoleFilter').value, 'all')
  assert.equal(rows(page).length, 1, 'the filter still selects exactly one account')
  assert.match(bodyText(page), /张伟/)
  assert.match(bodyText(page), /审计/, 'the row shows the fresh role')
  assert.doesNotMatch(bodyText(page), /李静|李四/)
  assert.match(
    element(page, '#usersFoot').textContent ?? '',
    /共 \d+ 个账号 · 当前筛选 1 个/,
    'the header count still reflects the active filter'
  )

  // Changing the role filter now applies to the new value: auditor matches,
  // developer no longer does. This is the row-set half of the claim.
  const roleFilter = element<HTMLSelectElement>(page, '#userRoleFilter')
  select(page, roleFilter, 'auditor')
  await page.settle()
  assert.equal(rows(page).length, 1)
  assert.match(bodyText(page), /张伟/)
  assert.match(page.window.location.hash, /role=auditor/)

  select(page, roleFilter, 'developer')
  await page.settle()
  assert.equal(rows(page).length, 1)
  assert.equal(
    page.window.document.querySelector('#usersBody .table-empty') !== null,
    true,
    'the upgraded account drops out of the developer filter'
  )
})

test('D4-b 停用账号详情：角色控件 disabled + 锁定文案，强改不发写请求', async () => {
  // The directory has no disabled account; inject one at the page's fetch
  // boundary so the lock renders without touching product fixtures.
  const disabled = {
    id: 'usr_disabled_fixture',
    username: 'wangwu',
    displayName: '王五',
    dept: '支付研发部',
    groups: ['developers'],
    roles: ['platform:auditor'],
    status: 'disabled',
    role: 'auditor',
    roleSource: 'admin-override'
  }
  const active = {
    id: 'usr_active_fixture',
    username: 'zhaoliu',
    displayName: '赵六',
    dept: '平台工程部',
    groups: ['developers'],
    roles: ['developer'],
    status: 'active',
    role: 'developer',
    roleSource: 'ldap'
  }

  const page = loadWebConsolePage(service.url, { hash: '#/workbench' })
  await page.settle()
  await page.submitLogin(ADMIN[0], ADMIN[1])

  page.fail('GET', '/v1/users', { status: 200, body: { users: [active, disabled] } })
  await page.clickNav('users')

  assert.equal(rows(page).length, 2)
  element<HTMLButtonElement>(page, '[data-user-detail="usr_disabled_fixture"]').click()
  await page.settle()

  const role = element<HTMLSelectElement>(page, '[data-detail-role]')
  assert.equal(role.value, 'auditor')
  assert.equal(role.disabled, true, 'a disabled account cannot be re-roled')
  assert.match(
    element(page, '.dialog .kv').textContent ?? '',
    /已停用账号不可修改角色/,
    'the lock is explained next to the control'
  )

  // Even a forced change event is refused by the handler, not just the UI flag.
  select(page, role, 'admin')
  await page.settle()
  assert.equal(role.value, 'auditor', 'the control falls back to the stored role')
  assert.equal(backdrops(page).length, 1, 'no confirm dialog is raised')
  assert.equal(
    page.calls().some((call) => call.startsWith('PUT /v1/users/')),
    false,
    'no role write is issued'
  )
})
