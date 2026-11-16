import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { login, registerHost, saveEvidence, spawnService, type Service } from './harness.ts'
import { loadWebConsolePage, type WebConsolePage } from './web-console-page.ts'

/**
 * AA6 migrated to the U67 drawer: the host 详情 drawer carries an 信息|权限 tab
 * pair and the permission tab is the only host-grant entry — three role cards
 * (查看/控制/管理) that expand to the stored bit rows. The legacy provision
 * policy switch is gone from the UI (U65 D7; the endpoint stays).
 *
 * - opening 详情 reads that host's grants once and renders the three cards
 * - adding a subject to 查看 writes exactly the view bits, immediately
 * - adding the same subject to 控制 asks the overwrite confirmation (只读→全权)
 *   and unions to view+provision after confirming
 * - a failed add is reported and stores nothing (QA-009)
 * - a non-admin never reaches the drawer (route guard) and issues zero requests
 */

const EVIDENCE = 'aa6-host-drawer'

let service: Service
let adminToken = ''
let lisiToken = ''
let hostId = ''
const cases: Record<string, string> = {}

type GrantRow = { subjectType: string; subjectId: string; username?: string; permissions: string[] }

async function api(
  path: string,
  init: RequestInit & { token?: string } = {}
  // oxlint-disable-next-line typescript/no-explicit-any -- assert-driven shape as AA4/U67
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

function lastToast(page: WebConsolePage): string {
  return [...page.window.document.querySelectorAll('.toast')].at(-1)?.textContent ?? ''
}

function callsTo(page: WebConsolePage, method: string, path: string): number {
  return page.calls().filter((call) => call === `${method} ${path}`).length
}

function drawer(page: WebConsolePage): HTMLElement {
  const found = page.window.document.querySelector<HTMLElement>('.drawer')
  assert.ok(found, 'the host drawer must be open')
  return found
}

function permCard(page: WebConsolePage, key: string): HTMLElement {
  const found = drawer(page).querySelector<HTMLElement>(`[data-perm-cards] > [data-card="${key}"]`)
  assert.ok(found, `the permission tab must render the ${key} card`)
  return found
}

/** The top-most dialog: the drawer stays open under its confirmations. */
function topDialog(page: WebConsolePage): HTMLElement {
  const dialogs = [
    ...page.window.document.querySelectorAll<HTMLElement>('.dialog-backdrop .dialog')
  ]
  assert.ok(dialogs.length > 0, 'a dialog must be open')
  return dialogs[dialogs.length - 1]
}

/** Adds `subject` to a card through the real input + type select + button. */
async function addToCard(
  page: WebConsolePage,
  cardKey: string,
  subjectType: 'user' | 'group',
  subject: string
): Promise<void> {
  const card = permCard(page, cardKey)
  card.querySelector<HTMLInputElement>('[data-perm-subject]')!.value = subject
  const select = card.querySelector<HTMLSelectElement>('[data-perm-type]')!
  select.value = subjectType
  select.dispatchEvent(new page.window.Event('change', { bubbles: true }))
  card.querySelector<HTMLButtonElement>('[data-perm-add]')!.click()
  await page.settle()
}

/** Logs in and opens this host's drawer through the real 详情 button. */
async function openDrawer(page: WebConsolePage, username: string, password: string): Promise<void> {
  await page.settle()
  await page.submitLogin(username, password)
  await page.clickNav('hosts')
  const button = [...page.window.document.querySelectorAll<HTMLButtonElement>('[data-host]')].find(
    (candidate) => candidate.dataset.host === hostId
  )
  assert.ok(button, 'the hosts page must list the registered host')
  button.click()
  await page.settle()
}

async function openPermTab(
  page: WebConsolePage,
  username: string,
  password: string
): Promise<void> {
  await openDrawer(page, username, password)
  const tab = drawer(page).querySelector<HTMLButtonElement>('[data-auth-tab="perms"]')
  assert.ok(tab, 'the drawer must offer the 权限 tab')
  tab.click()
  await page.settle()
}

before(async () => {
  service = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN: 'aa6-internal-token' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-web-host-permission-drawer'
  )
  adminToken = await login(service.url, 'admin', 'Adm1n!')
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
    workOrder: 'AA6 host permission drawer (U67 card form)',
    hostId,
    cases
  })
})

