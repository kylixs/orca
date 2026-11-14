import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { ROOT, login, saveEvidence, spawnService, type Service } from './harness.ts'
import { loadWebConsolePage, type WebConsolePage } from './web-console-page.ts'

/**
 * M120b (QA-014): the members page matrix becomes an editable 7-bit permission
 * editor, driven through the real console files against a real platform process.
 *
 * - all seven contract permission bits render as checkboxes, including the
 *   `browser` column QA-014 found missing and `download` (no more lock badge)
 * - edits are a per-row draft; 保存变更 diffs against the platform and sends one
 *   PUT per changed row carrying that row's FULL array (row-wide replacement)
 * - the confirmation states the revocation blast radius as a rule per row kind:
 *   the platform has no online-session endpoint, so nobody is named as online
 * - a failing PUT stops the batch, reports the failed subject and redraws from
 *   what the platform holds (QA-009 rollback pattern)
 */

const EVIDENCE = 'w120b-permission-matrix'
const INTERNAL_TOKEN = 'w120b-internal-token'
const PROJECT = 'proj_payment'
const GRANTS_PATH = `/v1/projects/${PROJECT}/grants`
const GROUP = 'team-payment'
const USER = 'zhangsan'
/** The platform's shipped baseline: the group holds these five bits. */
const BASE = ['open', 'terminal', 'agent', 'file:read', 'file:write']
const BITS = ['open', 'terminal', 'agent', 'file:read', 'file:write', 'browser', 'download']

let service: Service
let adminToken = ''
let devToken = ''
const summary: Record<string, string> = {}

function record(qa: string, detail: string): void {
  summary[qa] = detail
}

async function adminApi(
  path: string,
  init: RequestInit & { token?: string } = {}
  // oxlint-disable-next-line typescript/no-explicit-any -- same assert-driven shape as web-project-registration.e2e.test.ts
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

type GrantRow = { subjectType: string; subjectId: string; username?: string; permissions: string[] }

async function getGrants(): Promise<GrantRow[]> {
  const res = await adminApi(GRANTS_PATH)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  return res.body.grants
}

async function putGrants(
  token: string,
  subjectType: string,
  subjectId: string,
  permissions: string[]
): Promise<void> {
  const res = await adminApi(GRANTS_PATH, {
    method: 'PUT',
    token,
    body: JSON.stringify({ subjectType, subjectId, permissions })
  })
  assert.equal(res.status, 200, JSON.stringify(res.body))
}

/** Rebuilds the matrix so every test starts from a known shape and row order. */
async function resetGrants(shape: 'both-user-first' | 'both' | 'group-only'): Promise<void> {
  // Clearing first makes the store order deterministic: the array order of the
  // next PUTs decides which row a failing batch reports first.
  await putGrants(adminToken, 'group', GROUP, [])
  await putGrants(adminToken, 'user', USER, [])
  if (shape !== 'group-only') {
    await putGrants(adminToken, 'user', USER, ['open'])
  }
  await putGrants(adminToken, 'group', GROUP, BASE)
}

function rowFor(page: WebConsolePage, label: string): HTMLElement {
  const row = [...page.window.document.querySelectorAll<HTMLElement>('#grantPanel tbody tr')].find(
    (candidate) => candidate.querySelector('td')?.textContent?.includes(label)
  )
  assert.ok(row, `the matrix must render a row for ${label}`)
  return row
}

function checkbox(
  page: WebConsolePage,
  subjectType: string,
  subjectId: string,
  perm: string
): HTMLInputElement {
  const box = page.window.document.querySelector<HTMLInputElement>(
    `#grantPanel input[data-perm="${perm}"][data-subject-type="${subjectType}"][data-subject-id="${subjectId}"]`
  )
  assert.ok(box, `the matrix must render the ${perm} checkbox for ${subjectType}:${subjectId}`)
  return box
}

/** Flips a draft checkbox: setting `checked` alone never fires the change handler. */
function toggle(
  page: WebConsolePage,
  subjectType: string,
  subjectId: string,
  perm: string,
  checked: boolean
): void {
  const box = checkbox(page, subjectType, subjectId, perm)
  box.checked = checked
  box.dispatchEvent(new page.window.Event('change', { bubbles: true }))
}

function saveButton(page: WebConsolePage): HTMLButtonElement {
  return page.window.document.querySelector<HTMLButtonElement>('#grantSave')!
}

function putCount(page: WebConsolePage): number {
  return page.calls().filter((call) => call === `PUT ${GRANTS_PATH}`).length
}

function grantLoads(page: WebConsolePage): number {
  return page.calls().filter((call) => call === `GET ${GRANTS_PATH}`).length
}

function lastToast(page: WebConsolePage): string {
  // Why the spread: happy-dom's NodeList has no `.at()` of its own.
  const toasts = [...page.window.document.querySelectorAll('.toast')]
  return toasts.at(-1)?.textContent ?? ''
}

function confirmText(page: WebConsolePage): string {
  const body = page.window.document.querySelector('.dialog-backdrop .body')
  assert.ok(body, 'the save confirmation must be open')
  return body.textContent ?? ''
}

/** `confirm` saves, `close` is the ghost button that cancels without saving. */
function clickDialogAction(page: WebConsolePage, action: 'confirm' | 'close'): void {
  const selector = action === 'close' ? '[data-action="close"]' : '[data-action="0"]'
  const button = page.window.document.querySelector<HTMLButtonElement>(
    `.dialog-backdrop ${selector}`
  )
  assert.ok(button, `the confirmation must render ${action}`)
  button.click()
}

/** The declarations of one stylesheet rule, so a CSS fix is pinned, not assumed. */
function cssRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, 'm'))?.[1] ?? ''
}

