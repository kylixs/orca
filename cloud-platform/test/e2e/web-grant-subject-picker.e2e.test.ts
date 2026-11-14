import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { login, saveEvidence, spawnService, type Service } from './harness.ts'
import { loadWebConsolePage, type WebConsolePage } from './web-console-page.ts'

/**
 * AA4 (admin-authorization design §A4): the grant matrix's subject input becomes
 * a directory-backed picker, driven through the real console files against a
 * real platform process.
 *
 * - an admin opening the matrix reads GET /v1/directory once and gets two
 *   datalists: users submit their username (display name + dept as the hint),
 *   groups submit the exact group name
 * - switching 类型 swaps which datalist the single input offers
 * - an unknown group is refused with the design's explicit toast and the typed
 *   input survives; the matrix is untouched
 * - a non-admin never requests the directory (the route guard already returns
 *   the forbidden page, and the directory read is admin-only server-side)
 */

const EVIDENCE = 'aa4-subject-picker'
const PROJECT = 'proj_payment'
const GRANTS_PATH = `/v1/projects/${PROJECT}/grants`

let service: Service
let adminToken = ''
const cases: Record<string, string> = {}

type GrantRow = { subjectType: string; subjectId: string; username?: string; permissions: string[] }

async function api(
  path: string,
  init: RequestInit & { token?: string } = {}
  // oxlint-disable-next-line typescript/no-explicit-any -- same assert-driven shape as web-permission-matrix.e2e.test.ts
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${service.url}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${init.token ?? adminToken}`,
      ...init.headers
    },
    body: init.body
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

async function grants(): Promise<GrantRow[]> {
  const res = await api(GRANTS_PATH)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  return res.body.grants
}

function lastToast(page: WebConsolePage): string {
  // Why the spread: happy-dom's NodeList has no `.at()` of its own.
  return [...page.window.document.querySelectorAll('.toast')].at(-1)?.textContent ?? ''
}

function directoryLoads(page: WebConsolePage): number {
  return page.calls().filter((call) => call === 'GET /v1/directory').length
}

function matrixLoads(page: WebConsolePage): number {
  return page.calls().filter((call) => call === `GET ${GRANTS_PATH}`).length
}

/** Logs in and opens the members page with the seeded project's matrix. */
async function openMembers(page: WebConsolePage, username: string, password: string): Promise<void> {
  await page.settle()
  await page.submitLogin(username, password)
  await page.clickNav('members')
  const button = [
    ...page.window.document.querySelectorAll<HTMLButtonElement>('[data-material]')
  ].find((candidate) => candidate.textContent === 'payment-service')
  assert.ok(button, 'the members page must list payment-service')
  button.click()
  await page.settle()
}

function optionValues(page: WebConsolePage, selector: string): string[] {
  return [
    ...page.window.document.querySelectorAll<HTMLOptionElement>(`${selector} option`)
  ].map((option) => option.value)
}

before(async () => {
  service = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN: 'aa4-internal-token' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-web-grant-subject-picker'
  )
  adminToken = await login(service.url, 'admin', 'Adm1n!')
}, 120_000)

after(async () => {
  await service?.stop()
  saveEvidence(EVIDENCE, 'subject-picker-summary.json', {
    workOrder: 'AA4 grant subject picker with directory',
    cases
  })
})

test('AA4-1 admin 打开矩阵：拉一次目录，用户/组 datalist 含种子数据且随类型切换', async () => {
  const page = loadWebConsolePage(service.url)
  await openMembers(page, 'admin', 'Adm1n!')

  assert.equal(directoryLoads(page), 1, 'opening the matrix reads the directory exactly once')

  const directory = await api('/v1/directory')
  assert.equal(directory.status, 200, JSON.stringify(directory.body))
  const seededUsers = (directory.body.users as { username: string }[]).map((user) => user.username)
  for (const username of ['admin', 'zhangsan']) {
    assert.ok(seededUsers.includes(username), `${username} must be seeded in the directory`)
  }

  const groups = optionValues(page, 'datalist#grantGroupOptions')
  assert.ok(groups.includes('team-payment'), 'the seeded group must be offered')
  assert.ok(groups.includes('developers'), 'a login user group must be offered')
  assert.ok(groups.includes('platform-admins'), 'the admin group must be offered')

  const users = optionValues(page, 'datalist#grantUserOptions')
  assert.deepEqual(users, seededUsers, 'user options submit usernames, not ids')
  const zhangsan = [
    ...page.window.document.querySelectorAll<HTMLOptionElement>(
      'datalist#grantUserOptions option'
    )
  ].find((option) => option.value === 'zhangsan')
  assert.ok(zhangsan, 'zhangsan must be pickable')
  assert.match(zhangsan.textContent ?? '', /张伟/, 'the hint carries the display name')
  assert.match(zhangsan.textContent ?? '', /支付研发部/, 'the hint carries the department')

  const input = page.window.document.querySelector<HTMLInputElement>('#grantSubject')!
  assert.equal(input.getAttribute('list'), 'grantGroupOptions', 'group is the default type')
  const type = page.window.document.querySelector<HTMLSelectElement>('#grantType')!
  type.value = 'user'
  type.dispatchEvent(new page.window.Event('change', { bubbles: true }))
  assert.equal(input.getAttribute('list'), 'grantUserOptions', 'user type swaps the datalist')
  type.value = 'group'
  type.dispatchEvent(new page.window.Event('change', { bubbles: true }))
  assert.equal(input.getAttribute('list'), 'grantGroupOptions', 'switching back restores groups')

  saveEvidence(EVIDENCE, 'datalists.json', {
    directoryLoads: directoryLoads(page),
    users,
    groups,
    userHint: zhangsan.textContent,
    defaultList: 'grantGroupOptions'
  })
  cases['admin-datalist'] = `目录 1 次；用户 ${users.length} 个（值=username，提示含显示名/部门），组 ${groups.length} 个`
}, 120_000)

test('AA4-2 未知组提交：GROUP_NOT_FOUND 明确 toast，输入保留，矩阵不变', async () => {
  const page = loadWebConsolePage(service.url)
  await openMembers(page, 'admin', 'Adm1n!')
  const before = await grants()
  const matrixBefore = matrixLoads(page)

  const input = page.window.document.querySelector<HTMLInputElement>('#grantSubject')!
  input.value = 'team-typo'
  page.window.document.querySelector<HTMLSelectElement>('#grantType')!.value = 'group'
  page.window.document.querySelector<HTMLButtonElement>('#grantAdd')!.click()
  await page.settle()

  const refusal = lastToast(page)
  assert.match(refusal, /授予失败/, 'the refusal must be reported')
  assert.match(
    refusal,
    /组不存在或平台未见过该组。/,
    'the design copy must be shown for GROUP_NOT_FOUND'
  )
  assert.equal(input.value, 'team-typo', 'the typed subject must survive the refusal')
  assert.equal(matrixLoads(page), matrixBefore, 'a refused grant must not redraw the matrix')
  assert.deepEqual(await grants(), before, 'a refused group must store no dead row')

  saveEvidence(EVIDENCE, 'group-not-found.json', {
    toast: refusal,
    inputValue: input.value,
    matrixLoads: matrixLoads(page),
    storedGrants: before
  })
  cases['unknown-group'] = '未知组 → toast「授予失败：组不存在或平台未见过该组。」，输入保留，矩阵 0 刷新，服务端 0 死行'
}, 120_000)

test('AA4-3 非 admin：成员路由直接 403 页面，零目录请求', async () => {
  const page = loadWebConsolePage(service.url)
  await page.settle()
  await page.submitLogin('zhangsan', 'Passw0rd!')
  await page.clickNav('members')

  assert.match(page.text('#content'), /无权访问/, 'the admin route must render the forbidden page')
  assert.equal(directoryLoads(page), 0, 'a non-admin must never request the directory')
  assert.equal(
    page.calls().some((call) => call === `GET ${GRANTS_PATH}`),
    false,
    'the forbidden page must not touch the matrix either'
  )

  saveEvidence(EVIDENCE, 'non-admin-calls.json', {
    directoryLoads: directoryLoads(page),
    calls: page.calls()
  })
  cases['non-admin'] = 'developer 进入成员 → 无权访问页面，GET /v1/directory 0 次'
}, 120_000)