test('AA6-1 admin 打开主机详情权限页签：grants 一次、三卡片渲染、策略开关移除', async () => {
  const page = loadWebConsolePage(service.url)
  await openPermTab(page, 'admin', 'Adm1n!')

  assert.equal(
    callsTo(page, 'GET', `/v1/hosts/${hostId}/grants`),
    1,
    'opening the drawer reads this host grants exactly once'
  )
  assert.equal(
    callsTo(page, 'GET', '/v1/directory'),
    1,
    'the admin picker reads the directory once'
  )

  for (const key of ['view', 'control', 'manage']) {
    assert.match(permCard(page, key).textContent ?? '', /个主体/, `${key} card renders`)
  }
  // U67-3a 审定二：卡头只有角色名 + 主体计数，不暴露权限位。
  const cardKeys = [...drawer(page).querySelectorAll<HTMLElement>(
    '[data-perm-cards] > .perm-card[data-card]'
  )].map((card) => card.dataset.card)
  assert.deepEqual(cardKeys.slice(0, 3), ['view', 'control', 'manage'], 'cards are 查看/控制/管理')
  for (const key of ['view', 'control', 'manage']) {
    const head = permCard(page, key).querySelector<HTMLElement>('.perm-card-head')!
    assert.equal(head.querySelector('.badge'), null, `${key} head has no bit badge`)
    assert.doesNotMatch(
      head.textContent ?? '',
      /view|provision|maintain|全权|只读/,
      `${key} head names only the role`
    )
  }
  assert.equal(
    permCard(page, 'view')
      .querySelector<HTMLInputElement>('[data-perm-subject]')!
      .getAttribute('list'),
    'hostUserOptions',
    'the add row defaults to 用户, per the prototype'
  )
  assert.equal(
    page.window.document.querySelector('input[name="hostProvisionPolicy"]'),
    null,
    'the legacy policy switch is gone from the drawer'
  )
  assert.equal(
    page.window.document.querySelector('#hostGrantPanel'),
    null,
    'the old matrix is gone'
  )

  const groups = [
    ...permCard(page, 'view').querySelectorAll<HTMLOptionElement>('datalist > option, option')
  ].length
  assert.equal(
    page.window.document.querySelectorAll('datalist#hostGroupOptions option').length > 0,
    true,
    'group datalist offers the seeded groups'
  )
  assert.ok(groups >= 0)

  saveEvidence(EVIDENCE, 'drawer-default.json', {
    cards: ['view', 'control', 'manage'],
    policySwitchRemoved: true,
    matrixRemoved: true
  })
  cases['drawer-default'] =
    'grants 1 次、目录 1 次；查看/控制/管理 三卡片渲染，策略开关与旧矩阵移除'
}, 120_000)