/** Logs in, opens 成员与权限 and selects the seeded project's matrix. */
async function openMatrix(page: WebConsolePage, username: string, password: string): Promise<void> {
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

before(async () => {
  service = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-web-permission-matrix'
  )
  adminToken = await login(service.url, 'admin', 'Adm1n!')
  devToken = await login(service.url, 'zhangsan', 'Passw0rd!')
}, 120_000)

after(async () => {
  await service?.stop()
  saveEvidence(EVIDENCE, 'm120b-summary.json', {
    workOrder: 'M120b 权限矩阵可配置',
    cases: summary
  })
})

test('M120b-1 矩阵渲染全部 7 个权限位（含 browser/download），初值与服务端一致', async () => {
  await resetGrants('both-user-first')
  const page = loadWebConsolePage(service.url)
  await openMatrix(page, 'admin', 'Adm1n!')

  const heads = [...page.window.document.querySelectorAll('#grantPanel thead th')].map((th) =>
    th.textContent?.trim()
  )
  assert.deepEqual(
    heads.slice(2, 9),
    BITS,
    'the columns must be exactly the 7 contract permission bits'
  )

  const group = (await getGrants()).find((g) => g.subjectType === 'group')!
  const boxes = [
    ...page.window.document.querySelectorAll<HTMLInputElement>(
      `#grantPanel input[data-subject-type="group"][data-subject-id="${group.subjectId}"][data-perm]`
    )
  ]
  assert.equal(boxes.length, 7, 'each row carries exactly the 7 bits')
  for (const box of boxes) {
    assert.equal(
      box.checked,
      group.permissions.includes(box.dataset.perm!),
      `${box.dataset.perm} must reflect the stored grant`
    )
  }
  assert.equal(checkbox(page, 'group', group.subjectId, 'browser').checked, false)
  assert.equal(checkbox(page, 'group', group.subjectId, 'download').checked, false)
  assert.doesNotMatch(page.text('#grantPanel'), /锁/, 'the download lock badge is gone')
  assert.match(
    page.text('#grantPanel'),
    /download 仅在项目下载策略为「允许」时生效/,
    'the note must state the real double gate'
  )
  assert.equal(saveButton(page).disabled, true, 'an untouched matrix has nothing to save')

  saveEvidence(EVIDENCE, 'matrix-render.json', {
    columns: heads.slice(2, 9),
    groupPermissions: group.permissions,
    checkboxesPerRow: boxes.length,
    downloadLockBadgeGone: true
  })
  record(
    'render',
    '7 位全列（含 QA-014 漏掉的 browser 与改复选框的 download），初值与 GET /grants 一致，download 锁徽标移除'
  )
}, 120_000)

