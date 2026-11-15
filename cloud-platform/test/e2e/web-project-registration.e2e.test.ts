import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { ROOT, login, registerHost, saveEvidence, spawnService, type Service } from './harness.ts'
import { loadWebConsolePage, type WebConsolePage } from './web-console-page.ts'

/**
 * M120a (QA-013, FR-3.1): the admin console gains a 登记项目 dialog on 我的项目,
 * driven through the real console files against a real platform process.
 *
 * - the entry renders for admins only; a developer's direct POST /v1/projects is
 *   still refused server-side and audited
 * - required/format checks run in the page first: a rejected form sends nothing
 * - the admin route is `path` 直供 semantics (W8): no `dir`, no key-syntax check
 *   server-side, so the console is the gate — and the only duplicate-Key verdict
 *   it can get back is PROJECT_EXISTS (not the self-service PROJECT_KEY_TAKEN)
 * - error codes land on their own field; everything else stays in the dialog's
 *   top error line, and neither closes the dialog or drops what was typed
 */

const EVIDENCE = 'w120a-registration-dialog'
const INTERNAL_TOKEN = 'w120a-internal-token'
const HOST_ROOT = '/srv/work'

let service: Service
let adminToken = ''
let devToken = ''
let hostId = ''
let beat: ReturnType<typeof setInterval> | undefined
const summary: Record<string, string> = {}

function record(qa: string, detail: string): void {
  summary[qa] = detail
}

async function adminApi(
  path: string,
  init: RequestInit & { token?: string } = {}
  // oxlint-disable-next-line typescript/no-explicit-any -- same assert-driven shape as web-project-entry.e2e.test.ts
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

before(async () => {
  service = await spawnService(
    'apps/api/src/server.ts',
    // A short window: the registered host has to keep beating to stay online.
    { PORT: '0', INTERNAL_TOKEN, ORCA_CLOUD_HOST_OFFLINE_MS: '1500' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-web-project-registration'
  )
  adminToken = await login(service.url, 'admin', 'Adm1n!')
  devToken = await login(service.url, 'zhangsan', 'Passw0rd!')

  // A projectsRoot makes the dialog's「主机项目根」hint real, and the heartbeat
  // keeps the host online so a fresh registration reads as openable.
  const host = await registerHost({
    apiUrl: service.url,
    adminToken,
    name: 'dev-reg',
    directAddr: '127.0.0.1:17111',
    relayTarget: '127.0.0.1:17111',
    projectsRoot: HOST_ROOT
  })
  hostId = host.hostId
  beat = setInterval(() => {
    void fetch(`${service.url}/v1/hosts/${hostId}/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${host.credential}` },
      body: JSON.stringify({ status: 'online' })
    }).catch(() => undefined)
  }, 400)
}, 120_000)

after(async () => {
  if (beat) {
    clearInterval(beat)
  }
  await service?.stop()
  saveEvidence(EVIDENCE, 'm120a-summary.json', {
    workOrder: 'M120a 管理台项目登记弹层',
    cases: summary
  })
})

/** The `tr` for the named project row in the main content table. */
function rowFor(page: WebConsolePage, name: string): HTMLElement {
  const row = [...page.window.document.querySelectorAll<HTMLElement>('#content tbody tr')].find(
    (candidate) => candidate.textContent?.includes(name)
  )
  assert.ok(row, `a row for ${name} must be rendered`)
  return row
}

/** Waits out the route's own fetches before giving up on the row. */
async function rowWhenRendered(page: WebConsolePage, name: string): Promise<HTMLElement> {
  for (let round = 0; round < 20; round += 1) {
    const row = [...page.window.document.querySelectorAll<HTMLElement>('#content tbody tr')].find(
      (candidate) => candidate.textContent?.includes(name)
    )
    if (row) {
      return row
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return rowFor(page, name)
}

/** The newest toast: earlier ones are still inside their 2.4s lifetime. */
function lastToast(page: WebConsolePage): string {
  // Why the spread: happy-dom's NodeList has no `.at()` of its own.
  const toasts = [...page.window.document.querySelectorAll('.toast')]
  return toasts.at(-1)?.textContent ?? ''
}

function dialogOpen(page: WebConsolePage): boolean {
  return page.window.document.querySelector('.dialog-backdrop') !== null
}

function postCount(page: WebConsolePage): number {
  return page.calls().filter((call) => call === 'POST /v1/projects').length
}

function fieldValue(page: WebConsolePage, id: string): string {
  const el = page.window.document.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`)
  assert.ok(el, `the dialog must render #${id}`)
  return el.value
}

function fieldError(page: WebConsolePage, id: string): string {
  const el = page.window.document.querySelector<HTMLElement>(`#${id}Error`)
  assert.ok(el, `the dialog must render #${id}Error`)
  return el.hidden ? '' : (el.textContent ?? '').trim()
}

/** The dialog-level error line, which has no field of its own. */
function dialogError(page: WebConsolePage): string {
  const el = page.window.document.querySelector<HTMLElement>('#regError')
  assert.ok(el, 'the dialog must render #regError')
  return el.hidden ? '' : (el.textContent ?? '').trim()
}

/** The declarations of one stylesheet rule, so a CSS fix is pinned, not assumed. */
function cssRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, 'm'))?.[1] ?? ''
}