test('AA6-2 查看卡添加组：整行即存 view 位，chip 只含名字+类型，未授权者自助 403', async () => {
  const page = loadWebConsolePage(service.url)
  await openPermTab(page, 'admin', 'Adm1n!')

  await addToCard(page, 'view', 'group', 'team-payment')
  assert.match(lastToast(page), /已保存「查看」授权：只读/)

  const rows = await hostGrants()
  const group = rows.find((row) => row.subjectType === 'group' && row.subjectId === 'team-payment')
  assert.ok(group, 'the group row must be stored')
  assert.deepEqual(group.permissions, ['view'], 'the 查看 card writes exactly the view bit')
  const chip = [...permCard(page, 'view').querySelectorAll<HTMLElement>('.perm-chip')].find(
    (candidate) => candidate.textContent?.includes('team-payment')
  )
  assert.match(chip?.textContent ?? '', /组/, 'the chip carries the type badge')
  assert.doesNotMatch(
    chip?.textContent ?? '',
    /只读|全权|view|provision|maintain/,
    'chips carry no permission words (U67 审定二)'
  )

  // No provision anywhere: an ungranted developer stays refused at the platform.
  const refused = await api('/v1/projects/self', {
    method: 'POST',
    token: lisiToken,
    body: JSON.stringify({ name: 'aa6-denied', dir: 'aa6-denied', hostId })
  })
  assert.equal(refused.status, 403)
  assert.equal(refused.body.error.code, 'HOST_PROVISION_FORBIDDEN')

  saveEvidence(EVIDENCE, 'view-card.json', { rows, refused: refused.status })
  cases['view-card'] =
    '查看卡添加 team-payment → 立即 PUT 落 view 位；lisi 自助建项目 403 HOST_PROVISION_FORBIDDEN'
}, 120_000)