test('M120b-2 变更一行保存：仅该行一次 PUT，body 为该行全量权限位，其余行零请求', async () => {
  await resetGrants('both-user-first')
  const page = loadWebConsolePage(service.url)
  await openMatrix(page, 'admin', 'Adm1n!')
  const groupId = (await getGrants()).find((g) => g.subjectType === 'group')!.subjectId
  const before = await getGrants()
  const putsBefore = putCount(page)
  const loadsBefore = grantLoads(page)

  toggle(page, 'group', groupId, 'browser', true)
  toggle(page, 'group', groupId, 'file:write', false)

  assert.equal(putCount(page), putsBefore, 'drafting must not reach the platform')
  const row = rowFor(page, GROUP)
  assert.ok(row.classList.contains('dirty'), 'the edited row is marked dirty')
  assert.equal(row.querySelector('[data-unsaved]')?.hidden, false, 'the row shows 未保存')
  assert.equal(saveButton(page).disabled, false, 'a dirty row enables 保存变更')
  const otherRow = rowFor(page, USER)
  assert.equal(otherRow.classList.contains('dirty'), false, 'untouched rows stay clean')

  saveButton(page).click()
  assert.match(confirmText(page), /\+新增 browser/, 'the confirmation lists the added bit')
  assert.match(confirmText(page), /−移除 file:write/, 'the confirmation lists the removed bit')
  clickDialogAction(page, 'confirm')
  await page.settle()

  assert.equal(putCount(page), putsBefore + 1, 'exactly one PUT for the one dirty row')
  assert.equal(grantLoads(page), loadsBefore + 1, 'one redraw GET, nothing more')
  const after = await getGrants()
  const groupAfter = after.find((g) => g.subjectType === 'group')!
  assert.deepEqual(
    [...groupAfter.permissions].sort(),
    ['agent', 'browser', 'file:read', 'open', 'terminal'],
    'the PUT carried the row full array: browser in, file:write out, nothing else moved'
  )
  assert.equal(after.length, before.length, 'the other row must be untouched')
  const userAfter = after.find((g) => g.username === USER)!
  assert.deepEqual([...userAfter.permissions].sort(), ['open'])

  const redrawn = rowFor(page, GROUP)
  assert.equal(redrawn.classList.contains('dirty'), false, 'the redraw clears the dirty mark')
  assert.equal(redrawn.querySelector('[data-unsaved]')?.hidden, true)
  assert.equal(checkbox(page, 'group', groupId, 'browser').checked, true, 'the platform read-back')
  assert.equal(checkbox(page, 'group', groupId, 'file:write').checked, false)
  assert.equal(saveButton(page).disabled, true, 'a saved matrix has nothing to save')

  saveEvidence(EVIDENCE, 'single-row-save.json', {
    dirtyRows: 1,
    putRequests: 1,
    redrawGets: 1,
    serverPermissions: groupAfter.permissions
  })
  record(
    'single-row-save',
    '1 行 2 位变更 → 确认后恰 1 次 PUT（行内全量数组），其余行 0 请求；重绘后脏标记清除、服务端回读一致'
  )
}, 120_000)

test('M120b-3 撤销确认按行给断开文案与差量摘要，取消不落盘，确认后每脏行一次 PUT', async () => {
  await resetGrants('both-user-first')
  const page = loadWebConsolePage(service.url)
  await openMatrix(page, 'admin', 'Adm1n!')
  const grants = await getGrants()
  const userId = grants.find((g) => g.username === USER)!.subjectId
  const groupId = grants.find((g) => g.subjectType === 'group')!.subjectId
  const putsBefore = putCount(page)

  toggle(page, 'user', userId, 'terminal', true)
  toggle(page, 'group', groupId, 'download', true)
  saveButton(page).click()

  const text = confirmText(page)
  assert.match(text, /将保存 2 行权限变更/)
  assert.match(
    text,
    /保存将断开 zhangsan 当前全部云会话（含其他项目）。/,
    'a user row warns about the account-wide disconnect'
  )
  assert.match(
    text,
    /宿主无法解析组成员，保存将断开该项目当前全部在线会话。/,
    'a group row warns that the whole project is disconnected'
  )
  assert.match(text, /\+新增 terminal/)
  assert.match(text, /\+新增 download/)

  clickDialogAction(page, 'close')
  await page.settle()
  assert.equal(putCount(page), putsBefore, 'cancelling must not save anything')
  assert.equal(checkbox(page, 'user', userId, 'terminal').checked, true, 'the draft survives')
  assert.equal(checkbox(page, 'group', groupId, 'download').checked, true)
  assert.equal(saveButton(page).disabled, false, 'the admin can still save after cancelling')

  saveButton(page).click()
  clickDialogAction(page, 'confirm')
  await page.settle()
  assert.equal(putCount(page), putsBefore + 2, 'each dirty row gets exactly one PUT')
  const saved = await getGrants()
  assert.deepEqual([...saved.find((g) => g.username === USER)!.permissions].sort(), [
    'open',
    'terminal'
  ])
  // M120b-6: the browser/download bits persist and read back from the platform.
  assert.deepEqual(
    [...saved.find((g) => g.subjectType === 'group')!.permissions].sort(),
    [...BASE, 'download'].sort()
  )

  saveEvidence(EVIDENCE, 'revoke-confirm.json', {
    userRowCopy: '保存将断开 zhangsan 当前全部云会话（含其他项目）。',
    groupRowCopy: '宿主无法解析组成员，保存将断开该项目当前全部在线会话。',
    cancelSendsNothing: true,
    putsAfterConfirm: 2,
    downloadReadBack: true
  })
  record(
    'revoke-confirm',
    '确认框含行级断开文案（用户行/组行）与 +/- 差量；取消零请求且草稿保留；确认后 2 行各 1 次 PUT，download 位服务端回读'
  )
}, 120_000)