type RegistrationForm = {
  name?: string
  key?: string
  host?: string
  path?: string
  repoUrl?: string
  branch?: string
}

function fillRegistration(page: WebConsolePage, form: RegistrationForm): void {
  const doc = page.window.document
  for (const [id, value] of Object.entries({
    regName: form.name,
    regKey: form.key,
    regHost: form.host,
    regPath: form.path,
    regRepo: form.repoUrl,
    regBranch: form.branch
  })) {
    if (value === undefined) {
      continue
    }
    const el = doc.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`)
    assert.ok(el, `the dialog must render #${id}`)
    el.value = value
  }
}

function submitRegistration(page: WebConsolePage): void {
  const button = page.window.document.querySelector<HTMLButtonElement>('[data-action="0"]')
  assert.ok(button, 'the dialog must render the 登记 action')
  button.click()
}

/** Logs in, opens 我的项目 and the registration dialog. */
async function openRegisterDialog(page: WebConsolePage, username: string, password: string) {
  await page.settle()
  await page.submitLogin(username, password)
  await page.clickNav('projects')
  const button = page.window.document.querySelector<HTMLElement>('#registerProjectBtn')
  assert.ok(button, `${username} must see the 登记项目 entry`)
  button.click()
  await page.settle()
  assert.ok(dialogOpen(page), 'the registration dialog must open')
}

test('M120a-1 登记入口仅管理员可见；开发者直调接口 403 并写入拒绝审计', async () => {
  const adminPage = loadWebConsolePage(service.url)
  await adminPage.settle()
  await adminPage.submitLogin('admin', 'Adm1n!')
  await adminPage.clickNav('projects')
  const adminBtn = adminPage.window.document.querySelector<HTMLElement>('#registerProjectBtn')
  assert.ok(adminBtn, 'the admin must see the 登记项目 entry on 我的项目')
  assert.equal(adminBtn.textContent?.trim(), '登记项目')

  const devPage = loadWebConsolePage(service.url)
  await devPage.settle()
  await devPage.submitLogin('zhangsan', 'Passw0rd!')
  assert.equal(devPage.text('#roleChip'), '开发者')
  await devPage.clickNav('projects')
  assert.equal(
    devPage.window.document.querySelector('#registerProjectBtn'),
    null,
    'a developer must not see the entry at all'
  )
  assert.doesNotMatch(devPage.text('#content'), /登记项目/)

  // Bypassing the UI is still refused, and the refusal is audited (M93 口径).
  const direct = await fetch(`${service.url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${devToken}` },
    body: JSON.stringify({ key: 'dev-direct', name: 'x', hostId, path: '/srv/work/dev-direct' })
  })
  assert.equal(direct.status, 403)
  const refused = (await direct.json()) as { error: { code: string } }
  assert.equal(refused.error.code, 'PERMISSION_DENIED')
  const audit = await adminApi('/v1/audit/events?eventType=project_create&result=denied&limit=50')
  const denial = audit.body.events.find(
    (e: { actor: string; metadata?: { reason?: string } }) =>
      e.actor === 'zhangsan' && e.metadata?.reason === 'PERMISSION_DENIED'
  )
  assert.ok(denial, 'the refused create must carry a denied project_create audit event')

  saveEvidence(EVIDENCE, 'gating.json', {
    adminSeesEntry: true,
    developerSeesEntry: false,
    directCall: { status: direct.status, code: refused.error.code },
    denialAudit: { actor: denial.actor, eventType: denial.eventType, result: denial.result }
  })
  record(
    'gating',
    'admin 见「登记项目」；开发者不见；直调 POST /v1/projects → 403 PERMISSION_DENIED + denied 审计'
  )
}, 120_000)

