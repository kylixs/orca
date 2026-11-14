import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { login, registerHost, saveEvidence, spawnService, type Service } from './harness.ts'
import { loadWebConsolePage, type WebConsolePage } from './web-console-page.ts'

/**
 * AA6 (admin-authorization design §B4): the host drawer carries the platform-only
 * authorization layer, driven through the real console files against a real
 * platform process.
 *
 * - opening 详情 reads that host's grants once and renders the subject ×
 *   provision/maintain/view matrix plus the self-service policy, default open
 * - switching to restricted and saving persists the policy, and the ungranted
 *   developer's self-service call is then refused 403 by the real endpoint
 * - granting the seeded group through the same input lets its member through
 * - a non-admin never reaches the drawer (route guard) and issues zero requests
 * - a failed save rolls the panel back to what the platform holds (QA-009)
 */

const EVIDENCE = 'aa6-host-drawer'
const BASE = ['open', 'terminal', 'agent', 'file:read', 'file:write']

let service: Service
let adminToken = ''
let devToken = ''
let lisiToken = ''
let hostId = ''
const cases: Record<string, string> = {}

type GrantRow = { subjectType: string; subjectId: string; username?: string; permissions: string[] }

async function api(
  path: string,
  init: RequestInit & { token?: string } = {}
  // oxlint-disable-next-line typescript/no-explicit-any -- assert-driven shape as AA2/AA4
): Promise<{ status: number; body: Record<string, any> }> {
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

async function hostGrants(): Promise<GrantRow[]> {
  const res = await api(`/v1/hosts/${hostId}/grants`)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  return res.body.grants
}

async function selfService(
  token: string,
  dir: string
): Promise<{ status: number; code?: string; body: Record<string, any> }> {
  const res = await api('/v1/projects/self', {
    method: 'POST',
    token,
    body: JSON.stringify({ name: dir, dir, hostId })
  })
  return { status: res.status, code: res.body.error?.code, body: res.body }
}

function lastToast(page: WebConsolePage): string {
  return [...page.window.document.querySelectorAll('.toast')].at(-1)?.textContent ?? ''
}

function callsTo(page: WebConsolePage, method: string, path: string): number {
  return page.calls().filter((call) => call === `${method} ${path}`).length
}

/** Logs in and opens this host's drawer through the real 详情 button. */
async function openDrawer(page: WebConsolePage, username: string, password: string): Promise<void> {
  await page.settle()
  await page.submitLogin(username, password)
  await page.clickNav('hosts')
  const button = [
    ...page.window.document.querySelectorAll<HTMLButtonElement>('[data-host]')
  ].find((candidate) => candidate.dataset.host === hostId)
  assert.ok(button, 'the hosts page must list the registered host')
  button.click()
  await page.settle()
}

function matrixHeader(page: WebConsolePage): string[] {
  const drawer = page.window.document.querySelector('.drawer')
  assert.ok(drawer, 'the host drawer must be open')
  return [...drawer.querySelectorAll('thead th')].map((th) => th.textContent?.trim() ?? '')
}

before(async () => {
  service = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN: 'aa6-internal-token' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-web-host-permission-drawer'
  )
  adminToken = await login(service.url, 'admin', 'Adm1n!')
  devToken = await login(service.url, 'zhangsan', 'Passw0rd!')
  lisiToken = await login(service.url, 'lisi', 'Passw0rd!')
  const host = await registerHost({
    apiUrl: service.url,
    adminToken,
    name: 'dev-aa6-drawer',
    directAddr: '127.0.0.1:7',
    relayTarget: '127.0.0.1:7',
    projectsRoot: '/srv/aa6'
  })
  hostId = host.hostId
}, 120_000)

after(async () => {
  await service?.stop()
  saveEvidence(EVIDENCE, 'summary.json', {
    workOrder: 'AA6 host permission drawer',
    hostId,
    cases
  })
})