test('M120b-4 批量中途失败：中止、toast 含失败主体、按服务端值回滚重绘', async () => {
  await resetGrants('both-user-first')
  const page = loadWebConsolePage(service.url)
  await openMatrix(page, 'admin', 'Adm1n!')
  const grants = await getGrants()
  const userId = grants.find((g) => g.username === USER)!.subjectId
  const groupId = grants.find((g) => g.subjectType === 'group')!.subjectId
  const loadsBefore = grantLoads(page)

  toggle(page, 'user', userId, 'terminal', true)
  toggle(page, 'group', groupId, 'download', true)
  page.fail('PUT', GRANTS_PATH)
  saveButton(page).click()
  clickDialogAction(page, 'confirm')
  await page.settle()

  assert.equal(putCount(page), 1, 'the batch stops at the first failure')
  const toast = lastToast(page)
  assert.match(toast, /已保存 0 项，2 项失败：zhangsan/, 'the failed subject is named')
  assert.match(toast, /模拟平台故障/, 'the platform reason is carried')
  assert.equal(grantLoads(page), loadsBefore + 1, 'the failure redraws from the platform')
  assert.equal(
    checkbox(page, 'user', userId, 'terminal').checked,
    false,
    'the failed bit rolls back'
  )
  assert.equal(checkbox(page, 'group', groupId, 'download').checked, false)
  assert.equal(saveButton(page).disabled, true, 'the redraw leaves nothing to save')
  assert.equal(rowFor(page, GROUP).classList.contains('dirty'), false)
  page.clearFails()

  // A non-503 verdict behaves the same: the server message lands in the toast.
  toggle(page, 'user', userId, 'terminal', true)
  page.fail('PUT', GRANTS_PATH, {
    status: 409,
    body: { error: { code: 'GRANT_VERSION_CONFLICT', message: '授权已被他人修改，请刷新后重试。' } }
  })
  saveButton(page).click()
  clickDialogAction(page, 'confirm')
  await page.settle()
  assert.match(lastToast(page), /1 项失败：zhangsan（授权已被他人修改，请刷新后重试。）/)
  assert.equal(checkbox(page, 'user', userId, 'terminal').checked, false, 'rolled back again')
  page.clearFails()

  saveEvidence(EVIDENCE, 'save-failure.json', {
    abortAfterFirstFailure: true,
    toast: '已保存 0 项，2 项失败：zhangsan（模拟平台故障）',
    conflictToast: '已保存 0 项，1 项失败：zhangsan（授权已被他人修改，请刷新后重试。）',
    redrawnFromServer: true
  })
  record(
    'save-failure',
    'PUT 503/409 注入 → 首败即中止（仅 1 次请求）、toast 含失败主体与服务端原因、矩阵按服务端值回滚重绘且脏标记清除'
  )
}, 120_000)