test('M120a-2 必填缺失与非法 Key/路径在客户端拦截，0 请求', async () => {
  const page = loadWebConsolePage(service.url)
  await openRegisterDialog(page, 'admin', 'Adm1n!')
  const before = postCount(page)

  // ---- nothing filled: every required field speaks, nothing leaves the page ----
  submitRegistration(page)
  assert.equal(fieldError(page, 'regName'), '项目名称不能为空。')
  assert.equal(fieldError(page, 'regKey'), '项目 Key 长度必须为 1–64 个字符。')
  assert.equal(fieldError(page, 'regHost'), '请选择目标主机。')
  assert.equal(fieldError(page, 'regPath'), '项目路径不能为空。')
  assert.equal(postCount(page), before, 'a rejected form must not reach the platform')
  assert.ok(dialogOpen(page), 'validation failure keeps the dialog open')
  assert.equal(
    page.window.document.activeElement?.id,
    'regName',
    'focus lands on the first errored field'
  )

  // ---- key grammar, same rules as project-key.ts ----
  fillRegistration(page, { name: '登记演练', host: hostId, path: '/srv/work/reg-invalid' })
  const badKeys: [string, string][] = [
    ['Payment_Service', '项目 Key 必须以小写字母或数字开头'],
    ['a'.repeat(65), '项目 Key 长度必须为 1–64 个字符'],
    ['reg.dot.', '项目 Key 不能是 “.” 或 “..”，也不能以 “.” 结尾']
  ]
  for (const [bad, expected] of badKeys) {
    fillRegistration(page, { key: bad })
    submitRegistration(page)
    assert.match(fieldError(page, 'regKey'), new RegExp(expected))
    assert.equal(fieldError(page, 'regName'), '', 'only the offending field carries the error')
    assert.equal(postCount(page), before, `${bad} must not reach the platform`)
  }

  // ---- path soft checks: absolute / no .. / no trailing separator ----
  fillRegistration(page, { key: 'reg-invalid' })
  const badPaths: [string, string][] = [
    ['srv/work/reg-invalid', '项目路径必须是绝对路径。'],
    ['/srv/../reg-invalid', '项目路径不能包含 “.” 或 “..” 段。'],
    ['/srv/work/reg-invalid/', '项目路径不能以分隔符结尾。']
  ]
  for (const [bad, expected] of badPaths) {
    fillRegistration(page, { path: bad })
    submitRegistration(page)
    assert.equal(fieldError(page, 'regPath'), expected)
    assert.equal(postCount(page), before, `${bad} must not reach the platform`)
  }
  assert.ok(dialogOpen(page), 'the dialog never closes on a rejected form')

  saveEvidence(EVIDENCE, 'client-validation.json', {
    requiredFields: ['name', 'key', 'hostId', 'path'],
    keyRules: badKeys.map(([k]) => k),
    pathRules: badPaths.map(([p]) => p),
    postsSent: postCount(page) - before,
    focusOnFirstError: page.window.document.activeElement?.id
  })
  record(
    'client-validation',
    '空值/大写 Key/超 64/尾点/相对路径/..段/尾分隔符 → 字段级错误 + 0 请求'
  )
}, 120_000)

