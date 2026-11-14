import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { login, saveEvidence, spawnService, type Service } from './harness.ts'
import { loadWebConsolePage, type WebConsolePage } from './web-console-page.ts'

/**
 * M120c2 (QA-015 / FR-9.4): the settings page grows a per-project override card
 * beside the global one, driven through the real console files against a real
 * platform process.
 *
 * - the card lists exactly the projects the platform holds a pinned override
 *   for (`downloadPolicyExplicit`, M120c1), never the follow-global ones
 * - the scope line counts both groups, and a global save names them in its toast
 * - a row select saves in place: 禁止/允许 pins one PUT, 跟随全局 sends
 *   `inherit:true` and the row leaves the list
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
 * The override card lists pinned rows only (§5.3: a follow-global project has
 * nothing to edit there), so the tests pin and un-pin the way any other admin
 * client would — through the M120c1 endpoint.
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

test('M120c2-1 零覆盖：清单为空、范围统计正确、副标题如实', async () => {
  await setOverride()
  assert.equal(await globalDefault(), 'deny', 'precondition: the shipped default is deny')

  const page = await openSettings('admin', 'Adm1n!')
  const content = page.text('#content')
  assert.match(content, /下载策略：全局默认与项目覆盖。/, 'the subtitle says what the page does')
  assert.doesNotMatch(content, /客户端最低版本/, 'no setting the page does not have')
  assert.match(content, /暂无项目覆盖，全部项目跟随全局默认。/, 'an empty override list is stated')
  assert.match(
    page.text('#policyScope'),
    /跟随全局默认\s*1\s*个项目\s*·\s*独立覆盖\s*0\s*个项目/,
    'the seeded project is the only live one and follows the default'
  )
  assert.equal(overrideSelects(page).length, 0, 'nothing to edit while nothing is pinned')

  saveEvidence(EVIDENCE, 'empty-overrides.json', {
    subtitle: '下载策略：全局默认与项目覆盖。',
    scopeLine: page.text('#policyScope'),
    emptyNote: '暂无项目覆盖，全部项目跟随全局默认。'
  })
  record('empty-state', '零覆盖 → 空态文案 + 统计 跟随全局 1 / 独立覆盖 0 + 副标题改为真实能力')
}, 120_000)

test('M120c2-2 覆盖清单只列 explicit 项目：非覆盖项目不出现，徽标与生效值同行', async () => {
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
  assert.doesNotMatch(card, /order-service/, 'a follow-global project is not listed')
  assert.equal(overrideSelects(page).length, 1, 'exactly one editable row')

  const select = selectFor(page, PROJECT)
  assert.equal(select.value, 'deny', 'the select shows the stored override')
  const row = select.closest('tr')
  assert.match(row?.textContent ?? '', /覆盖/, 'the pinned row carries the 覆盖 badge')
  assert.match(row?.textContent ?? '', /当前生效：禁止/)
  assert.match(
    page.text('#policyScope'),
    /跟随全局默认\s*1\s*个项目\s*·\s*独立覆盖\s*1\s*个项目/,
    'the scope line counts both groups'
  )

  saveEvidence(EVIDENCE, 'override-listing.json', {
    listed: ['payment-service'],
    notListed: ['order-service'],
    scopeLine: page.text('#policyScope'),
    rowBadge: '覆盖',
    rowEffective: '当前生效：禁止'
  })
  record(
    'override-listing',
    'explicit 项目入列（覆盖徽标 + 生效值），非 explicit 的 order-service 不入列；统计 跟随 1 / 覆盖 1'
  )
}, 120_000)

test('M120c2-3 选「跟随全局」发 PUT inherit：行移出清单且 effective 回落全局', async () => {
  await setOverride('deny')
  const page = await openSettings('admin', 'Adm1n!')
  const putsBefore = policyPuts(page)

  choose(page, PROJECT, 'inherit')
  await page.settle()

  assert.equal(policyPuts(page), putsBefore + 1, 'exactly one policy write for the row')
  assert.match(lastToast(page), /已恢复跟随全局默认/)
  const view = await projectView(PROJECT)
  assert.equal(
    view.downloadPolicyExplicit,
    false,
    'the pin is gone server-side — an ordinary PUT would have kept it true'
  )
  const policy = await projectPolicy()
  assert.equal(policy.effective, policy.globalDefault, 'the project follows the default again')

  assert.equal(overrideSelects(page).length, 0, 'the row leaves the list')
  assert.match(page.text('#content'), /暂无项目覆盖，全部项目跟随全局默认。/)
  assert.match(
    page.text('#policyScope'),
    /跟随全局默认\s*2\s*个项目\s*·\s*独立覆盖\s*0\s*个项目/,
    'the counts follow the row out'
  )

  saveEvidence(EVIDENCE, 'inherit-row.json', {
    putRequests: 1,
    downloadPolicyExplicit: view.downloadPolicyExplicit,
    effective: policy.effective,
    scopeLine: page.text('#policyScope')
  })
  record(
    'inherit',
    '行内选 跟随全局 → 1 次 PUT inherit → explicit=false、effective=全局、行移出清单且统计回落 2/0'
  )
}, 120_000)

test('M120c2-4 显式禁止覆盖钉住：全局翻转为 allow 后该行不变，跟随者随之改变', async () => {
  await setOverride('deny')
  const page = await openSettings('admin', 'Adm1n!')
  assert.equal(overrideSelects(page).length, 1, 'the pinned row is listed before the flip')

  // Flip the global default through the UI and read the blast radius off the toast.
  const allow = page.window.document.querySelector<HTMLInputElement>('input[name=dl][value=allow]')!
  allow.checked = true
  page.window.document.querySelector<HTMLButtonElement>('#savePolicy')!.click()
  await page.settle()
  assert.equal(await globalDefault(), 'allow', 'the flip landed')
  assert.match(
    lastToast(page),
    /已保存，30 秒内生效；跟随全局 1 个项目，独立覆盖 1 个不受影响/,
    'the toast names who follows and who is pinned (FR-9.4)'
  )

  // The pinned row is untouched by the flip.
  const pinned = selectFor(page, PROJECT)
  assert.equal(pinned.value, 'deny')
  assert.match(pinned.closest('tr')?.textContent ?? '', /当前生效：禁止/)

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
    toast: '已保存，30 秒内生效；跟随全局 1 个项目，独立覆盖 1 个不受影响',
    pinned: { project: 'payment-service', stored: 'deny', effective: 'deny', badge: '下载已禁用' },
    follower: { project: followProjectId, stored: 'deny', effective: 'allow', badge: '允许下载' }
  })
  record(
    'pinned-vs-flip',
    '全局翻转为 allow：钉住项目仍 禁止（行 + 工作台徽标 + 列表列），跟随项目转为 允许——全部按生效值渲染；toast 报跟随/覆盖数'
  )
}, 120_000)

test('M120c2-5 覆盖保存失败：toast 上报并按服务端值重绘回滚', async () => {
  await setOverride('deny')
  const page = await openSettings('admin', 'Adm1n!')
  const putsBefore = policyPuts(page)

  page.fail('PUT', POLICY_PATH)
  choose(page, PROJECT, 'allow')
  await page.settle()

  assert.equal(policyPuts(page), putsBefore + 1, 'the save was attempted exactly once')
  const toast = lastToast(page)
  assert.match(toast, /保存失败/, 'the failure is reported in the page')
  assert.match(toast, /模拟平台故障/, 'the platform reason is carried')
  const select = selectFor(page, PROJECT)
  assert.equal(select.value, 'deny', 'the row falls back to the value the platform holds')
  assert.equal(
    page.window.document.querySelectorAll('[data-policy-row]').length,
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
    'PUT 注入 503 → toast 保存失败：模拟平台故障，行重绘回 deny 且无重复行，服务端覆盖不变'
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
