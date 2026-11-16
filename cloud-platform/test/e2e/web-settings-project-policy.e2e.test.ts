import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { login, saveEvidence, spawnService, type Service } from './harness.ts'
import { loadWebConsolePage, type WebConsolePage } from './web-console-page.ts'

/**
 * G27 W7: 平台设置 lists every live project (not only the pinned overrides) and
 * saves each row's three-state download policy with the shared `expectedVersion`.
 *
 * - archived projects never appear (T6/Q8)
 * - follow-global rows are editable: picking 禁止/允许 pins an override, so the
 *   WEB-R2-009 gap (no way to add an override) is closed
 * - a 409 keeps the admin's choice in place, states the server version/value,
 *   and 刷新后重试 re-reads the version before replaying the choice (T7)
 * - a global flip moves every follow-global row and no pinned row
 * - >200 live projects get a client-side search box (T12)
 * - copy says only 随宿主心跳生效; no 30 秒/已同步 claim (T8)
 */

const EVIDENCE = 'u116-g27-settings'
const PROJECT = 'proj_payment'
const FOLLOW_KEY = 'order-service'
const ARCHIVED_KEY = 'archived-check'

let service: Service
let adminToken = ''
let followProjectId = ''
const summary: Record<string, string> = {}

function record(qa: string, detail: string): void {
  summary[qa] = detail
}