test('M120b-5 添加授权：未知用户拒绝且矩阵不变；已知用户新行默认 open 且可改勾', async () => {
  await resetGrants('group-only')
  const page = loadWebConsolePage(service.url)
  await openMatrix(page, 'admin', 'Adm1n!')
  const subject = page.window.document.querySelector<HTMLInputElement>('#grantSubject')!
  const type = page.window.document.querySelector<HTMLSelectElement>('#grantType')!
  const loadsBefore = grantLoads(page)

  type.value = 'user'
  subject.value = 'no-such-user'
  page.window.document.querySelector<HTMLButtonElement>('#grantAdd')!.click()
  await page.settle()
  assert.match(lastToast(page), /授予失败/)
  assert.match(lastToast(page), /用户不存在/, 'the platform reason is carried')
  assert.equal(grantLoads(page), loadsBefore, 'a refused add must not redraw the matrix')
  assert.equal(
    (await getGrants()).some((g) => g.subjectId === 'no-such-user'),
    false,
    'the unknown name must not be stored'
  )
  assert.equal(subject.value, 'no-such-user', 'the typed name survives the refusal')

  subject.value = USER
  page.window.document.querySelector<HTMLButtonElement>('#grantAdd')!.click()
  await page.settle()
  assert.match(lastToast(page), /已授予/)
  assert.equal(grantLoads(page), loadsBefore + 1, 'a landed add refreshes the matrix')
  const grants = await getGrants()
  const added = grants.find((g) => g.username === USER)!
  assert.deepEqual(
    [...added.permissions].sort(),
    ['open'],
    'a new grant is born with open only, not the old five-bit bundle'
  )
  const checked = [
    ...page.window.document.querySelectorAll<HTMLInputElement>(
      `#grantPanel input[data-subject-type="user"][data-subject-id="${added.subjectId}"][data-perm]`
    )
  ].filter((box) => box.checked)
  assert.deepEqual(
    checked.map((box) => box.dataset.perm),
    ['open'],
    'the new row renders exactly its stored bit'
  )

  toggle(page, 'user', added.subjectId, 'terminal', true)
  assert.equal(saveButton(page).disabled, false, 'the new row is editable in place')
  saveButton(page).click()
  clickDialogAction(page, 'confirm')
  await page.settle()
  assert.deepEqual([...(await getGrants()).find((g) => g.username === USER)!.permissions].sort(), [
    'open',
    'terminal'
  ])

  saveEvidence(EVIDENCE, 'add-grant.json', {
    unknownUser: '授予失败：用户不存在。 + 矩阵不刷新、输入保留',
    newUserRow: 'open 单位起家，可在矩阵中改勾'
  })
  record(
    'add-grant',
    '未知用户 400 USER_NOT_FOUND → toast 且矩阵/输入不变；已知用户 → 新行默认 open 单位，矩阵内改勾保存生效'
  )
}, 120_000)

test('M120b-6 非管理员不可见矩阵，直调 PUT /grants 403 且服务端状态不变', async () => {
  await resetGrants('group-only')
  const page = loadWebConsolePage(service.url)
  await page.settle()
  await page.submitLogin('zhangsan', 'Passw0rd!')
  assert.equal(page.text('#roleChip'), '开发者')
  assert.equal(page.hidden('#adminNav'), true, 'the admin nav group stays hidden')
  await page.clickNav('members')
  assert.match(page.text('#content'), /无权访问/, 'forcing the route lands on the forbidden view')
  assert.doesNotMatch(page.text('#content'), /授权矩阵/)
  assert.equal(
    page.calls().some((call) => call === `GET ${GRANTS_PATH}`),
    false,
    'the forbidden route never even loads a matrix'
  )

  const direct = await adminApi(GRANTS_PATH, {
    method: 'PUT',
    token: devToken,
    body: JSON.stringify({
      subjectType: 'group',
      subjectId: GROUP,
      permissions: ['open', 'browser']
    })
  })
  assert.equal(direct.status, 403)
  assert.equal(direct.body.error.code, 'PERMISSION_DENIED')
  const group = (await getGrants()).find((g) => g.subjectType === 'group')!
  assert.equal(group.permissions.includes('browser'), false, 'the refused write stored nothing')

  saveEvidence(EVIDENCE, 'gating.json', {
    developerSeesMatrix: false,
    directPut: { status: direct.status, code: direct.body.error.code },
    serverUnchanged: group.permissions
  })
  record(
    'gating',
    '开发者：成员与权限路由 → 无权访问、矩阵不加载；直调 PUT /grants → 403 PERMISSION_DENIED，服务端状态不变'
  )
}, 120_000)