test('AA6-1 admin 打开主机详情：一次 grants 读取，矩阵三位 + 策略开关，open 缺省', async () => {
  const page = loadWebConsolePage(service.url)
  await openDrawer(page, 'admin', 'Adm1n!')

  assert.equal(
    callsTo(page, 'GET', `/v1/hosts/${hostId}/grants`),
    1,
    'opening the drawer reads this host grants exactly once'
  )
  assert.equal(callsTo(page, 'GET', '/v1/directory'), 1, 'the admin picker reads the directory once')

  assert.deepEqual(matrixHeader(page), ['主体', '类型', 'provision', 'maintain', 'view', ''])
  assert.match(page.text('#hostGrantPanel'), /尚无授权/)

  const open = page.window.document.querySelector<HTMLInputElement>(
    'input[name="hostProvisionPolicy"][value="open"]'
  )!
  const restricted = page.window.document.querySelector<HTMLInputElement>(
    'input[name="hostProvisionPolicy"][value="restricted"]'
  )!
  assert.equal(open.checked, true, 'an absent policy must read as open (存量零回归)')
  assert.equal(restricted.checked, false)

  const groups = [
    ...page.window.document.querySelectorAll<HTMLOptionElement>('datalist#hostGrantGroupOptions option')
  ].map((option) => option.value)
  assert.ok(groups.includes('team-payment'), 'the seeded group must be offered')
  const users = [
    ...page.window.document.querySelectorAll<HTMLOptionElement>('datalist#hostGrantUserOptions option')
  ].map((option) => option.value)
  assert.ok(users.includes('zhangsan'), 'user options submit usernames')

  saveEvidence(EVIDENCE, 'drawer-default.json', {
    header: matrixHeader(page),
    openChecked: open.checked,
    groups,
    users
  })
  cases['drawer-default'] = `grants 1 次、目录 1 次；列 ${matrixHeader(page).slice(2, 5).join('/')}；open 缺省勾选`
}, 120_000)

test('AA6-2 改 restricted 并保存：策略落盘，未授权开发者自助建项目 403 HOST_PROVISION_FORBIDDEN', async () => {
  const page = loadWebConsolePage(service.url)
  await openDrawer(page, 'admin', 'Adm1n!')

  const restricted = page.window.document.querySelector<HTMLInputElement>(
    'input[name="hostProvisionPolicy"][value="restricted"]'
  )!
  restricted.checked = true
  restricted.dispatchEvent(new page.window.Event('change', { bubbles: true }))
  page.window.document.querySelector<HTMLButtonElement>('#hostGrantSave')!.click()

  const confirm = page.window.document.querySelector<HTMLButtonElement>('.dialog [data-action="0"]')
  assert.ok(confirm, 'saving must ask for confirmation')
  confirm.click()
  await page.settle()

  assert.match(lastToast(page), /已保存 1 项主机授权变更/)
  assert.equal(callsTo(page, 'PUT', `/v1/hosts/${hostId}/provision-policy`), 1)

  const listed = await api('/v1/hosts')
  const host = (listed.body.hosts as { id: string; provisionPolicy?: string }[]).find(
    (entry) => entry.id === hostId
  )
  assert.equal(host?.provisionPolicy, 'restricted', 'the policy must be persisted')

  const refused = await selfService(lisiToken, 'lisi-aa6-denied')
  assert.equal(refused.status, 403, 'an ungranted developer must be refused')
  assert.equal(refused.code, 'HOST_PROVISION_FORBIDDEN')

  saveEvidence(EVIDENCE, 'restricted.json', {
    toast: lastToast(page),
    persistedPolicy: host?.provisionPolicy,
    refused
  })
  cases['restricted'] = 'UI 保存 restricted → GET /v1/hosts 读到 restricted；lisi 自助建项目 403 HOST_PROVISION_FORBIDDEN'
}, 120_000)

