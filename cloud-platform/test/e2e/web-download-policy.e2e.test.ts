import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { login, saveEvidence, spawnService, type Service } from './harness.ts'
import { loadWebConsolePage, type WebConsolePage } from './web-console-page.ts'

/**
 * M120c2 (QA-015 / FR-9.4, G27): the settings page grows a per-project policy
 * card beside the global one, driven through the real console files against a
 * real platform process.
 *
 * - the card lists every live project, pinned overrides and follow-global rows
 *   alike (G27 replaced the pinned-only override list); archived projects are
 *   not managed here
 * - the scope line counts all, followers and overrides, and a global save names
 *   the last two in its toast
 * - a row select saves in place: 禁止/允许 pins one PUT, 跟随全局 sends
 *   `inherit:true`, and the row stays in the full list with its source badge
 *   flipped back to follow-global
 * - every row save carries the shared `expectedVersion`
 * - a pinned 禁止 survives a global flip while a follow-global project follows
 *   it — the effective value, not the stored one, drives every badge
 * - a failing save reports and redraws from the platform's value (QA-009)
 * - the card is admin-only: a developer gets the forbidden view and the API
 *   refuses the write outright
 */

const EVIDENCE = 'w120c2-policy-ui'
const PROJECT = 'proj_payment'
const POLICY_PATH = `/v1/projects/${PROJECT}/policy`

let service: Service
let adminToken = ''
let devToken = ''
/** Created in the 显隐 case; the follow-global counterpart of the seeded project. */
let followProjectId = ''
const summary: Record<string, string> = {}

function record(qa: string, detail: string): void {
  summary[qa] = detail
}

async function adminApi(
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

type ProjectView = {
  id: string
  name: string
  status: string
  downloadPolicy: string
  downloadPolicyExplicit: boolean
}

async function projectView(id: string): Promise<ProjectView> {
  const res = await adminApi('/v1/projects')
  assert.equal(res.status, 200, JSON.stringify(res.body))
  const found = (res.body.projects as ProjectView[]).find((project) => project.id === id)
  assert.ok(found, `the platform must list ${id}`)
  return found
}

async function globalDefault(): Promise<string> {
  const res = await adminApi('/v1/policies/download')
  assert.equal(res.status, 200, JSON.stringify(res.body))
  return res.body.downloadDefault
}

type PolicyView = { downloadPolicy: string; effective: string; globalDefault: string }

async function projectPolicy(): Promise<PolicyView> {
  const res = await adminApi(POLICY_PATH)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  return res.body as PolicyView
}

/**
 * The table lists every live project, its row state derived from the platform,
 * so the tests seed pins and follow-global rows the way any other admin client
 * would — through the M120c1 endpoint.
 */
async function setOverride(downloadPolicy?: string): Promise<void> {
  const res = await adminApi(POLICY_PATH, {
    method: 'PUT',
    body: JSON.stringify(downloadPolicy ? { downloadPolicy } : { inherit: true })
  })
  assert.equal(res.status, 200, JSON.stringify(res.body))
}

function overrideSelects(page: WebConsolePage): HTMLSelectElement[] {
  return [...page.window.document.querySelectorAll<HTMLSelectElement>('[data-policy-select]')]
}

function selectFor(page: WebConsolePage, projectId: string): HTMLSelectElement {
  const select = overrideSelects(page).find(
    (candidate) => candidate.dataset.policySelect === projectId
  )
  assert.ok(select, `the override card must render a row for ${projectId}`)
  return select
}

function overrideCard(page: WebConsolePage): string {
  const card = page.window.document.querySelector('#policyScope')?.closest('.card')
  assert.ok(card, 'the override card must be rendered')
  return card.textContent ?? ''
}

/** Setting `value` alone never fires the change handler (same as the matrix suite). */
function choose(page: WebConsolePage, projectId: string, value: string): void {
  const select = selectFor(page, projectId)
  select.value = value
  select.dispatchEvent(new page.window.Event('change', { bubbles: true }))
}

function lastToast(page: WebConsolePage): string {
  const toasts = [...page.window.document.querySelectorAll('.toast')]
  return toasts.at(-1)?.textContent ?? ''
}

function policyPuts(page: WebConsolePage, projectId = PROJECT): number {
  return page.calls().filter((call) => call === `PUT /v1/projects/${projectId}/policy`).length
}

async function openSettings(username: string, password: string): Promise<WebConsolePage> {
  const page = loadWebConsolePage(service.url)
  await page.settle()
  await page.submitLogin(username, password)
  await page.clickNav('settings')
  return page
}

before(async () => {
  service = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN: 'w120c2-internal-token' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-web-download-policy'
  )
  adminToken = await login(service.url, 'admin', 'Adm1n!')
  devToken = await login(service.url, 'zhangsan', 'Passw0rd!')
}, 120_000)