test('M120a-3 真实平台登记成功：201、toast、列表新行、path 直供语义', async () => {
  const page = loadWebConsolePage(service.url)
  await openRegisterDialog(page, 'admin', 'Adm1n!')

  fillRegistration(page, {
    name: '登记演练服务',
    key: 'reg-live',
    host: hostId,
    path: '/srv/work/reg-live'
  })
  // Selecting the host (not just setting the value) is what draws the root hint.
  page.window.document
    .querySelector<HTMLSelectElement>('#regHost')!
    .dispatchEvent(new page.window.Event('change', { bubbles: true }))
  const hint = page.window.document.querySelector<HTMLElement>('#regRootHint')
  assert.equal(hint?.hidden, false, 'a host with projectsRoot shows the root hint')
  assert.equal(hint?.textContent?.trim(), `主机项目根：${HOST_ROOT}`)

  const before = postCount(page)
  submitRegistration(page)
  await page.settle()

  assert.match(lastToast(page), /项目已登记/, 'success must be reported')
  assert.equal(dialogOpen(page), false, 'success closes the dialog')
  assert.equal(postCount(page), before + 1, 'exactly one create request')
  assert.ok(
    page.calls().filter((call) => call.startsWith('GET /v1/projects')).length >= 2,
    'success refetches the project list'
  )
  const row = rowFor(page, 'reg-live')
  assert.match(row.textContent ?? '', /登记演练服务/)
  assert.match(row.textContent ?? '', /\/srv\/work\/reg-live/)
  assert.match(
    row.textContent ?? '',
    /管理员可见（未授权）/,
    'W8: the admin route grants nobody, so the column says so'
  )

  const view = await adminApi('/v1/projects')
  const created = view.body.projects.find((p: { key: string }) => p.key === 'reg-live')
  assert.ok(created, 'the project must exist on the platform')
  assert.equal(created.status, 'ready', 'no repoUrl means 登记即就绪')
  assert.equal(created.path, '/srv/work/reg-live', 'the typed absolute path is stored verbatim')
  assert.equal(created.hostId, hostId)
  assert.equal(created.repoUrl, '')
  assert.equal(created.defaultBranch, 'main')
  assert.equal(created.hostStatus, 'online', 'the beating host makes the project openable')

  // The 状态 column lives on the workbench table, so 可打开 is asserted there.
  await page.clickNav('workbench')
  assert.match((await rowWhenRendered(page, 'reg-live')).textContent ?? '', /可打开/)

  saveEvidence(EVIDENCE, 'register-success.json', {
    key: 'reg-live',
    path: created.path,
    status: created.status,
    hostOnline: created.hostStatus,
    rowText: (row.textContent ?? '').replace(/\s+/g, ' ').trim(),
    toast: lastToast(page),
    rootHint: hint?.textContent?.trim()
  })
  record(
    'success',
    '登记 reg-live → 201/ready、toast 项目已登记、列表新行（管理员可见（未授权）·可打开）、主机项目根提示出现'
  )
}, 120_000)

test('M120a-4 带 repoUrl 登记：toast 提示克隆中，项目进入 provisioning', async () => {
  const page = loadWebConsolePage(service.url)
  await openRegisterDialog(page, 'admin', 'Adm1n!')
  fillRegistration(page, {
    name: '克隆演练服务',
    key: 'reg-clone',
    host: hostId,
    path: '/srv/work/reg-clone',
    repoUrl: 'git@git.example.com:pay/reg-clone.git',
    branch: 'release/1.0'
  })
  submitRegistration(page)
  await page.settle()

  assert.match(lastToast(page), /项目已登记，克隆中，就绪后可打开/)
  assert.equal(dialogOpen(page), false)
  const view = await adminApi('/v1/projects')
  const created = view.body.projects.find((p: { key: string }) => p.key === 'reg-clone')
  assert.ok(created, 'the project must exist on the platform')
  assert.equal(created.status, 'provisioning', 'a repo URL means the host clones before first open')
  assert.equal(created.repoUrl, 'git@git.example.com:pay/reg-clone.git')
  assert.equal(created.defaultBranch, 'release/1.0')

  saveEvidence(EVIDENCE, 'register-with-repo.json', {
    key: 'reg-clone',
    status: created.status,
    toast: lastToast(page)
  })
  record(
    'repoUrl',
    '带 repoUrl 登记 → status=provisioning、toast「项目已登记，克隆中，就绪后可打开」'
  )
}, 120_000)

test('M120a-5 重复 Key：409 PROJECT_EXISTS 落在 key 字段，弹层不关输入保留', async () => {
  const page = loadWebConsolePage(service.url)
  await openRegisterDialog(page, 'admin', 'Adm1n!')
  // The seeded project already owns this key, and the admin route's duplicate
  // verdict is PROJECT_EXISTS — not the self-service PROJECT_KEY_TAKEN.
  fillRegistration(page, {
    name: '重复Key演练',
    key: 'payment-service',
    host: hostId,
    path: '/srv/work/reg-dup-key'
  })
  submitRegistration(page)
  await page.settle()

  assert.equal(fieldError(page, 'regKey'), '项目 Key 已存在。')
  assert.equal(fieldError(page, 'regPath'), '', 'the path must not be blamed for a key clash')
  assert.equal(dialogError(page), '', 'no dialog-level error either')
  assert.ok(dialogOpen(page), 'the dialog must stay open')
  assert.equal(fieldValue(page, 'regName'), '重复Key演练', 'typed input survives the failure')
  assert.equal(fieldValue(page, 'regKey'), 'payment-service')
  assert.equal(fieldValue(page, 'regPath'), '/srv/work/reg-dup-key')
  const view = await adminApi('/v1/projects')
  assert.equal(
    view.body.projects.some((p: { path: string }) => p.path === '/srv/work/reg-dup-key'),
    false,
    'nothing may be created behind a refused key'
  )

  saveEvidence(EVIDENCE, 'duplicate-key.json', {
    code: 'PROJECT_EXISTS',
    field: 'regKey',
    message: fieldError(page, 'regKey'),
    dialogKeptOpen: dialogOpen(page),
    inputPreserved: fieldValue(page, 'regKey')
  })
  record(
    'duplicate-key',
    '重复 Key → 409 PROJECT_EXISTS → key 字段「项目 Key 已存在。」，弹层不关、输入保留'
  )
}, 120_000)