test('AA6-3 组授权：team-payment 经输入框授予，成员 zhangsan 在 restricted 主机放行', async () => {
  const page = loadWebConsolePage(service.url)
  await openDrawer(page, 'admin', 'Adm1n!')

  const input = page.window.document.querySelector<HTMLInputElement>('#hostGrantSubject')!
  input.value = 'team-payment'
  page.window.document.querySelector<HTMLSelectElement>('#hostGrantType')!.value = 'group'
  page.window.document.querySelector<HTMLButtonElement>('#hostGrantAdd')!.click()
  await page.settle()

  assert.match(lastToast(page), /已授予/)
  const rows = await hostGrants()
  const group = rows.find((row) => row.subjectType === 'group' && row.subjectId === 'team-payment')
  assert.ok(group, 'the group row must be stored')
  assert.deepEqual(group.permissions, ['provision'])
  assert.match(page.text('#hostGrantPanel'), /team-payment/, 'the matrix must redraw with the row')

  // zhangsan is in team-payment, so the restricted host now lets them through.
  const granted = await selfService(devToken, 'zhangsan-aa6-granted')
  assert.equal(granted.status, 201, 'a member of the granted group must be allowed')
  assert.equal(granted.body.hostId, hostId)
  for (const permission of BASE) {
    assert.ok(
      (granted.body.permissions as string[]).includes(permission),
      `missing ${permission}`
    )
  }

  saveEvidence(EVIDENCE, 'group-grant.json', { rows, granted: granted.body })
  cases['group-grant'] = 'UI 授予组 team-payment provision；zhangsan（组成员）自助建项目 201'
}, 120_000)

test('AA6-4 非 admin：主机路由 403 页面，零 hosts/grants/目录请求', async () => {
  const page = loadWebConsolePage(service.url)
  await page.settle()
  await page.submitLogin('zhangsan', 'Passw0rd!')
  await page.clickNav('hosts')

  assert.match(page.text('#content'), /无权访问/, 'the admin route must render the forbidden page')
  assert.equal(page.window.document.querySelector('.drawer'), null, 'no drawer may open')
  assert.equal(callsTo(page, 'GET', '/v1/hosts'), 0, 'the hosts list must not be requested')
  assert.equal(callsTo(page, 'GET', `/v1/hosts/${hostId}/grants`), 0)
  assert.equal(callsTo(page, 'GET', '/v1/directory'), 0)

  saveEvidence(EVIDENCE, 'non-admin-calls.json', { calls: page.calls() })
  cases['non-admin'] = '开发者进入主机 → 无权访问，GET /v1/hosts、grants、directory 均为 0 次'
}, 120_000)

test('AA6-5 保存失败：toast 报失败并对齐平台状态回滚（QA-009）', async () => {
  const page = loadWebConsolePage(service.url)
  await openDrawer(page, 'admin', 'Adm1n!')

  const grantsPath = `/v1/hosts/${hostId}/grants`
  page.fail('PUT', grantsPath)
  const maintain = page.window.document.querySelector<HTMLInputElement>(
    '[data-row="group:team-payment"] input[data-host-perm="maintain"]'
  )
  assert.ok(maintain, 'the granted group row must offer all three bits')
  maintain.checked = true
  maintain.dispatchEvent(new page.window.Event('change', { bubbles: true }))
  page.window.document.querySelector<HTMLButtonElement>('#hostGrantSave')!.click()
  page.window.document.querySelector<HTMLButtonElement>('.dialog [data-action="0"]')!.click()
  await page.settle()

  assert.match(lastToast(page), /项失败/, 'a refused save must be reported')
  assert.equal(callsTo(page, 'PUT', grantsPath), 1, 'the failed row was sent once')

  // The panel redrew from GET after the failure: the draft bit is gone.
  const after = page.window.document.querySelector<HTMLInputElement>(
    '[data-row="group:team-payment"] input[data-host-perm="maintain"]'
  )!
  assert.equal(after.checked, false, 'the UI must roll back to what the platform holds')
  const stored = (await hostGrants()).find((row) => row.subjectId === 'team-payment')
  assert.deepEqual(stored?.permissions, ['provision'], 'the failed bit must not be stored')

  page.clearFails()
  saveEvidence(EVIDENCE, 'save-rollback.json', {
    toast: lastToast(page),
    checkedAfter: after.checked,
    stored
  })
  cases['save-rollback'] = 'PUT grants 503 → toast 报项失败；矩阵按 GET 回滚，服务端未落 maintain'
}, 120_000)