after(async () => {
  await service?.stop()
  saveEvidence(EVIDENCE, 'm120c2-summary.json', {
    workOrder: 'M120c2 设置页项目级下载策略覆盖',
    cases: summary
  })
})

test('M120c2-1 零覆盖：全量在营项目入列、范围统计正确、副标题如实', async () => {
  await setOverride()
  assert.equal(await globalDefault(), 'deny', 'precondition: the shipped default is deny')

  const page = await openSettings('admin', 'Adm1n!')
  const content = page.text('#content')
  assert.match(content, /下载策略：全局默认与项目策略。/, 'the subtitle says what the page does')
  assert.doesNotMatch(content, /客户端最低版本/, 'no setting the page does not have')
  assert.match(content, /项目下载策略/, 'the card is the full project policy list')
  assert.doesNotMatch(
    content,
    /暂无项目覆盖，全部项目跟随全局默认。/,
    'a follow-global project still gets an editable row (G27 full listing)'
  )
  assert.match(
    page.text('#policyScope'),
    /全部\s*1\s*个\s*·\s*跟随全局\s*1\s*个\s*·\s*独立覆盖\s*0\s*个/,
    'the seeded project is the only live one and follows the default'
  )
  assert.equal(overrideSelects(page).length, 1, 'the follow-global row is listed and editable')
  const select = selectFor(page, PROJECT)
  assert.equal(select.value, 'inherit', 'a follow-global row shows the inherit state')
  assert.equal(select.dataset.policyValue, 'inherit', 'the row carries the platform value')
  const inheritOption = select.querySelector<HTMLOptionElement>('option[value=inherit]')!
  assert.match(inheritOption.textContent ?? '', /当前：禁止/, 'the inherit option names the live global')
  const row = select.closest('tr')
  assert.match(
    row?.querySelector('[data-policy-source]')?.textContent ?? '',
    /^跟随全局$/,
    'the follow row carries the 跟随全局 source badge'
  )
  assert.match(row?.textContent ?? '', /当前生效：禁止/)

  saveEvidence(EVIDENCE, 'empty-overrides.json', {
    subtitle: '下载策略：全局默认与项目策略。',
    scopeLine: page.text('#policyScope'),
    followRow: { state: 'inherit', source: '跟随全局', effective: '当前生效：禁止' }
  })
  record('empty-state', '零覆盖 → 跟随行照常入列（inherit + 跟随全局徽标 + 当前生效），统计 全部 1/跟随 1/覆盖 0，副标题改为真实能力')
}, 120_000)