test('AA6-3 控制卡加同一主体：覆盖确认 只读→全权，确认后并集 view+provision', async () => {
  const page = loadWebConsolePage(service.url)
  await openPermTab(page, 'admin', 'Adm1n!')
  const putsBefore = callsTo(page, 'PUT', `/v1/hosts/${hostId}/grants`)

  await addToCard(page, 'control', 'group', 'team-payment')

  const dialog = topDialog(page)
  assert.match(dialog.textContent ?? '', /覆盖现有授权/, 'an existing subject must confirm first')
  assert.match(dialog.textContent ?? '', /级别：只读 → 全权/, 'the union reads as the new level')
  assert.equal(
    callsTo(page, 'PUT', `/v1/hosts/${hostId}/grants`),
    putsBefore,
    'nothing lands before the confirmation'
  )
  dialog.querySelector<HTMLButtonElement>('[data-action="0"]')!.click()
  await page.settle()

  assert.equal(callsTo(page, 'PUT', `/v1/hosts/${hostId}/grants`), putsBefore + 1)
  const group = (await hostGrants()).find((row) => row.subjectId === 'team-payment')!
  assert.deepEqual(
    [...group.permissions].sort(),
    ['provision', 'view'],
    'the confirmed add unions the card bits (maintain excluded by verdict)'
  )
  const chips = [...drawer(page).querySelectorAll<HTMLElement>('.perm-chip')].filter((candidate) =>
    candidate.textContent?.includes('team-payment')
  )
  assert.equal(chips.length, 1, 'the subject lives in exactly one card (highest level only)')
  assert.ok(
    permCard(page, 'control').contains(chips[0]),
    'view+provision is rendered in 控制, not 查看'
  )
  assert.doesNotMatch(
    chips[0].textContent ?? '',
    /全权|只读|view|provision|maintain/,
    'chips carry no permission words (U67 审定二)'
  )

  saveEvidence(EVIDENCE, 'control-overwrite.json', { group })
  cases['control-overwrite'] = '控制卡加已有主体 → 覆盖确认（只读→全权）→ 并集 view+provision 落库'
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

test('AA6-5 添加失败：toast 报错、输入保留、平台状态不变（QA-009）', async () => {
  const page = loadWebConsolePage(service.url)
  await openPermTab(page, 'admin', 'Adm1n!')
  const grantsPath = `/v1/hosts/${hostId}/grants`
  const loadsBefore = callsTo(page, 'GET', grantsPath)

  page.fail('PUT', grantsPath)
  await addToCard(page, 'manage', 'user', 'lisi')

  assert.match(lastToast(page), /授予失败/, 'a refused add must be reported')
  assert.equal(callsTo(page, 'PUT', grantsPath), 1, 'the failed add was sent once')
  assert.equal(
    callsTo(page, 'GET', grantsPath),
    loadsBefore,
    'a refusal never redraws from the platform'
  )
  const input = permCard(page, 'manage').querySelector<HTMLInputElement>('[data-perm-subject]')!
  assert.equal(input.value, 'lisi', 'the typed subject survives the refusal')
  assert.deepEqual(await hostGrants().then((rows) => rows.length), 1, 'nothing was stored')
  assert.deepEqual(
    (await hostGrants()).find((row) => row.subjectId === 'team-payment')?.permissions,
    ['provision', 'view'],
    'the failed 管理 add must not touch stored rows'
  )

  page.clearFails()
  saveEvidence(EVIDENCE, 'add-rollback.json', { toast: lastToast(page) })
  cases['add-rollback'] = 'PUT grants 503 → toast 授予失败、输入保留、平台行不变（QA-009）'
}, 120_000)

/**
 * U67-3a 结构契约（审定二 · 位置即权限 · 层级单卡）：存储仍是位组合，读取时
 * 按 查看 < 控制 < 管理 推导唯一归属卡，主体不跨卡、chip 不带权限词尾注。
 */
test('U67-3a 三卡结构：卡头无位徽标、chips 只有名字+类型、主体只出现在最高级别卡', async () => {
  const rows = [
    { subjectType: 'group', subjectId: 'developers', permissions: ['view'] },
    { subjectType: 'user', subjectId: 'lisi', permissions: ['view', 'provision'] },
    { subjectType: 'group', subjectId: 'platform-admins', permissions: ['provision', 'maintain'] },
    {
      subjectType: 'group',
      subjectId: 'team-payment',
      permissions: ['view', 'provision', 'maintain']
    }
  ]
  for (const row of rows) {
    const res = await api(`/v1/hosts/${hostId}/grants`, {
      method: 'PUT',
      body: JSON.stringify(row)
    })
    assert.equal(res.status, 200, JSON.stringify(res.body))
  }

  const page = loadWebConsolePage(service.url)
  await openPermTab(page, 'admin', 'Adm1n!')

  const cards = [
    ...drawer(page).querySelectorAll<HTMLElement>('[data-perm-cards] > .perm-card[data-card]')
  ]
  assert.deepEqual(
    cards.map((card) => card.dataset.card),
    ['view', 'control', 'manage'],
    'cards render top-to-bottom 查看/控制/管理'
  )

  const chipSubjects = (key: string): string[] =>
    [...permCard(page, key).querySelectorAll<HTMLElement>('.perm-chip')].map(
      (chip) => chip.querySelector('.mono')?.textContent ?? ''
    )

  // 层级单卡：view→查看；view+provision→控制；provision+maintain / 三位→管理。
  assert.deepEqual(chipSubjects('view'), ['developers'])
  assert.deepEqual(chipSubjects('control'), ['lisi'])
  assert.deepEqual(chipSubjects('manage').sort(), ['platform-admins', 'team-payment'])

  const allChips = [...drawer(page).querySelectorAll<HTMLElement>('.perm-chip')]
  assert.equal(
    new Set(allChips.map((chip) => chip.dataset.chip)).size,
    allChips.length,
    'every subject appears exactly once across the three cards'
  )
  assert.equal(
    permCard(page, 'manage').querySelector<HTMLElement>('.perm-card-head .badge'),
    null,
    'card heads carry no bit badge'
  )
  for (const chip of allChips) {
    assert.match(chip.textContent ?? '', /(组|用户)/, 'chips keep the type badge')
    assert.doesNotMatch(
      chip.textContent ?? '',
      /全权|只读|查看|控制|管理|view|provision|maintain/,
      'chips carry no permission words'
    )
  }

  saveEvidence(EVIDENCE, 'u67-3a-structure.json', {
    cards: cards.map((card) => card.dataset.card),
    subjects: {
      view: chipSubjects('view'),
      control: chipSubjects('control'),
      manage: chipSubjects('manage')
    }
  })
  cases['u67-3a-structure'] =
    '三卡顺序固定；卡头无位徽标；chip 仅名字+类型；主体仅出现在最高级别卡且全局唯一'
}, 120_000)