test('M120b-7 脏行 .dirty 高亮：改勾加类、还原去类，样式表有对应警示底色', async () => {
  await resetGrants('both-user-first')
  const page = loadWebConsolePage(service.url)
  await openMatrix(page, 'admin', 'Adm1n!')
  const groupId = (await getGrants()).find((g) => g.subjectType === 'group')!.subjectId
  const row = rowFor(page, GROUP)

  toggle(page, 'group', groupId, 'browser', true)
  assert.equal(row.classList.contains('dirty'), true, 'editing a row marks it dirty')
  assert.equal(row.querySelector('[data-unsaved]')?.hidden, false, 'the 未保存 badge shows')

  // Back to the stored value: the draft equals the platform again, so the row
  // must unmark rather than stay flagged forever.
  toggle(page, 'group', groupId, 'browser', false)
  assert.equal(row.classList.contains('dirty'), false, 'reverting the edit unmarks the row')
  assert.equal(row.querySelector('[data-unsaved]')?.hidden, true, 'the badge hides again')
  assert.equal(saveButton(page).disabled, true, 'a reverted draft leaves nothing to save')

  // The class is not a dead one: styles.css tints the row with the warn tone.
  assert.match(
    cssRule(readFileSync(join(ROOT, 'apps/web/styles.css'), 'utf8'), 'tbody tr.dirty'),
    /background:\s*#fffbeb/,
    'a dirty row must be visibly tinted, not badge-only (m-4)'
  )

  saveEvidence(EVIDENCE, 'dirty-row.json', {
    dirtyOnEdit: true,
    cleanOnRevert: true,
    rule: 'tbody tr.dirty { background: #fffbeb; }'
  })
  record(
    'dirty-row',
    '改勾加 .dirty、还原去类、未保存徽标随之显隐；styles.css 补 tbody tr.dirty 警示底色（m-4）'
  )
}, 120_000)

test('M120b-8 批量保存期间矩阵冻结：复选框/添加/移除全部禁用，批后重绘恢复', async () => {
  await resetGrants('both-user-first')
  const page = loadWebConsolePage(service.url)
  await openMatrix(page, 'admin', 'Adm1n!')
  const grants = await getGrants()
  const userId = grants.find((g) => g.username === USER)!.subjectId
  const groupId = grants.find((g) => g.subjectType === 'group')!.subjectId
  const putsBefore = putCount(page)

  toggle(page, 'user', userId, 'terminal', true)
  toggle(page, 'group', groupId, 'download', true)

  // Holding the first PUT is the only way to stand inside the in-flight window.
  page.hold('PUT', GRANTS_PATH)
  saveButton(page).click()
  clickDialogAction(page, 'confirm')
  for (let round = 0; round < 20 && putCount(page) === putsBefore; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.equal(putCount(page), putsBefore + 1, 'the first PUT of the batch is in flight')

  const boxes = [
    ...page.window.document.querySelectorAll<HTMLInputElement>('#grantPanel input[data-perm]')
  ]
  assert.equal(boxes.length, 14, 'two rows times seven bits are on the table')
  for (const box of boxes) {
    assert.equal(box.disabled, true, `${box.dataset.subjectId} ${box.dataset.perm} is frozen`)
  }
  for (const selector of ['#grantAdd', '#grantSubject', '#grantType']) {
    assert.equal(
      page.window.document.querySelector<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
        selector
      )!.disabled,
      true,
      `${selector} is frozen too`
    )
  }
  for (const button of page.window.document.querySelectorAll<HTMLButtonElement>(
    '#grantPanel [data-remove]'
  )) {
    assert.equal(button.disabled, true, 'removal cannot run mid-batch')
  }
  assert.equal(saveButton(page).disabled, true, 'saving cannot be re-entered mid-batch')

  await page.release()
  await page.settle()

  assert.equal(putCount(page), putsBefore + 2, 'the batch resumes and finishes after the release')
  const saved = await getGrants()
  assert.deepEqual([...saved.find((g) => g.username === USER)!.permissions].sort(), [
    'open',
    'terminal'
  ])
  assert.deepEqual(
    [...saved.find((g) => g.subjectType === 'group')!.permissions].sort(),
    [...BASE, 'download'].sort(),
    'the frozen window stored exactly what was drafted, nothing else'
  )
  assert.equal(
    checkbox(page, 'user', userId, 'terminal').disabled,
    false,
    'the post-batch redraw re-opens the matrix'
  )
  assert.equal(saveButton(page).disabled, true, 'nothing left to save once the batch lands')

  saveEvidence(EVIDENCE, 'batch-freeze.json', {
    frozenMidBatch: { checkboxes: boxes.length, addRow: true, removeButtons: true },
    putsAfterRelease: 2,
    serverReadBack: { user: ['open', 'terminal'], group: [...BASE, 'download'].sort() }
  })
  record(
    'batch-freeze',
    '2 脏行批量保存：首行 PUT 在途时 14 个复选框/添加授权/主体与类型/移除全禁用，释放后批完重绘恢复（m-5）'
  )
}, 120_000)