test('M120a-6 重复路径与平台侧非法路径都落在 path 字段（服务端 message 原样）', async () => {
  const page = loadWebConsolePage(service.url)
  await openRegisterDialog(page, 'admin', 'Adm1n!')

  // ① path occupancy is per (host, path): the seeded project lives on another
  // host, so this host gets its own occupant for the duplicate verdict.
  const occupied = await adminApi('/v1/projects', {
    method: 'POST',
    body: JSON.stringify({
      key: 'reg-path-owner',
      name: '重复路径占位',
      hostId,
      path: '/srv/work/payment-service'
    })
  })
  assert.equal(occupied.status, 201, JSON.stringify(occupied.body))

  fillRegistration(page, {
    name: '重复路径演练',
    key: 'reg-dup-path',
    host: hostId,
    path: '/srv/work/payment-service'
  })
  submitRegistration(page)
  await page.settle()
  assert.equal(fieldError(page, 'regPath'), '该主机目录下已存在同路径的项目。')
  assert.equal(fieldError(page, 'regKey'), '', 'the key was free, so it must carry no error')
  assert.ok(dialogOpen(page))

  // ② an empty segment passes the console's soft check and only the platform
  //    catches it: its own细分 message must be shown verbatim on the path field.
  fillRegistration(page, { key: 'reg-empty-seg', path: '/srv//reg-empty-seg' })
  submitRegistration(page)
  await page.settle()
  assert.equal(fieldError(page, 'regPath'), '项目路径包含空段（重复分隔符）。')
  assert.ok(dialogOpen(page))

  saveEvidence(EVIDENCE, 'path-errors.json', {
    duplicatePath: { code: 'PROJECT_PATH_TAKEN', message: '该主机目录下已存在同路径的项目。' },
    invalidPath: { code: 'PROJECT_PATH_INVALID', message: '项目路径包含空段（重复分隔符）。' }
  })
  record(
    'path-errors',
    '重复路径 → 409 PROJECT_PATH_TAKEN 落 path 字段；/srv//x → 400 PROJECT_PATH_INVALID 服务端文案原样落 path 字段'
  )
}, 120_000)

test('M120a-7 审计含 project_create 成功事件，筛选下拉含该事件并可过滤', async () => {
  const events = await adminApi(
    '/v1/audit/events?eventType=project_create&result=success&limit=100'
  )
  const created = events.body.events.find(
    (e: { metadata?: { key?: string } }) => e.metadata?.key === 'reg-live'
  )
  assert.ok(created, 'the successful registration must be audited')
  assert.equal(created.metadata.path, '/srv/work/reg-live')

  const page = loadWebConsolePage(service.url)
  await page.settle()
  await page.submitLogin('admin', 'Adm1n!')
  await page.clickNav('audit')
  const type = page.window.document.querySelector<HTMLSelectElement>('#auditType')
  assert.ok(
    [...type.options].some((option) => option.value === 'project_create'),
    'the filter must offer project_create'
  )
  type.value = 'project_create'
  page.window.document.querySelector<HTMLSelectElement>('#auditResult')!.value = 'success'
  page.window.document.querySelector<HTMLButtonElement>('#auditApply')!.click()
  await page.settle()

  const rows = [...page.window.document.querySelectorAll<HTMLElement>('#content tbody tr')]
  assert.ok(rows.length > 0, 'the filtered query must be non-empty')
  for (const tr of rows) {
    assert.match(tr.textContent ?? '', /project_create/)
  }

  saveEvidence(EVIDENCE, 'audit.json', {
    successEvent: {
      eventType: created.eventType,
      key: created.metadata.key,
      path: created.metadata.path
    },
    filterOffered: true,
    filteredRows: rows.length
  })
  record('audit', 'project_create 成功事件含 key/path；审计下拉含 project_create 且过滤结果非空')
}, 120_000)

