import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { login, saveEvidence, spawnService, type Service } from './harness.ts'
import { loadWebConsolePage, type WebConsolePage } from './web-console-page.ts'

/**
 * AA4 migrated to the U67 entry: the project detail dialog's permission tab is
 * the only project-grant surface, driven through the real console files against
 * a real platform process.
 *
 * - an admin opening the tab reads GET /v1/directory once and gets two
 *   datalists: users submit their username (display name + dept as the hint),
 *   groups submit the exact group name
 * - switching 类型 swaps which datalist the card input offers
 * - an unknown group is refused with the design's explicit toast and the typed
 *   input survives; the tab is untouched
 * - a non-admin has no 详情 entry at all (and never requests the directory)
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
  // oxlint-disable-next-line typescript/no-explicit-any -- same assert-driven shape as the U67 suites
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

function permTabLoads(page: WebConsolePage): number {
  return page.calls().filter((call) => call === `GET ${GRANTS_PATH}`).length
}

/** Logs in and opens the seeded project's permission tab in the detail dialog. */
async function openPermTab(
  page: WebConsolePage,
  username: string,
  password: string
): Promise<void> {
  await page.settle()
  await page.submitLogin(username, password)
  const detail = page.window.document.querySelector<HTMLButtonElement>('[data-detail]')
  assert.ok(detail, 'the admin workbench must carry a 详情 entry')
  detail.click()
  await page.settle()
  const tab = page.window.document.querySelector<HTMLButtonElement>(
    '.dialog-backdrop [data-auth-tab="perms"]'
  )
  assert.ok(tab, 'the detail dialog must offer the 权限 tab')
  tab.click()
  await page.settle()
}

function card(page: WebConsolePage, key: string): HTMLElement {
  const found = page.window.document.querySelector<HTMLElement>(
    `[data-perm-cards] > [data-card="${key}"]`
  )
  assert.ok(found, `the permission tab must render the ${key} card`)
  return found
}

function optionValues(page: WebConsolePage, selector: string): string[] {
  return [...page.window.document.querySelectorAll<HTMLOptionElement>(`${selector} option`)].map(
    (option) => option.value
  )
}

before(async () => {
  service = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN: 'aa4-internal-token' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-web-grant-subject-picker'
  )
  adminToken = await login(service.url, 'admin', 'Adm1n!')
}, { timeout: 120_000 })

after(async () => {
  await service?.stop()
  saveEvidence(EVIDENCE, 'subject-picker-summary.json', {
    workOrder: 'AA4 grant subject picker (U67 permission tab entry)',
    cases
  })
})

test('AA4-1 admin 打开权限页签：拉一次目录，用户/组 datalist 含种子数据且随类型切换', { timeout: 120_000 }, async () => {
  const page = loadWebConsolePage(service.url)
  await openPermTab(page, 'admin', 'Adm1n!')

  assert.equal(directoryLoads(page), 1, 'opening the tab reads the directory exactly once')

  const directory = await api('/v1/directory')
  assert.equal(directory.status, 200, JSON.stringify(directory.body))
  const seededUsers = (directory.body.users as { username: string }[]).map((user) => user.username)
  for (const username of ['admin', 'zhangsan']) {
    assert.ok(seededUsers.includes(username), `${username} must be seeded in the directory`)
  }

  const groups = optionValues(page, 'datalist#projectGroupOptions')
  assert.ok(groups.includes('team-payment'), 'the seeded group must be offered')
  assert.ok(groups.includes('developers'), 'a login user group must be offered')
  assert.ok(groups.includes('platform-admins'), 'the admin group must be offered')

  const users = optionValues(page, 'datalist#projectUserOptions')
  assert.deepEqual(users, seededUsers, 'user options submit usernames, not ids')
  const zhangsan = [
    ...page.window.document.querySelectorAll<HTMLOptionElement>(
      'datalist#projectUserOptions option'
    )
  ].find((option) => option.value === 'zhangsan')
  assert.ok(zhangsan, 'zhangsan must be pickable')
  assert.match(zhangsan.textContent ?? '', /张伟/, 'the hint carries the display name')
  assert.match(zhangsan.textContent ?? '', /支付研发部/, 'the hint carries the department')

  const input = card(page, 'view').querySelector<HTMLInputElement>('[data-perm-subject]')!
  assert.equal(input.getAttribute('list'), 'projectGroupOptions', 'group is the default type')
  const type = card(page, 'view').querySelector<HTMLSelectElement>('[data-perm-type]')!
  type.value = 'user'
  type.dispatchEvent(new page.window.Event('change', { bubbles: true }))
  assert.equal(input.getAttribute('list'), 'projectUserOptions', 'user type swaps the datalist')
  assert.equal(input.placeholder, '用户名，如 zhangsan')
  type.value = 'group'
  type.dispatchEvent(new page.window.Event('change', { bubbles: true }))
  assert.equal(input.getAttribute('list'), 'projectGroupOptions', 'switching back restores groups')

  saveEvidence(EVIDENCE, 'datalists.json', {
    directoryLoads: directoryLoads(page),
    users,
    groups,
    userHint: zhangsan.textContent,
    defaultList: 'projectGroupOptions'
  })
  cases['admin-datalist'] =
    `目录 1 次；用户 ${users.length} 个（值=username，提示含显示名/部门），组 ${groups.length} 个`
})