async function adminApi(
  path: string,
  init: RequestInit & { token?: string } = {}
  // oxlint-disable-next-line typescript/no-explicit-any -- assert-driven response shape
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

async function createProject(key: string, name = key): Promise<string> {
  const created = await adminApi('/v1/projects', {
    method: 'POST',
    body: JSON.stringify({ key, name, hostId: 'host_dev001', path: `/srv/work/${key}` })
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  return created.body.id as string
}

async function archiveProject(id: string): Promise<void> {
  const archived = await adminApi(`/v1/projects/${id}/archive`, { method: 'POST' })
  assert.equal(archived.status, 200, JSON.stringify(archived.body))
}

async function setPolicy(id: string, body: Record<string, unknown>): Promise<void> {
  const res = await adminApi(`/v1/projects/${id}/policy`, {
    method: 'PUT',
    body: JSON.stringify(body)
  })
  assert.equal(res.status, 200, JSON.stringify(res.body))
}

async function policeVersion(): Promise<number> {
  const res = await adminApi('/v1/policies/download')
  assert.equal(res.status, 200, JSON.stringify(res.body))
  return res.body.version as number
}

async function projectRow(id: string): Promise<{ downloadPolicy: string; downloadPolicyExplicit: boolean }> {
  const res = await adminApi('/v1/projects')
  assert.equal(res.status, 200, JSON.stringify(res.body))
  const found = (res.body.projects as { id: string }[]).find((project) => project.id === id)
  assert.ok(found, `the platform must list ${id}`)
  return found as { downloadPolicy: string; downloadPolicyExplicit: boolean }
}

function policySelects(page: WebConsolePage): HTMLSelectElement[] {
  return [...page.window.document.querySelectorAll<HTMLSelectElement>('[data-policy-select]')]
}

function selectFor(page: WebConsolePage, projectId: string): HTMLSelectElement {
  const select = policySelects(page).find(
    (candidate) => candidate.dataset.policySelect === projectId
  )
  assert.ok(select, `the policy table must render a row for ${projectId}`)
  return select
}

function rowFor(page: WebConsolePage, projectId: string): HTMLElement {
  const row = page.window.document.querySelector<HTMLElement>(`[data-policy-row="${projectId}"]`)
  assert.ok(row, `the policy table must render a row for ${projectId}`)
  return row
}

function choose(page: WebConsolePage, projectId: string, value: string): void {
  const select = selectFor(page, projectId)
  select.value = value
  select.dispatchEvent(new page.window.Event('change', { bubbles: true }))
}

function lastToast(page: WebConsolePage): string {
  return [...page.window.document.querySelectorAll('.toast')].at(-1)?.textContent ?? ''
}

function policyPath(projectId: string): string {
  return `/v1/projects/${projectId}/policy`
}

async function openSettings(): Promise<WebConsolePage> {
  const page = loadWebConsolePage(service.url)
  await page.settle()
  await page.submitLogin('admin', 'Adm1n!')
  await page.clickNav('settings')
  return page
}

before(async () => {
  service = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN: 'u116-g27-settings-internal' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-u116-g27-settings'
  )
  adminToken = await login(service.url, 'admin', 'Adm1n!')
  followProjectId = await createProject(FOLLOW_KEY)
  const archivedId = await createProject(ARCHIVED_KEY)
  await archiveProject(archivedId)
}, 120_000)

after(async () => {
  await service?.stop()
  saveEvidence(EVIDENCE, 'g27-summary.json', {
    workOrder: 'G27 设置页全量项目下载策略',
    cases: summary
  })
})

test('G27-1 全量在营项目入列：跟随行、覆盖行都在，归档项目不出现', async () => {
  await setPolicy(PROJECT, { downloadPolicy: 'deny' })
  await setPolicy(followProjectId, { inherit: true })

  const page = await openSettings()
  const names = policySelects(page).map((select) => select.dataset.policySelect)
  assert.equal(names.length, 2, 'both live projects get an editable row')
  assert.deepEqual(new Set(names), new Set([PROJECT, followProjectId]))
  const card = page.window.document.querySelector('#policyScope')?.closest('.card')!
  assert.match(card.textContent ?? '', /项目下载策略/, 'the card is a project-policy overview')
  assert.doesNotMatch(card.textContent ?? '', /archived-check/, 'archived projects are not listed')
  assert.match(
    page.text('#policyScope'),
    /全部\s*2\s*个\s*·\s*跟随全局\s*1\s*个\s*·\s*独立覆盖\s*1\s*个/,
    'the scope line counts all live projects'
  )
  assert.match(
    card.textContent ?? '',
    /随宿主下一次心跳生效/,
    'the card states when a policy takes effect'
  )
  assert.doesNotMatch(card.textContent ?? '', /30 秒|主机已确认/, 'no fake sync claim')

  saveEvidence(EVIDENCE, 'full-listing.json', {
    liveRows: [PROJECT, followProjectId],
    archivedListed: false,
    scopeLine: page.text('#policyScope')
  })
  record('full-listing', '两个在营项目全部入列（含跟随全局），归档项目不出现；统计 全部 2/跟随 1/覆盖 1')
}, 120_000)

test('G27-2 三态映射与来源徽标：跟随全局选项带当前值，显式等于全局时标明与全局相同', async () => {
  await setPolicy(PROJECT, { downloadPolicy: 'deny' })
  await setPolicy(followProjectId, { downloadPolicy: 'allow' })

  const page = await openSettings()
  const follow = selectFor(page, PROJECT)
  // PROJECT is pinned deny while the global default is deny: still a pin, not inheritance.
  assert.equal(follow.value, 'deny')
  assert.match(rowFor(page, PROJECT).textContent ?? '', /独立覆盖（与全局相同）/)

  const other = selectFor(page, followProjectId)
  assert.equal(other.value, 'allow')
  assert.match(rowFor(page, followProjectId).textContent ?? '', /独立覆盖/)

  await setPolicy(followProjectId, { inherit: true })
  const page2 = await openSettings()
  const inherited = selectFor(page2, followProjectId)
  assert.equal(inherited.value, 'inherit')
  const inheritOption = inherited.querySelector<HTMLOptionElement>('option[value=inherit]')!
  assert.match(inheritOption.textContent ?? '', /跟随全局/, 'the option names inheritance')
  assert.match(inheritOption.textContent ?? '', /当前：禁止/, 'the option carries the live global value')
  assert.match(rowFor(page2, followProjectId).textContent ?? '', /跟随全局/)
  assert.match(rowFor(page2, followProjectId).textContent ?? '', /当前生效：禁止/)

  saveEvidence(EVIDENCE, 'tri-state.json', {
    pinnedSameAsGlobal: '独立覆盖（与全局相同）',
    inheritOption: inheritOption.textContent,
    effective: '当前生效：禁止'
  })
  record('tri-state', '显式 deny 且全局 deny → 独立覆盖（与全局相同）；follow 行 value=inherit 且选项含 当前：禁止')
}, 120_000)

test('G27-3 行内保存携带 expectedVersion：新建覆盖与回退继承都成功且版本推进', async () => {
  await setPolicy(followProjectId, { inherit: true })
  const seenVersion = await policeVersion()
  const page = await openSettings()

  choose(page, followProjectId, 'allow')
  await page.settle()

  const put = page.bodies().findLast((entry) => entry.call === `PUT ${policyPath(followProjectId)}`)
  assert.ok(put, 'the row save must carry a body')
  assert.deepEqual(put.body, { downloadPolicy: 'allow', expectedVersion: seenVersion })
  assert.equal((await policeVersion()), seenVersion + 1, 'a row write advances the shared version')
  assert.equal((await projectRow(followProjectId)).downloadPolicyExplicit, true)
  assert.match(rowFor(page, followProjectId).textContent ?? '', /独立覆盖/)
  assert.match(lastToast(page), /已保存项目下载策略/, 'the success toast names the save')
  assert.match(lastToast(page), /随宿主心跳生效/, 'and says when it takes effect')

  const afterPin = await policeVersion()
  choose(page, followProjectId, 'inherit')
  await page.settle()
  const unPin = page.bodies().findLast((entry) => entry.call === `PUT ${policyPath(followProjectId)}`)
  assert.deepEqual(unPin?.body, { inherit: true, expectedVersion: afterPin })
  assert.equal((await projectRow(followProjectId)).downloadPolicyExplicit, false)
  assert.match(rowFor(page, followProjectId).textContent ?? '', /跟随全局/)
  assert.match(lastToast(page), /已恢复跟随全局默认/)

  saveEvidence(EVIDENCE, 'expected-version.json', {
    createOverride: { downloadPolicy: 'allow', expectedVersion: seenVersion },
    revertInherit: { inherit: true, expectedVersion: afterPin },
    versionAfterCreate: seenVersion + 1
  })
  record('expected-version', '跟随行选允许 → PUT {downloadPolicy:allow, expectedVersion:v}；回退 → {inherit:true, expectedVersion:v+1}')
}, 120_000)

test('G27-4 行级 409：保留选择、报服务端版本/值，刷新后重试先 GET 再重放', async () => {
  await setPolicy(followProjectId, { inherit: true })
  const seenVersion = await policeVersion()
  const fakeVersion = seenVersion + 7
  const page = await openSettings()

  page.fail('PUT', policyPath(followProjectId), {
    status: 409,
    body: {
      error: {
        code: 'POLICY_VERSION_CONFLICT',
        message: '下载策略已被他人修改，请刷新后重试。',
        details: { version: fakeVersion, downloadPolicy: 'deny' }
      }
    }
  })
  choose(page, followProjectId, 'allow')
  await page.settle()

  assert.equal(selectFor(page, followProjectId).value, 'allow', 'the admin choice is not discarded')
  const conflict = rowFor(page, followProjectId).querySelector<HTMLElement>(
    `[data-policy-conflict="${followProjectId}"]`
  )!
  assert.ok(conflict, 'the conflict is reported in the row')
  assert.equal(conflict.hidden, false)
  assert.match(conflict.textContent ?? '', /策略已被他人修改/)
  assert.match(conflict.textContent ?? '', new RegExp(`服务端 v${fakeVersion}`))
  assert.match(conflict.textContent ?? '', /当前值：禁止/)
  const retry = conflict.querySelector<HTMLButtonElement>('[data-policy-retry]')
  assert.ok(retry, 'a refresh-and-retry action is offered')
  assert.equal(retry.textContent, '刷新后重试')
  assert.equal(await policeVersion(), seenVersion, 'the refused write stored nothing')

  page.clearFails()
  const getsBefore = page
    .calls()
    .filter((call) => call === 'GET /v1/policies/download').length
  retry.click()
  await page.settle()

  assert.ok(
    page.calls().filter((call) => call === 'GET /v1/policies/download').length > getsBefore,
    'retry re-reads the platform version first'
  )
  const retryPut = page
    .bodies()
    .findLast((entry) => entry.call === `PUT ${policyPath(followProjectId)}`)
  assert.deepEqual(retryPut?.body, { downloadPolicy: 'allow', expectedVersion: seenVersion })
  assert.equal((await projectRow(followProjectId)).downloadPolicyExplicit, true, 'the replay landed')
  assert.equal(
    rowFor(page, followProjectId).querySelector<HTMLElement>('[data-policy-conflict]')?.hidden ?? true,
    true,
    'the conflict notice is gone after a successful retry'
  )
  assert.match(lastToast(page), /已保存项目下载策略/)

  saveEvidence(EVIDENCE, 'row-conflict.json', {
    stubVersion: fakeVersion,
    choicePreserved: 'allow',
    retry: { downloadPolicy: 'allow', expectedVersion: seenVersion }
  })
  record('row-conflict', '409 行内报服务端 v+7/当前值禁止、选择保留 allow；刷新后重试 GET 后以当前版本重放成功')
}, 120_000)

test('G27-5 全局联动：跟随行随全局、覆盖行不动，文案只承诺宿主心跳', async () => {
  await setPolicy(PROJECT, { downloadPolicy: 'deny' })
  await setPolicy(followProjectId, { inherit: true })
  const page = await openSettings()
  assert.match(rowFor(page, followProjectId).textContent ?? '', /当前生效：禁止/)
  assert.match(rowFor(page, PROJECT).textContent ?? '', /当前生效：禁止/)

  const allow = page.window.document.querySelector<HTMLInputElement>('input[name=dl][value=allow]')!
  allow.checked = true
  page.window.document.querySelector<HTMLButtonElement>('#savePolicy')!.click()
  await page.settle()

  assert.match(rowFor(page, followProjectId).textContent ?? '', /当前生效：允许/, 'followers move with the global')
  assert.match(rowFor(page, PROJECT).textContent ?? '', /当前生效：禁止/, 'pinned rows do not move')
  assert.match(
    page.text('#policyScope'),
    /全部\s*2\s*个\s*·\s*跟随全局\s*1\s*个\s*·\s*独立覆盖\s*1\s*个/
  )
  assert.match(lastToast(page), /随宿主心跳生效/, 'the toast says it follows the host heartbeat')
  assert.doesNotMatch(lastToast(page), /30 秒|已同步/)
  // The required disclaimer itself says 不显示「已同步」, so only real claims are banned.
  assert.doesNotMatch(page.text('#content'), /30 秒|主机已确认/)
  assert.match(page.text('#content'), /随宿主下一次心跳生效/)
  assert.match(page.text('#content'), /不轮询主机确认/)

  const restored = await adminApi('/v1/policies/download', {
    method: 'PUT',
    body: JSON.stringify({ downloadDefault: 'deny' })
  })
  assert.equal(restored.status, 200, JSON.stringify(restored.body))

  saveEvidence(EVIDENCE, 'global-linkage.json', {
    followerEffective: '允许',
    pinnedEffective: '禁止',
    scopeLine: page.text('#policyScope')
  })
  record('global-linkage', '全局翻 allow：跟随行生效变允许、钉住行仍禁止；toast/页面只说宿主心跳生效，无 30 秒/已同步')
}, 120_000)

test('G27-6 超过 200 个项目：渲染前端搜索框并可过滤，不分页', async () => {
  const projects = Array.from({ length: 201 }, (_, index) => ({
    id: `proj_bulk_${index}`,
    name: `bulk-project-${String(index).padStart(3, '0')}`,
    key: `bulk-${index}`,
    path: `/srv/work/bulk-${index}`,
    status: 'ready',
    downloadPolicy: 'deny',
    downloadPolicyExplicit: false
  }))
  const page = loadWebConsolePage(service.url)
  await page.settle()
  await page.submitLogin('admin', 'Adm1n!')
  page.fail('GET', '/v1/projects', { status: 200, body: { projects } })
  await page.clickNav('settings')

  assert.equal(policySelects(page).length, 201, 'all projects render in one page (no pagination)')
  const search = page.window.document.querySelector<HTMLInputElement>('#policySearch')
  assert.ok(search, 'a search box appears past 200 projects')
  search.value = 'bulk-project-137'
  search.dispatchEvent(new page.window.Event('input', { bubbles: true }))

  const visible = [...page.window.document.querySelectorAll<HTMLElement>('[data-policy-row]')].filter(
    (row) => row.style.display !== 'none'
  )
  assert.equal(visible.length, 1)
  assert.match(visible[0].textContent ?? '', /bulk-project-137/)
  page.clearFails()

  saveEvidence(EVIDENCE, 'search.json', {
    renderedRows: 201,
    search: 'bulk-project-137',
    visibleRows: visible.length
  })
  record('search', '201 个项目一次性渲染，出现搜索框；过滤 bulk-project-137 后仅 1 行可见')
}, 120_000)