test('M120c2-2 全量清单含跟随行：显式覆盖徽标标明来源，跟随行 value=inherit', async () => {
  const created = await adminApi('/v1/projects', {
    method: 'POST',
    body: JSON.stringify({
      key: 'order-service',
      name: 'order-service',
      hostId: 'host_dev001',
      path: '/srv/work/order-service'
    })
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  followProjectId = created.body.id as string
  // A created project stores deny without a pin: it follows the global default.
  assert.equal((created.body as ProjectView).downloadPolicyExplicit, false)
  await setOverride('deny')

  const page = await openSettings('admin', 'Adm1n!')
  const card = overrideCard(page)
  assert.match(card, /payment-service/, 'the pinned project is listed')
  assert.match(card, /order-service/, 'the follow-global project is listed too (G27)')
  assert.equal(overrideSelects(page).length, 2, 'every live project has one editable row')

  const pinned = selectFor(page, PROJECT)
  assert.equal(pinned.value, 'deny', 'the select shows the stored override')
  const pinnedRow = pinned.closest('tr')
  assert.match(
    pinnedRow?.querySelector('[data-policy-source]')?.textContent ?? '',
    /独立覆盖（与全局相同）/,
    'an explicit value equal to the global is labeled as pinned, not inherited'
  )
  assert.match(pinnedRow?.textContent ?? '', /当前生效：禁止/)

  const follower = selectFor(page, followProjectId)
  assert.equal(follower.value, 'inherit', 'the follow-global row is not pinned')
  assert.match(
    follower.closest('tr')?.querySelector('[data-policy-source]')?.textContent ?? '',
    /^跟随全局$/,
    'the follow row says it follows instead of claiming an override'
  )
  assert.match(follower.closest('tr')?.textContent ?? '', /当前生效：禁止/)
  assert.match(
    page.text('#policyScope'),
    /全部\s*2\s*个\s*·\s*跟随全局\s*1\s*个\s*·\s*独立覆盖\s*1\s*个/,
    'the scope line counts all live projects and both groups'
  )

  saveEvidence(EVIDENCE, 'override-listing.json', {
    listed: ['payment-service（独立覆盖（与全局相同））', 'order-service（跟随全局）'],
    scopeLine: page.text('#policyScope'),
    followValue: follower.value,
    pinnedEffective: '当前生效：禁止'
  })
  record(
    'override-listing',
    '全量清单：payment-service 显式 deny（徽标 独立覆盖（与全局相同））+ order-service 跟随（value=inherit、徽标 跟随全局）；统计 全部 2/跟随 1/覆盖 1'
  )
}, 120_000)

test('M120c2-3 选「跟随全局」发 PUT inherit+expectedVersion：行留在清单且 effective 回落全局', async () => {
  await setOverride('deny')
  const seenVersion = (await adminApi('/v1/policies/download')).body.version as number
  const page = await openSettings('admin', 'Adm1n!')
  const putsBefore = policyPuts(page)

  choose(page, PROJECT, 'inherit')
  await page.settle()

  assert.equal(policyPuts(page), putsBefore + 1, 'exactly one policy write for the row')
  const put = page.bodies().findLast((entry) => entry.call === `PUT ${POLICY_PATH}`)
  assert.deepEqual(
    put?.body,
    { inherit: true, expectedVersion: seenVersion },
    'the inherit shape carries the shared version'
  )
  assert.match(lastToast(page), /已恢复跟随全局默认，将随宿主心跳生效/)
  const view = await projectView(PROJECT)
  assert.equal(
    view.downloadPolicyExplicit,
    false,
    'the pin is gone server-side — an ordinary PUT would have kept it true'
  )
  const policy = await projectPolicy()
  assert.equal(policy.effective, policy.globalDefault, 'the project follows the default again')
  assert.equal(
    (await adminApi('/v1/policies/download')).body.version,
    seenVersion + 1,
    'the row write advances the shared version'
  )

  assert.equal(overrideSelects(page).length, 2, 'the row stays in the full list (no longer leaves)')
  const followSelect = selectFor(page, PROJECT)
  assert.equal(followSelect.value, 'inherit', 'the row redraws in the inherit state')
  assert.match(
    followSelect.closest('tr')?.querySelector('[data-policy-source]')?.textContent ?? '',
    /^跟随全局$/,
    'the source badge flips from override to follow'
  )
  assert.match(followSelect.closest('tr')?.textContent ?? '', /当前生效：禁止/)
  assert.match(
    page.text('#policyScope'),
    /全部\s*2\s*个\s*·\s*跟随全局\s*2\s*个\s*·\s*独立覆盖\s*0\s*个/,
    'the counts follow the row back into the follow group'
  )

  saveEvidence(EVIDENCE, 'inherit-row.json', {
    putRequests: 1,
    putBody: { inherit: true, expectedVersion: seenVersion },
    downloadPolicyExplicit: view.downloadPolicyExplicit,
    effective: policy.effective,
    scopeLine: page.text('#policyScope')
  })
  record(
    'inherit',
    '行内选 跟随全局 → 1 次 PUT {inherit:true, expectedVersion:v} → explicit=false、effective=全局、行仍留清单且徽标转 跟随全局；统计 全部 2/跟随 2/覆盖 0'
  )
}, 120_000)

test('M120c2-4 显式禁止覆盖钉住：全局翻转为 allow 后该行不变，跟随者随之改变', async () => {
  await setOverride('deny')
  const page = await openSettings('admin', 'Adm1n!')
  assert.equal(overrideSelects(page).length, 2, 'both live rows — pinned and following — are listed')
  assert.equal(selectFor(page, PROJECT).value, 'deny', 'the pinned row is listed before the flip')
  assert.equal(selectFor(page, followProjectId).value, 'inherit', 'the follower is listed before the flip')

  // Flip the global default through the UI and read the blast radius off the toast.
  const allow = page.window.document.querySelector<HTMLInputElement>('input[name=dl][value=allow]')!
  allow.checked = true
  page.window.document.querySelector<HTMLButtonElement>('#savePolicy')!.click()
  await page.settle()
  assert.equal(await globalDefault(), 'allow', 'the flip landed')
  assert.match(
    lastToast(page),
    /已保存，将随宿主心跳生效；跟随全局 1 个项目，独立覆盖 1 个不受影响/,
    'the toast names who follows and who is pinned (FR-9.4)'
  )

  // The pinned row is untouched by the flip.
  const pinned = selectFor(page, PROJECT)
  assert.equal(pinned.value, 'deny')
  assert.match(pinned.closest('tr')?.textContent ?? '', /当前生效：禁止/)

  // The follow row keeps its inherit state and picks the new global up.
  const followerSelect = selectFor(page, followProjectId)
  assert.equal(followerSelect.value, 'inherit', 'the flip must not turn the follower into a pin')
  assert.match(
    followerSelect.querySelector<HTMLOptionElement>('option[value=inherit]')?.textContent ?? '',
    /当前：允许/,
    'the inherit option states the new global'
  )
  assert.match(followerSelect.closest('tr')?.textContent ?? '', /当前生效：允许/)

  // The workbench badge is the effective value: the stored-deny follower no longer
  // misreads as 禁用 (the §5.1-1 misreport this work order fixes).
  await page.clickNav('workbench')
  assert.match(page.text('#content'), /禁用下载项目\s*1/)
  const cardFor = (name: string): HTMLElement | undefined =>
    [...page.window.document.querySelectorAll<HTMLElement>('.project-card')].find((card) =>
      card.textContent?.includes(name)
    )
  assert.match(
    cardFor('payment-service')?.querySelector('.foot .badge')?.textContent ?? '',
    /下载已禁用/,
    'a pinned deny stays disabled under a global allow'
  )
  assert.match(
    cardFor('order-service')?.querySelector('.foot .badge')?.textContent ?? '',
    /允许下载/,
    'a follow-global project picks the new default up'
  )
  const follower = await projectView(followProjectId)
  assert.equal(follower.downloadPolicy, 'deny', 'precondition: the follower stores deny')
  assert.equal(follower.downloadPolicyExplicit, false)

  // 我的项目 carries the same derived value in its 下载策略 column.
  await page.clickNav('projects')
  const rowFor = (name: string): HTMLElement | undefined =>
    [...page.window.document.querySelectorAll<HTMLElement>('#projectBody tr')].find((row) =>
      row.textContent?.includes(name)
    )
  assert.match(rowFor('payment-service')?.textContent ?? '', /禁止/)
  assert.match(rowFor('order-service')?.textContent ?? '', /允许/)

  // Leave the shipped default for the cases below.
  const restored = await adminApi('/v1/policies/download', {
    method: 'PUT',
    body: JSON.stringify({ downloadDefault: 'deny' })
  })
  assert.equal(restored.status, 200, JSON.stringify(restored.body))

  saveEvidence(EVIDENCE, 'pinned-vs-global-flip.json', {
    globalDefault: 'allow',
    toast: '已保存，将随宿主心跳生效；跟随全局 1 个项目，独立覆盖 1 个不受影响',
    pinned: { project: 'payment-service', stored: 'deny', effective: 'deny', badge: '下载已禁用' },
    follower: { project: followProjectId, stored: 'deny', effective: 'allow', badge: '允许下载' }
  })
  record(
    'pinned-vs-flip',
    '全局翻转为 allow：钉住项目仍 禁止（行 + 工作台徽标 + 列表列），跟随项目保持 inherit 且生效转为 允许——全部按生效值渲染；toast 报跟随/覆盖数'
  )
}, 120_000)

test('M120c2-5 覆盖保存失败：toast 上报并按服务端值重绘回滚', async () => {
  await setOverride('deny')
  const seenVersion = (await adminApi('/v1/policies/download')).body.version as number
  const page = await openSettings('admin', 'Adm1n!')
  const putsBefore = policyPuts(page)
  const rowsBefore = overrideSelects(page).length
  assert.equal(rowsBefore, 2, 'precondition: both live projects are listed')

  page.fail('PUT', POLICY_PATH)
  choose(page, PROJECT, 'allow')
  await page.settle()

  assert.equal(policyPuts(page), putsBefore + 1, 'the save was attempted exactly once')
  const put = page.bodies().findLast((entry) => entry.call === `PUT ${POLICY_PATH}`)
  assert.deepEqual(
    put?.body,
    { downloadPolicy: 'allow', expectedVersion: seenVersion },
    'the failed row save still carried the shared version'
  )
  const toast = lastToast(page)
  assert.match(toast, /保存失败/, 'the failure is reported in the page')
  assert.match(toast, /模拟平台故障/, 'the platform reason is carried')
  const select = selectFor(page, PROJECT)
  assert.equal(select.value, 'deny', 'the row falls back to the value the platform holds')
  assert.equal(
    overrideSelects(page).length,
    rowsBefore,
    'the redraw keeps one row per live project'
  )
  assert.equal(
    page.window.document.querySelectorAll(`[data-policy-row="${PROJECT}"]`).length,
    1,
    'the redraw replaces the row instead of duplicating it'
  )
  const view = await projectView(PROJECT)
  assert.equal(view.downloadPolicyExplicit, true, 'the platform still holds the pin')
  assert.equal(view.downloadPolicy, 'deny')
  page.clearFails()

  saveEvidence(EVIDENCE, 'save-failure.json', {
    toast: '保存失败：模拟平台故障',
    rolledBackTo: 'deny',
    serverExplicit: view.downloadPolicyExplicit
  })
  record(
    'save-failure',
    'PUT 注入 503 → toast 保存失败：模拟平台故障，行重绘回 deny 且仍为 2 行无重复，服务端覆盖不变'
  )
}, 120_000)

test('M120c2-6 非管理员不可见：设置路由拒绝、不发策略写请求、接口 403', async () => {
  await setOverride('deny')
  const page = loadWebConsolePage(service.url)
  await page.settle()
  await page.submitLogin('zhangsan', 'Passw0rd!')
  assert.equal(page.text('#roleChip'), '开发者')
  assert.equal(page.hidden('#adminNav'), true)

  await page.clickNav('settings')
  assert.match(page.text('#content'), /无权访问/, 'forcing the route lands on the forbidden view')
  assert.doesNotMatch(page.text('#content'), /项目级覆盖/)
  assert.equal(
    page.calls().some((call) => call.startsWith('PUT /v1/projects/')),
    false,
    'the forbidden view never attempts a policy write'
  )

  const direct = await adminApi(POLICY_PATH, {
    method: 'PUT',
    token: devToken,
    body: JSON.stringify({ downloadPolicy: 'allow' })
  })
  assert.equal(direct.status, 403)
  assert.equal(direct.body.error.code, 'PERMISSION_DENIED')
  const view = await projectView(PROJECT)
  assert.equal(view.downloadPolicyExplicit, true, 'the refused write stored nothing')

  saveEvidence(EVIDENCE, 'gating.json', {
    developerSeesOverrideCard: false,
    forcedRoute: '无权访问',
    directPut: { status: direct.status, code: direct.body.error.code },
    serverUnchanged: { downloadPolicy: view.downloadPolicy, explicit: view.downloadPolicyExplicit }
  })
  record(
    'gating',
    '开发者：平台设置路由 → 无权访问、无覆盖卡、零策略写请求；直调 PUT /policy → 403 PERMISSION_DENIED 且状态不变'
  )
}, 120_000)

test('M120c2-7 行级保存整页重绘保留滚动与焦点：连续改行不被弹回页顶', async () => {
  await setOverride('deny')
  const created = await adminApi('/v1/projects', {
    method: 'POST',
    body: JSON.stringify({
      key: 'viewport-check',
      name: 'viewport-check',
      hostId: 'host_dev001',
      path: '/srv/work/viewport-check'
    })
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const otherId = (created.body as ProjectView).id
  const pinOther = await adminApi(`/v1/projects/${otherId}/policy`, {
    method: 'PUT',
    body: JSON.stringify({ downloadPolicy: 'deny' })
  })
  assert.equal(pinOther.status, 200, JSON.stringify(pinOther.body))

  const page = await openSettings('admin', 'Adm1n!')
  assert.equal(
    overrideSelects(page).length,
    3,
    'every live project — both pinned and the following one — is listed'
  )
  const scroller = page.window.document.querySelector<HTMLElement>('#content')!
  scroller.scrollTop = 640
  const target = selectFor(page, otherId)
  target.focus()
  assert.equal(page.window.document.activeElement, target, 'precondition: the admin is on the row')
  const putsBefore = policyPuts(page, otherId)

  choose(page, otherId, 'allow')
  await page.settle()

  assert.equal(policyPuts(page, otherId), putsBefore + 1, 'exactly one policy write for the row')
  assert.equal(scroller.scrollTop, 640, 'the redraw must not throw the admin back to the top (m-7)')
  const refocused = selectFor(page, otherId)
  assert.notEqual(refocused, target, 'the redraw really did build a fresh row')
  assert.equal(
    page.window.document.activeElement,
    refocused,
    'focus lands back on the row that was saved'
  )
  assert.equal(overrideSelects(page).length, 3, 'all rows survive the redraw')
  const view = await projectView(otherId)
  assert.equal(view.downloadPolicyExplicit, true, 'the pin landed server-side')
  assert.equal(view.downloadPolicy, 'allow')

  saveEvidence(EVIDENCE, 'row-save-viewport.json', {
    scrollTopBefore: 640,
    scrollTopAfter: scroller.scrollTop,
    focusRestoredOnRow: otherId,
    putRequests: 1,
    serverPin: { downloadPolicy: view.downloadPolicy, explicit: view.downloadPolicyExplicit }
  })
  record(
    'row-save-viewport',
    '行级保存整页重绘后滚动位置保持（640）、焦点回到所改行；服务端钉住 allow（m-7）'
  )
}, 120_000)

test('M120c2-8 全局保存携带 expectedVersion：成功后本地与服务端版本同步加一', async () => {
  const seen = await adminApi('/v1/policies/download')
  assert.equal(seen.status, 200, JSON.stringify(seen.body))
  assert.equal(seen.body.downloadDefault, 'deny', 'precondition: the shipped default')
  const seenVersion = seen.body.version as number

  const page = await openSettings('admin', 'Adm1n!')
  const allow = page.window.document.querySelector<HTMLInputElement>('input[name=dl][value=allow]')!
  allow.checked = true
  page.window.document.querySelector<HTMLButtonElement>('#savePolicy')!.click()
  await page.settle()

  const put = page.bodies().findLast((entry) => entry.call === 'PUT /v1/policies/download')
  assert.ok(put, 'the save must carry a body')
  const body = put.body as { downloadDefault?: string; expectedVersion?: number }
  assert.equal(body.downloadDefault, 'allow')
  assert.equal(body.expectedVersion, seenVersion, 'the save pins the version it read')

  const after = await adminApi('/v1/policies/download')
  assert.equal(after.body.downloadDefault, 'allow')
  assert.equal(after.body.version, seenVersion + 1, 'the platform version advanced once')
  assert.match(page.text('#content'), /当前版本 v\d+/, 'the card still shows a version')
  assert.match(lastToast(page), /已保存，将随宿主心跳生效/)

  // Keep the shipped default for any later run.
  const restored = await adminApi('/v1/policies/download', {
    method: 'PUT',
    body: JSON.stringify({ downloadDefault: 'deny' })
  })
  assert.equal(restored.status, 200, JSON.stringify(restored.body))

  saveEvidence(EVIDENCE, 'expected-version-save.json', {
    sent: { downloadDefault: 'allow', expectedVersion: seenVersion },
    resultVersion: after.body.version,
    toast: '已保存，将随宿主心跳生效；跟随全局 1 个项目，独立覆盖 2 个不受影响'
  })
  record(
    'expected-version',
    `全局保存 PUT 携带 expectedVersion=${seenVersion}，成功 toast 且服务端版本 ${seenVersion}→${seenVersion + 1}`
  )
}, 120_000)

test('M120c2-9 全局保存 409 冲突：保留所选、展示服务端值、刷新后重试成功', async () => {
  const seeded = await adminApi('/v1/policies/download', {
    method: 'PUT',
    body: JSON.stringify({ downloadDefault: 'deny' })
  })
  assert.equal(seeded.status, 200, JSON.stringify(seeded.body))
  const seen = await adminApi('/v1/policies/download')
  const seenVersion = seen.body.version as number
  const fakeServerVersion = seenVersion + 7

  const page = await openSettings('admin', 'Adm1n!')
  const allow = page.window.document.querySelector<HTMLInputElement>('input[name=dl][value=allow]')!
  allow.checked = true
  page.fail('PUT', '/v1/policies/download', {
    status: 409,
    body: {
      error: {
        code: 'POLICY_VERSION_CONFLICT',
        message: '下载策略已被他人修改，请刷新后重试。',
        details: {
          version: fakeServerVersion,
          downloadDefault: 'deny',
          readRatePerHour: { calls: 1000, bytes: 1048576 }
        }
      }
    }
  })
  page.window.document.querySelector<HTMLButtonElement>('#savePolicy')!.click()
  await page.settle()

  const conflict = page.window.document.querySelector<HTMLElement>('#policyConflict')!
  assert.ok(conflict, 'the conflict must be reported in the global card')
  assert.equal(conflict.hidden, false)
  const conflictText = conflict.textContent ?? ''
  assert.match(conflictText, /策略已被他人修改/, 'the reason is stated, not a generic failure')
  assert.match(conflictText, new RegExp(`服务端当前版本 v${fakeServerVersion}`))
  assert.match(conflictText, /全局默认\s*禁止/, 'the platform value is shown')
  assert.equal(
    page.window.document.querySelector<HTMLInputElement>('input[name=dl][value=allow]')!.checked,
    true,
    'the admin choice is kept, not silently discarded'
  )
  const retryButton = page.window.document.querySelector<HTMLButtonElement>('#policyConflictRetry')
  assert.ok(retryButton, 'a refresh-and-retry action is offered')
  assert.equal(retryButton.textContent, '刷新后重试')

  const unchanged = await adminApi('/v1/policies/download')
  assert.equal(unchanged.body.version, seenVersion, 'the refused write stored nothing')
  assert.equal(unchanged.body.downloadDefault, 'deny')

  page.clearFails()
  const getsBefore = page.calls().filter((call) => call === 'GET /v1/policies/download').length
  retryButton.click()
  await page.settle()

  const retryPut = page.bodies().findLast((entry) => entry.call === 'PUT /v1/policies/download')!
  const retryBody = retryPut.body as { downloadDefault?: string; expectedVersion?: number }
  assert.equal(
    page.calls().filter((call) => call === 'GET /v1/policies/download').length > getsBefore,
    true,
    'retry re-reads the platform version first'
  )
  assert.equal(retryBody.downloadDefault, 'allow', 'retry replays the admin choice')
  assert.equal(retryBody.expectedVersion, seenVersion, 'retry uses the refreshed version')

  const after = await adminApi('/v1/policies/download')
  assert.equal(after.body.downloadDefault, 'allow', 'the retried save landed')
  assert.equal(after.body.version, seenVersion + 1)
  assert.equal(
    page.window.document.querySelector<HTMLElement>('#policyConflict')?.hidden ?? true,
    true,
    'the conflict notice is gone after the successful retry'
  )
  assert.match(lastToast(page), /已保存/)

  const restored = await adminApi('/v1/policies/download', {
    method: 'PUT',
    body: JSON.stringify({ downloadDefault: 'deny' })
  })
  assert.equal(restored.status, 200, JSON.stringify(restored.body))

  saveEvidence(EVIDENCE, 'version-conflict-ui.json', {
    stubVersion: fakeServerVersion,
    serverHeld: { version: seenVersion, downloadDefault: 'deny' },
    choicePreserved: 'allow',
    retry: { expectedVersion: seenVersion, downloadDefault: 'allow' },
    result: { version: after.body.version, downloadDefault: after.body.downloadDefault }
  })
  record(
    'version-conflict',
    '409 注入：卡内黄条报冲突与服务端版本/值、radio 保留 allow、服务端未变；刷新后重试先 GET 再以新版本重放 allow 成功'
  )
}, 120_000)