test('AA4-2 未知组提交：GROUP_NOT_FOUND 明确 toast，输入保留，页签不变', { timeout: 120_000 }, async () => {
  const page = loadWebConsolePage(service.url)
  await openPermTab(page, 'admin', 'Adm1n!')
  const before = await grants()
  const loadsBefore = permTabLoads(page)

  const input = card(page, 'view').querySelector<HTMLInputElement>('[data-perm-subject]')!
  input.value = 'team-typo'
  card(page, 'view').querySelector<HTMLButtonElement>('[data-perm-add]')!.click()
  await page.settle()

  const refusal = lastToast(page)
  assert.match(refusal, /授予失败/, 'the refusal must be reported')
  assert.match(
    refusal,
    /组不存在或平台未见过该组。/,
    'the design copy must be shown for GROUP_NOT_FOUND'
  )
  assert.equal(input.value, 'team-typo', 'the typed subject must survive the refusal')
  assert.equal(permTabLoads(page), loadsBefore, 'a refused grant must not redraw the tab')
  assert.deepEqual(await grants(), before, 'a refused group must store no dead row')

  saveEvidence(EVIDENCE, 'group-not-found.json', {
    toast: refusal,
    inputValue: input.value,
    permTabLoads: permTabLoads(page),
    storedGrants: before
  })
  cases['unknown-group'] =
    '未知组 → toast「授予失败：组不存在或平台未见过该组。」，输入保留，页签 0 刷新，服务端 0 死行'
})

test('AA4-3 非 admin：无「详情」入口，零目录请求，直调 PUT grants 仍 403', { timeout: 120_000 }, async () => {
  const page = loadWebConsolePage(service.url)
  await page.settle()
  await page.submitLogin('zhangsan', 'Passw0rd!')
  assert.equal(page.text('#roleChip'), '开发者')

  assert.equal(
    page.window.document.querySelector('[data-detail]'),
    null,
    'a developer never gets the 详情 entry that hosts the permission tab'
  )
  assert.equal(directoryLoads(page), 0, 'a non-admin must never request the directory')
  assert.equal(
    page.calls().some((call) => call === `GET ${GRANTS_PATH}`),
    false,
    'without the entry the grants are never read either'
  )

  const devToken = await login(service.url, 'zhangsan', 'Passw0rd!')
  const direct = await api(GRANTS_PATH, {
    method: 'PUT',
    token: devToken,
    body: JSON.stringify({ subjectType: 'group', subjectId: 'team-payment', permissions: ['open'] })
  })
  assert.equal(direct.status, 403)
  assert.equal(direct.body.error.code, 'PERMISSION_DENIED')
  const row = (await grants()).find((g) => g.subjectType === 'group')!
  assert.equal(row.permissions.includes('download'), false, 'the refused write stored nothing')

  saveEvidence(EVIDENCE, 'non-admin-calls.json', {
    directoryLoads: directoryLoads(page),
    detailEntry: false,
    directPut: { status: direct.status, code: direct.body.error.code }
  })
  cases['non-admin'] = 'developer：无详情入口、目录 0 次；直调 PUT /grants → 403 PERMISSION_DENIED'
})