test('M120a-8 兜底错误映射：HOST_NOT_FOUND 落主机字段，其余落在弹层顶部', async () => {
  const page = loadWebConsolePage(service.url)
  await openRegisterDialog(page, 'admin', 'Adm1n!')
  fillRegistration(page, {
    name: '兜底演练',
    key: 'reg-host-miss',
    host: hostId,
    path: '/srv/work/reg-host-miss'
  })

  // Normally unreachable (the options come from GET /v1/hosts), so it is stubbed.
  page.fail('POST', '/v1/projects', {
    status: 400,
    body: { error: { code: 'HOST_NOT_FOUND', message: '主机不存在。' } }
  })
  submitRegistration(page)
  await page.settle()
  assert.equal(fieldError(page, 'regHost'), '主机不存在。')
  assert.ok(dialogOpen(page))
  page.clearFails()

  // Audit-gate and network failures have no field to blame: the top line speaks.
  page.fail('POST', '/v1/projects')
  fillRegistration(page, { key: 'reg-gate' })
  submitRegistration(page)
  await page.settle()
  assert.equal(dialogError(page), '模拟平台故障')
  assert.equal(fieldError(page, 'regKey'), '')
  assert.ok(dialogOpen(page), 'a failed submit must keep the form for retry')
  page.clearFails()

  saveEvidence(EVIDENCE, 'error-fallback.json', {
    hostNotFound: { field: 'regHost', message: '主机不存在。' },
    dialogTop: { field: 'regError', message: '模拟平台故障' }
  })
  record(
    'error-fallback',
    'HOST_NOT_FOUND → hostId 字段；无字段可归的失败 → 弹层顶部错误行，弹层保持可重试'
  )
}, 120_000)

test('M120a-9 Key 失焦即校（§3.2）：blur 置错/合法清错、提交校验保留；主机字段错误控件变红', async () => {
  const page = loadWebConsolePage(service.url)
  await openRegisterDialog(page, 'admin', 'Adm1n!')
  const key = page.window.document.querySelector<HTMLInputElement>('#regKey')!
  const host = page.window.document.querySelector<HTMLSelectElement>('#regHost')!
  const blurKey = () => key.dispatchEvent(new page.window.FocusEvent('blur'))
  const before = postCount(page)

  // The host select is a <select class="select">: it carries the invalid state
  // like an input does, and styles.css gives that state the same red border.
  submitRegistration(page)
  assert.equal(fieldError(page, 'regHost'), '请选择目标主机。')
  assert.equal(host.classList.contains('invalid'), true, 'the host field is marked invalid')
  assert.match(
    cssRule(readFileSync(join(ROOT, 'apps/web/styles.css'), 'utf8'), '.select.invalid'),
    /border-color:\s*var\(--danger\)/,
    'the select must turn red, not only the line under it (m-1)'
  )

  // Blur runs the very same rule submit runs, and never leaves the page.
  fillRegistration(page, { key: 'Payment_Service' })
  blurKey()
  assert.match(fieldError(page, 'regKey'), /必须以小写字母或数字开头/)
  assert.equal(key.classList.contains('invalid'), true)
  assert.equal(postCount(page), before, 'blur validation is local only')

  fillRegistration(page, { key: 'reg-blur-ok' })
  blurKey()
  assert.equal(fieldError(page, 'regKey'), '', 'a legal key clears its inline error on blur')
  assert.equal(key.classList.contains('invalid'), false)

  // The submit gate is untouched by the blur feedback.
  fillRegistration(page, { key: 'reg.dot.' })
  submitRegistration(page)
  assert.match(fieldError(page, 'regKey'), /不能以 “.” 结尾/)
  assert.equal(postCount(page), before, 'nothing reached the platform in this case')

  saveEvidence(EVIDENCE, 'key-blur-validation.json', {
    blurInvalid: 'Payment_Service → 必须以小写字母或数字开头 + .invalid',
    blurLegal: 'reg-blur-ok → 清错',
    submitGateKept: 'reg.dot. 仍在提交时拦截',
    selectInvalidRule: cssRule(
      readFileSync(join(ROOT, 'apps/web/styles.css'), 'utf8'),
      '.select.invalid'
    ).trim()
  })
  record(
    'key-blur',
    'Key 失焦即校（非法置错/合法清错，0 请求），提交校验保留；.select.invalid 红边规则落地（m-1/m-2）'
  )
}, 120_000)
