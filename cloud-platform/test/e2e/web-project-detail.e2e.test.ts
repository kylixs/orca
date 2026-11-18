import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { login, saveEvidence, spawnService, type Service } from './harness.ts'
import { loadWebConsolePage, type WebConsolePage } from './web-console-page.ts'

/**
 * U46-2 (FR-3.11 R3): 详情 becomes a read-only platform dialog instead of a
 * new-tab link to the host session page.
 *
 * D1-D6 per the U46 design §3.6, driven through the real console files against
 * a real platform process:
 * - admin row carries a 详情 button; opening the dialog sends exactly one
 *   GET /projects/:id (plus the two existing read endpoints), zero writes
 * - the six creation fields plus status/host/creator/permissions match the
 *   payload, and copy copies the id
 * - developers never see the entry; offline/maintenance rows stay clickable,
 *   with the dialog's 打开项目 greyed by the same reason as the row
 * - createdBy travels to admin/auditor payloads only
 * - 打开项目 closes the dialog and mints the admin-surface handoff
 * - Escape closes and returns focus to the triggering row button
 *
 * U46-3 mounts that handoff in the same-page overlay; D5 asserts the dialog
 * hands off into it. O1-O5 live in u46-3-overlay.e2e.test.ts.
 */

const EVIDENCE = 'u46-2-dialog'
const INTERNAL_TOKEN = 'u46-dialog-internal'
const READY_REPO = 'https://git.example.com/team/detail.git'
const FAILURE = 'git clone failed: authentication required'
const ADMIN_GRANT = ['open', 'terminal', 'agent', 'file:read', 'file:write']

let service: Service
let adminToken = ''
let devToken = ''
let detailHostId = ''
let detailHostCredential = ''
let maintHostId = ''
let detailProjectId = ''
let failedProjectId = ''
const beats: ReturnType<typeof setInterval>[] = []
const matrix: Record<string, unknown> = {}

async function api(
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

async function registerHost(
  name: string,
  port: number
): Promise<{ hostId: string; credential: string }> {
  const tokenRes = await fetch(`${service.url}/v1/hosts/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}` }
  })
  const { token } = (await tokenRes.json()) as { token: string }
  const res = await fetch(`${service.url}/v1/hosts/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      name,
      fingerprint: `sha256:${name}`,
      e2eePublicKeyB64: 'test-e2ee-key',
      orcaVersion: '1.5.0',
      protocolVersion: 3,
      networkZone: 'intranet',
      directAddrs: [`127.0.0.1:${port}`],
      relayTarget: `127.0.0.1:${port}`,
      relayRoute: name,
      tlsFingerprint: `sha256:${name}-tls`,
      runtimeCapabilities: ['pty', 'files', 'managed-credential']
    })
  })
  if (!res.ok) {
    throw new Error(`register ${name} failed: ${await res.text()}`)
  }
  return (await res.json()) as { hostId: string; credential: string }
}

async function createProject(
  key: string,
  hostId: string,
  extra: Record<string, unknown> = {}
): Promise<string> {
  const created = await api('/v1/projects', {
    method: 'POST',
    body: JSON.stringify({ key, name: key, hostId, path: `/srv/work/${key}`, ...extra })
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  return (created.body as { id: string }).id
}

async function grant(projectId: string, subjectId: string): Promise<void> {
  const res = await api(`/v1/projects/${projectId}/grants`, {
    method: 'PUT',
    body: JSON.stringify({ subjectType: 'group', subjectId, permissions: ADMIN_GRANT })
  })
  assert.equal(res.status, 200, JSON.stringify(res.body))
}

async function beatHost(
  hostId: string,
  credential: string,
  provisioned?: { projectId: string; ok: boolean; error?: string }[]
): Promise<void> {
  const res = await fetch(`${service.url}/v1/hosts/${hostId}/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
    body: JSON.stringify({ status: 'online', ...(provisioned ? { provisioned } : {}) })
  })
  assert.equal(res.status, 200, await res.text())
}

before(async () => {
  service = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN, ORCA_CLOUD_HOST_OFFLINE_MS: '1500' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-web-project-detail'
  )
  adminToken = await login(service.url, 'admin', 'Adm1n!')
  devToken = await login(service.url, 'zhangsan', 'Passw0rd!')

  const detailHost = await registerHost('dev-detail', 17031)
  detailHostId = detailHost.hostId
  detailHostCredential = detailHost.credential
  const maintHost = await registerHost('dev-detail-maint', 17033)
  maintHostId = maintHost.hostId
  // Never beaten: the heartbeat window lapses and this host is the offline row.
  const offlineHost = await registerHost('dev-detail-offline', 17032)

  detailProjectId = await createProject('detail-project', detailHost.hostId, {
    repoUrl: READY_REPO,
    defaultBranch: 'release'
  })
  // A repo-backed project stays provisioning/ready by the host's own report.
  await beatHost(detailHost.hostId, detailHost.credential, [
    { projectId: detailProjectId, ok: true }
  ])
  const offProjectId = await createProject('detail-offline', offlineHost.hostId)
  const maintProjectId = await createProject('detail-maint', maintHost.hostId)
  failedProjectId = await createProject('detail-failed', detailHost.hostId, {
    repoUrl: 'https://git.example.com/team/failed.git'
  })
  await beatHost(detailHost.hostId, detailHost.credential, [
    { projectId: failedProjectId, ok: false, error: FAILURE }
  ])

  for (const id of [detailProjectId, offProjectId, maintProjectId, failedProjectId]) {
    await grant(id, 'platform-admins')
  }
  await grant(detailProjectId, 'team-payment')
  const policy = await api(`/v1/projects/${detailProjectId}/policy`, {
    method: 'PUT',
    body: JSON.stringify({ downloadPolicy: 'allow' })
  })
  assert.equal(policy.status, 200, JSON.stringify(policy.body))

  const maintenance = await api(`/v1/hosts/${maintHostId}/maintenance`, {
    method: 'POST',
    body: JSON.stringify({ enabled: true, reason: 'U46 维护演练' })
  })
  assert.equal(maintenance.status, 200, JSON.stringify(maintenance.body))

  // Keeps the two online hosts inside the 1.5s window for every mint below.
  beats.push(
    setInterval(() => {
      void beatHost(detailHost.hostId, detailHost.credential).catch(() => undefined)
      void beatHost(maintHost.hostId, maintHost.credential).catch(() => undefined)
    }, 400)
  )
  // Registration starts the host online; let the never-beaten one lapse.
  await new Promise((resolve) => setTimeout(resolve, 1800))
  matrix.setup = { detailProjectId, failedProjectId, detailHostId, maintHostId }
}, { timeout: 120_000 })

after(async () => {
  for (const beat of beats) {
    clearInterval(beat)
  }
  await service?.stop()
  saveEvidence(EVIDENCE, 'detail-matrix.json', {
    feature: 'U46-2 项目详情弹框',
    cases: matrix
  })
})

function rowFor(page: WebConsolePage, name: string): HTMLElement {
  const row = [...page.window.document.querySelectorAll<HTMLElement>('#content tbody tr')].find(
    (candidate) => candidate.textContent?.includes(name)
  )
  assert.ok(row, `a row for ${name} must be rendered`)
  return row
}

function entryIn(row: HTMLElement, label: string): HTMLElement | null {
  return (
    [...row.querySelectorAll<HTMLElement>('button, a')].find(
      (candidate) => candidate.textContent?.trim() === label
    ) ?? null
  )
}

function dialogBody(page: WebConsolePage): HTMLElement {
  const body = page.window.document.querySelector<HTMLElement>('.dialog-backdrop .dialog .body')
  assert.ok(body, 'the detail dialog must be open')
  return body
}

function dialogButton(page: WebConsolePage, label: string): HTMLButtonElement | null {
  return (
    [...page.window.document.querySelectorAll<HTMLButtonElement>('.dialog-backdrop button')].find(
      (candidate) => candidate.textContent?.trim() === label
    ) ?? null
  )
}

/** Opens the 详情 dialog for a workbench row and switches to the 权限 tab. */
async function openPermTab(page: WebConsolePage, name: string): Promise<void> {
  const detail = entryIn(rowFor(page, name), '详情') as HTMLButtonElement
  assert.ok(detail, `${name}: the admin row must carry the 详情 entry`)
  detail.click()
  await page.settle()
  const tab = page.window.document.querySelector<HTMLButtonElement>(
    '.dialog-backdrop [data-auth-tab="perms"]'
  )
  assert.ok(tab, 'the project dialog must offer the 权限 tab')
  tab.click()
  await page.settle()
}

function projectCard(page: WebConsolePage, key: string): HTMLElement {
  const card = page.window.document.querySelector<HTMLElement>(
    `#projectPermCards [data-perm-cards] > [data-card="${key}"]`
  )
  assert.ok(card, `the permission tab must render the ${key} card`)
  return card
}

function lastToast(page: WebConsolePage): string {
  return [...page.window.document.querySelectorAll('.toast')].at(-1)?.textContent ?? ''
}

function dialogOpen(page: WebConsolePage): boolean {
  return page.window.document.querySelector('.dialog-backdrop') !== null
}

/** Waits for the route's own list fetch and row paint. */
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

/** Logs in, then opens 我的项目 and the 登记项目 dialog (M120a entry). */
async function openRegistration(page: WebConsolePage): Promise<void> {
  await page.settle()
  await page.submitLogin('admin', 'Adm1n!')
  await page.clickNav('projects')
  const entry = page.window.document.querySelector<HTMLElement>('#registerProjectBtn')
  assert.ok(entry, 'the admin must see the 登记项目 entry')
  entry.click()
  await page.settle()
  assert.ok(dialogOpen(page), 'the registration dialog must open')
}

function fillRegistration(
  page: WebConsolePage,
  form: { name: string; key: string; host: string; path: string; repo: string; branch: string }
): void {
  const fields: Record<string, string> = {
    regName: form.name,
    regKey: form.key,
    regHost: form.host,
    regPath: form.path,
    regRepo: form.repo,
    regBranch: form.branch
  }
  for (const [id, value] of Object.entries(fields)) {
    const field = page.window.document.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`)
    assert.ok(field, `the registration dialog must render #${id}`)
    field.value = value
  }
}

function submitRegistration(page: WebConsolePage): void {
  const button = page.window.document.querySelector<HTMLButtonElement>(
    '.dialog-backdrop [data-action="0"]'
  )
  assert.ok(button, 'the registration dialog must render the 登记 action')
  button.click()
}

/** The detail dialog stays open under its confirmations: drive the top-most one. */
function topDialog(page: WebConsolePage): HTMLElement {
  const dialogs = [
    ...page.window.document.querySelectorAll<HTMLElement>('.dialog-backdrop .dialog')
  ]
  assert.ok(dialogs.length > 0, 'a confirmation dialog must be open')
  return dialogs[dialogs.length - 1]
}

function confirmTopDialog(page: WebConsolePage): void {
  topDialog(page).querySelector<HTMLButtonElement>('[data-action="0"]')!.click()
}

function captureOpened(page: WebConsolePage): { opened: string[] } {
  const opened: string[] = []
  page.window.open = ((url?: string | URL) => {
    opened.push(String(url))
    return null
    // oxlint-disable-next-line typescript/no-explicit-any -- happy-dom's open signature is wider than the stub needs
  }) as any
  return { opened }
}

async function loginAs(username: string, password: string): Promise<WebConsolePage> {
  const page = loadWebConsolePage(service.url)
  await page.settle()
  await page.submitLogin(username, password)
  await page.clickNav('workbench')
  return page
}

test('W46-D1 管理员「详情」是按钮；弹框出现且只有一次项目 GET、零写、零新标签', { timeout: 120_000 }, async () => {
  const page = await loginAs('admin', 'Adm1n!')
  const row = rowFor(page, 'detail-project')
  const button = entryIn(row, '详情')
  assert.ok(button, 'the admin row must carry a 详情 entry')
  assert.equal(button.tagName, 'BUTTON', '详情 is an action button, not a new-tab link')
  assert.equal((button as HTMLButtonElement).dataset.detail, detailProjectId)

  const { opened } = captureOpened(page)
  const before = page.calls()
  ;(button as HTMLButtonElement).click()
  await page.settle()

  assert.ok(
    page.window.document.querySelector('.dialog-backdrop [role="dialog"]'),
    'clicking 详情 opens a dialog'
  )
  const calls = page.calls().slice(before.length)
  assert.deepEqual(
    calls.filter((call) => /^(POST|PUT|PATCH|DELETE) /.test(call)),
    [],
    'the detail dialog must never write'
  )
  assert.equal(
    calls.filter((call) => call === `GET /v1/projects/${detailProjectId}`).length,
    1,
    'exactly one project refresh'
  )
  assert.equal(opened.length, 0, 'the dialog must not open a new tab')
  assert.equal(
    calls.includes(`POST /v1/projects/${detailProjectId}/web-handoff`),
    false,
    'opening the dialog must not mint a handoff'
  )

  matrix.d1 = { detailButton: 'BUTTON', calls, opened: opened.length }
})

test('W46-D2 弹框字段逐项等于 payload；ID 可复制；失败原因按 failed 展示', { timeout: 120_000 }, async () => {
  const payload = (await api(`/v1/projects/${detailProjectId}`)).body as Record<string, unknown>
  const page = await loginAs('admin', 'Adm1n!')
  ;(entryIn(rowFor(page, 'detail-project'), '详情') as HTMLButtonElement).click()
  await page.settle()
  let text = dialogBody(page).textContent ?? ''

  assert.ok(text.includes(String(payload.name)), 'name')
  assert.ok(text.includes(String(payload.key)), 'key')
  assert.ok(text.includes(String(payload.id)), 'id')
  assert.ok(text.includes(String(payload.hostId)), 'hostId')
  assert.ok(text.includes(String(payload.path)), 'path')
  assert.ok(text.includes(String(payload.repoUrl)), 'repoUrl')
  assert.ok(text.includes(String(payload.defaultBranch)), 'defaultBranch')
  assert.equal(text.includes('未记录'), false, 'a recorded creator is not degraded')
  assert.ok(text.includes(String(payload.createdBy)), 'createdBy')
  assert.ok(
    text.includes(new Date(Number(payload.createdAt)).toLocaleString('zh-CN')),
    'absolute createdAt'
  )
  assert.ok(text.includes('刚刚'), 'relative createdAt reuses relative()')
  assert.ok(text.includes('就绪'), 'status badge')
  assert.ok(text.includes('在线'), 'host status')
  for (const permission of payload.permissions as string[]) {
    assert.ok(text.includes(permission), `permission ${permission}`)
  }
  assert.ok(text.includes('platform-admins（组）· 5 项权限'), 'direct-grant summary')
  assert.ok(text.includes('允许下载') && text.includes('项目覆盖'), 'effective download policy')

  // Copy: the id button writes the id and confirms in place.
  const copies: string[] = []
  Object.defineProperty(page.window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: (value: string) => (copies.push(value), Promise.resolve()) }
  })
  const copy = page.window.document.querySelector<HTMLButtonElement>(
    `.dialog-backdrop [data-copy="${detailProjectId}"]`
  )
  assert.ok(copy, 'the project id carries a copy button')
  copy.click()
  await page.settle()
  assert.deepEqual(copies, [detailProjectId], 'copy writes the id')
  assert.equal(
    page.window.document.querySelector('.toast')?.textContent,
    '已复制',
    'copy is confirmed to the user'
  )

  ;(dialogButton(page, '关闭') as HTMLButtonElement).click()
  await page.settle()

  // A failed project shows its provisioningError inline (mono row).
  ;(entryIn(rowFor(page, 'detail-failed'), '详情') as HTMLButtonElement).click()
  await page.settle()
  text = dialogBody(page).textContent ?? ''
  assert.ok(text.includes('准备失败'), 'failed status badge')
  assert.ok(text.includes(FAILURE), 'provisioningError is shown')

  matrix.d2 = {
    fields: ['name', 'key', 'id', 'hostId', 'path', 'repoUrl', 'defaultBranch', 'createdBy'],
    copied: copies,
    failedShowsError: FAILURE
  }
})

test('W46-D3 开发者无入口；离线/维护行可看详情，弹框打开按钮与行内同因置灰', { timeout: 120_000 }, async () => {
  const dev = await loginAs('zhangsan', 'Passw0rd!')
  assert.equal(
    entryIn(rowFor(dev, 'detail-project'), '详情'),
    null,
    'a developer never gets the detail entry'
  )

  const page = await loginAs('admin', 'Adm1n!')
  for (const [key, reason] of [
    ['detail-offline', '主机离线'],
    ['detail-maint', '主机维护中']
  ] as const) {
    const row = rowFor(page, key)
    const detail = entryIn(row, '详情') as HTMLButtonElement
    assert.ok(detail, `${key}: detail stays visible on a ${reason} host`)
    assert.equal(detail.disabled, false, `${key}: host state must not grey the read-only dialog`)
    detail.click()
    await page.settle()
    const open = dialogButton(page, '打开项目')
    assert.ok(open, `${key}: the dialog carries the primary open button`)
    assert.equal(open.disabled, true, `${key}: opening is impossible`)
    assert.equal(open.title, reason, `${key}: the dialog repeats the row's own openDisabledReason`)
    assert.equal(
      (entryIn(row, '打开') as HTMLButtonElement).title,
      open.title,
      `${key}: row and dialog state one reason`
    )
    dialogBody(page)
    ;(dialogButton(page, '关闭') as HTMLButtonElement).click()
    await page.settle()
  }

  matrix.d3 = { developerEntry: null, offline: '主机离线', maintenance: '主机维护中' }
})

test('W46-D4 createdBy 只随 admin/auditor 下发（新增平台断言）', { timeout: 120_000 }, async () => {
  const adminView = await api('/v1/projects?includeArchived=1')
  const adminRow = (adminView.body.projects as Record<string, unknown>[]).find(
    (p) => p.id === detailProjectId
  )
  assert.ok(adminRow, 'the admin list carries the project')
  assert.equal('createdBy' in adminRow, true, 'admins receive createdBy')
  assert.equal(adminRow.createdBy, 'admin')

  const devView = await api('/v1/projects', { token: devToken })
  const devRow = (devView.body.projects as Record<string, unknown>[]).find(
    (p) => p.id === detailProjectId
  )
  assert.ok(devRow, 'the developer holds open on this project')
  assert.equal('createdBy' in devRow, false, 'non-admin payloads stay byte-identical')

  matrix.d4 = { adminCreatedBy: adminRow.createdBy, developerHasKey: 'createdBy' in devRow }
})

test('W46-D5 弹框「打开项目」关闭弹框并在同页覆盖层进入工作区（U46-3）', { timeout: 120_000 }, async () => {
  const page = await loginAs('admin', 'Adm1n!')
  const { opened } = captureOpened(page)
  ;(entryIn(rowFor(page, 'detail-project'), '详情') as HTMLButtonElement).click()
  await page.settle()

  const before = page.calls()
  ;(dialogButton(page, '打开项目') as HTMLButtonElement).click()
  await page.settle()

  assert.equal(
    page.window.document.querySelector('.dialog-backdrop'),
    null,
    'the dialog closes before the workspace entry runs'
  )
  assert.deepEqual(
    page.calls().slice(before.length),
    [`POST /v1/projects/${detailProjectId}/web-handoff`],
    'exactly one handoff mint, no other traffic'
  )
  assert.equal(opened.length, 0, 'U46-3 replaces the placeholder new tab with the overlay')
  const iframe = page.window.document.querySelector<HTMLIFrameElement>('#workspaceOverlay iframe')
  assert.ok(iframe, 'the workspace entry mounts the same-page overlay')
  const entry = new URL(iframe.src)
  assert.equal(entry.pathname, '/cloud-admin.html')
  assert.equal(entry.searchParams.get('embed'), '1')
  assert.equal(entry.searchParams.get('project'), detailProjectId)

  // The server is the authority for the body this order sent: its audit carries
  // the surface the console requested.
  const audit = await api('/v1/audit/events?eventType=web_handoff&actor=admin&limit=50')
  const event = (audit.body.events ?? []).find(
    (e: { targetId?: string }) => e.targetId === detailProjectId
  )
  assert.ok(event, 'the handoff lands in the audit trail')
  assert.equal(event.metadata.surface, 'admin', 'the dialog asks for the admin surface')

  matrix.d5 = {
    calls: [`POST /v1/projects/${detailProjectId}/web-handoff`],
    auditSurface: event.metadata.surface,
    overlay: iframe.src.replace(/#handoff=[A-Za-z0-9_-]+/, '#handoff=<redacted>'),
    opened: opened.length
  }
})

test('W46-D6 Escape 关闭弹框且焦点回到「详情」按钮', { timeout: 120_000 }, async () => {
  const page = await loginAs('admin', 'Adm1n!')
  const detail = entryIn(rowFor(page, 'detail-project'), '详情') as HTMLButtonElement
  detail.click()
  await page.settle()
  dialogBody(page)

  page.window.document.dispatchEvent(
    new page.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
  )
  await page.settle()

  assert.equal(
    page.window.document.querySelector('.dialog-backdrop'),
    null,
    'Escape closes the dialog'
  )
  assert.equal(page.window.document.activeElement, detail, 'focus returns to the opener')

  matrix.d6 = { escapeClosed: true, focusReturned: 'detail' }
})

/**
 * U67-4: 项目详情弹框「信息|权限」tab 化。权限 tab 的查看/控制卡写项目 grants
 * （位并集，复用 U67 共享渲染/交互），管理卡是主机授权推导只读视图（FR-9.11③），
 * 只做跳转，不提供任何写入口。
 */
test('U67-4-1 项目弹框 tab 化：信息|权限；三卡结构 + FR-9.11③ 头注', { timeout: 120_000 }, async () => {
  const page = await loginAs('admin', 'Adm1n!')
  ;(entryIn(rowFor(page, 'detail-project'), '详情') as HTMLButtonElement).click()
  await page.settle()
  const body = dialogBody(page)
  const tabs = [...body.querySelectorAll<HTMLButtonElement>('[data-auth-tab]')]
  assert.deepEqual(
    tabs.map((tab) => tab.dataset.authTab),
    ['info', 'perms'],
    'the dialog carries 信息|权限 tabs in order'
  )
  assert.deepEqual(
    tabs.map((tab) => tab.textContent?.trim()),
    ['信息', '权限']
  )
  assert.equal(
    body.querySelector<HTMLElement>('[data-auth-panel="perms"]')!.hidden,
    true,
    'information is the default tab'
  )

  tabs[1].click()
  await page.settle()
  assert.equal(body.querySelector<HTMLElement>('[data-auth-panel="info"]')!.hidden, true)
  assert.equal(body.querySelector<HTMLElement>('[data-auth-panel="perms"]')!.hidden, false)

  const header = page.window.document.querySelector<HTMLElement>('#projectPermCards > .note')!
  assert.match(header.textContent ?? '', /FR-9\.11③/, 'the header cites FR-9.11③')
  assert.match(
    header.textContent ?? '',
    /不扩大到所在主机或其它项目/,
    'the header states project grants never widen to the host'
  )

  const cards = [
    ...page.window.document.querySelectorAll<HTMLElement>(
      '#projectPermCards [data-perm-cards] > .perm-card'
    )
  ]
  assert.deepEqual(
    cards.map((card) => card.dataset.card),
    ['view', 'control', 'derived'],
    'cards render 查看/控制/管理(推导)'
  )
  for (const key of ['view', 'control']) {
    const head = projectCard(page, key).querySelector<HTMLElement>('.perm-card-head')!
    assert.match(head.textContent ?? '', /个主体/, `${key} head carries the subject count`)
    assert.doesNotMatch(
      head.textContent ?? '',
      /open|file:read|terminal|agent|browser|download/,
      `${key} head exposes no permission bits`
    )
  }

  const derived = projectCard(page, 'derived')
  assert.match(derived.textContent ?? '', /主机推导 · 只读/)
  assert.match(derived.textContent ?? '', /项目级无「管理」权限位/)
  assert.match(derived.textContent ?? '', /项目授权不扩大到主机级/)
  assert.equal(derived.querySelector('[data-perm-add]'), null, '管理卡 has no add entry')
  assert.equal(derived.querySelector('.perm-chip-x'), null, '管理卡 chips are not removable')
  const jump = derived.querySelector<HTMLButtonElement>('[data-open-host-detail]')
  assert.ok(jump, '管理卡 carries the host-detail jump link')
  assert.equal(jump.textContent?.trim(), '前往主机详情弹框 →')

  matrix.u67_4_1 = { tabs: ['信息', '权限'], cards: ['view', 'control', 'derived'] }
})

test('U67-4-2 查看/控制卡可写：整行 PUT、覆盖确认与移除危险确认', { timeout: 120_000 }, async () => {
  const subject = 'zhangsan'
  const grantsPath = `/v1/projects/${detailProjectId}/grants`
  // Start from a clean row: this case owns zhangsan's project grant.
  await api(grantsPath, {
    method: 'PUT',
    body: JSON.stringify({ subjectType: 'user', subjectId: subject, permissions: [] })
  })

  const page = await loginAs('admin', 'Adm1n!')
  await openPermTab(page, 'detail-project')
  const chipOf = (key: string): HTMLElement | undefined =>
    [...projectCard(page, key).querySelectorAll<HTMLElement>('.perm-chip')].find(
      (chip) => chip.querySelector('.mono')?.textContent === subject
    )

  const addTo = async (key: string): Promise<void> => {
    const card = projectCard(page, key)
    card.querySelector<HTMLInputElement>('[data-perm-subject]')!.value = subject
    const select = card.querySelector<HTMLSelectElement>('[data-perm-type]')!
    select.value = 'user'
    select.dispatchEvent(new page.window.Event('change', { bubbles: true }))
    card.querySelector<HTMLButtonElement>('[data-perm-add]')!.click()
    await page.settle()
  }
  const puts = (): number =>
    page.calls().filter((call) => call === `PUT ${grantsPath}`).length

  await addTo('view')
  assert.equal(puts(), 1, 'a fresh subject saves immediately with one PUT')
  assert.match(lastToast(page), /已保存「查看」授权/)
  assert.ok(chipOf('view'), 'the new chip lands in the 查看 card')
  let row = (await api(grantsPath)).body.grants.find(
    (grant: { username?: string }) => grant.username === subject
  )
  assert.deepEqual(
    [...row.permissions].sort(),
    ['file:read', 'open'],
    '查看 card writes exactly open + file:read'
  )

  // Adding the same subject to 控制 confirms first (one row, union of bits).
  await addTo('control')
  const overwrite = topDialog(page)
  assert.match(overwrite.textContent ?? '', /覆盖现有授权/)
  assert.match(overwrite.textContent ?? '', /级别：查看 → 查看\+控制/)
  assert.equal(puts(), 1, 'the overwrite never reaches the platform before confirmation')
  confirmTopDialog(page)
  await page.settle()
  assert.equal(puts(), 2, 'confirming sends exactly one union PUT')
  row = (await api(grantsPath)).body.grants.find(
    (grant: { username?: string }) => grant.username === subject
  )
  assert.deepEqual(
    [...row.permissions].sort(),
    ['agent', 'browser', 'download', 'file:read', 'file:write', 'open', 'terminal'],
    '控制 card unions its operation bits into the row'
  )
  assert.ok(chipOf('control'), 'the chip also renders under 控制')

  // Removing from 控制 leaves the 查看 bits: immediate PUT, no danger dialog.
  chipOf('control')!.querySelector<HTMLButtonElement>('.perm-chip-x')!.click()
  await page.settle()
  assert.equal(puts(), 3)
  assert.match(lastToast(page), /级别：查看\+控制 → 查看/)
  row = (await api(grantsPath)).body.grants.find(
    (grant: { username?: string }) => grant.username === subject
  )
  assert.deepEqual([...row.permissions].sort(), ['file:read', 'open'])

  // Removing the last card empties the row: danger confirm with the 60s notice.
  chipOf('view')!.querySelector<HTMLButtonElement>('.perm-chip-x')!.click()
  await page.settle()
  const danger = topDialog(page)
  assert.match(danger.textContent ?? '', /移除全部授权/)
  assert.match(danger.textContent ?? '', /≤60 秒/, 'the danger confirm states the session cutoff')
  assert.equal(puts(), 3, 'the empty-row removal waits for confirmation')
  confirmTopDialog(page)
  await page.settle()
  assert.equal(puts(), 4, 'confirming deletes the row with one PUT')
  const remaining = (await api(grantsPath)).body.grants
  assert.equal(
    remaining.some((grant) => grant.username === subject),
    false,
    'the subject holds no project grant afterwards'
  )

  matrix.u67_4_2 = { view: ['open', 'file:read'], controlUnion: 7, removed: true }
})

test('U67-4-3 管理卡=主机推导只读：仅控制/管理主体 + 前往主机详情跳转', { timeout: 120_000 }, async () => {
  const seeds = [
    { subjectType: 'group', subjectId: 'developers', permissions: ['view'] },
    { subjectType: 'user', subjectId: 'zhangsan', permissions: ['view', 'provision'] },
    { subjectType: 'group', subjectId: 'platform-admins', permissions: ['provision', 'maintain'] }
  ]
  for (const seed of seeds) {
    const res = await api(`/v1/hosts/${detailHostId}/grants`, {
      method: 'PUT',
      body: JSON.stringify(seed)
    })
    assert.equal(res.status, 200, JSON.stringify(res.body))
  }

  const page = await loginAs('admin', 'Adm1n!')
  await openPermTab(page, 'detail-project')
  const derived = projectCard(page, 'derived')
  const chips = [...derived.querySelectorAll<HTMLElement>('.perm-chip')]
  const subjects = chips.map((chip) => chip.querySelector('.mono')?.textContent ?? '').sort()
  assert.deepEqual(
    subjects,
    ['platform-admins', 'zhangsan'],
    'only host 控制/管理 subjects derive into the project card; 只读 holders are omitted'
  )
  const chipFor = (name: string): HTMLElement => {
    const chip = chips.find((candidate) => candidate.querySelector('.mono')?.textContent === name)
    assert.ok(chip, `the derived card must carry a chip for ${name}`)
    return chip
  }
  assert.match(chipFor('zhangsan').textContent ?? '', /来源：控制卡/)
  assert.match(chipFor('platform-admins').textContent ?? '', /来源：管理卡/)
  assert.equal(
    derived.querySelectorAll('.perm-chip-x').length,
    0,
    'derived chips expose no remove control'
  )

  derived.querySelector<HTMLButtonElement>('[data-open-host-detail]')!.click()
  await page.settle()
  assert.equal(
    page.window.location.hash,
    `#/hosts/${detailHostId}?tab=perms`,
    'the jump opens the host detail URL on its 权限 tab'
  )
  const drawer = page.window.document.querySelector<HTMLElement>('.drawer')
  assert.ok(drawer, 'the host drawer replaces the project dialog')
  assert.equal(
    drawer.querySelector<HTMLElement>('.detail-tab.active')!.dataset.authTab,
    'perms',
    'the host drawer lands on 权限'
  )
  const hostCards = [
    ...drawer.querySelectorAll<HTMLElement>('[data-perm-cards] > .perm-card[data-card]')
  ].map((card) => card.dataset.card)
  assert.deepEqual(hostCards, ['view', 'control', 'manage'])
  const manageChips = [
    ...drawer.querySelectorAll<HTMLElement>('[data-card="manage"] .perm-chip .mono')
  ].map((node) => node.textContent)
  assert.ok(manageChips.includes('platform-admins'), 'the host manage card owns the derived source')

  matrix.u67_4_3 = { derived: subjects, jump: '#/hosts/<id>?tab=perms' }
})

/**
 * G07 (AC-M3-07/21, C15): the provisioning→ready UI states, the detail dialog's
 * refresh-failure banner, copy actions and the independent session-page link.
 */
const G07_CLONE_KEY = 'g07-clone'
const G07_FAILED_KEY = 'g07-clone-failed'
const G07_CLONE_REPO = 'git@git.example.com:pay/g07-clone.git'
const G07_FAILED_REPO = 'https://git.example.com/team/g07-failed.git'
const G07_FAILURE = 'git clone failed: G07 authentication required'

test('G07-1 repoUrl 登记 → toast「克隆中」→ 详情「准备中」→ 宿主回报 ok →「就绪」', { timeout: 120_000 }, async () => {
  const page = loadWebConsolePage(service.url)
  await openRegistration(page)
  fillRegistration(page, {
    name: G07_CLONE_KEY,
    key: G07_CLONE_KEY,
    host: detailHostId,
    path: `/srv/work/${G07_CLONE_KEY}`,
    repo: G07_CLONE_REPO,
    branch: 'main'
  })
  submitRegistration(page)
  await page.settle()

  assert.match(lastToast(page), /项目已登记，克隆中，就绪后可打开/)
  assert.equal(dialogOpen(page), false, 'the registration dialog closes on success')

  const created = (
    (await api('/v1/projects')).body.projects as {
      id: string
      key: string
      status: string
      repoUrl: string
    }[]
  ).find((project) => project.key === G07_CLONE_KEY)
  assert.ok(created, 'the repo-backed project must exist on the platform')
  assert.equal(created.status, 'provisioning', 'a repo URL stays provisioning until the host reports')
  assert.equal(created.repoUrl, G07_CLONE_REPO)

  await page.clickNav('workbench')
  const openDetail = async (): Promise<string> => {
    const row = await rowWhenRendered(page, G07_CLONE_KEY)
    ;(entryIn(row, '详情') as HTMLButtonElement).click()
    await page.settle()
    return dialogBody(page).textContent ?? ''
  }

  assert.match(await openDetail(), /准备中/, 'before the host report the badge says 准备中')
  ;(dialogButton(page, '关闭') as HTMLButtonElement).click()
  await page.settle()

  await beatHost(detailHostId, detailHostCredential, [{ projectId: created.id, ok: true }])
  assert.match(await openDetail(), /就绪/, 'the host report flips the detail badge to 就绪')

  const fresh = (await api(`/v1/projects/${created.id}`)).body as { status: string }
  assert.equal(fresh.status, 'ready', 'the platform also holds ready')

  matrix.g07_1 = { key: G07_CLONE_KEY, toast: /克隆中/.source, states: ['准备中', '就绪'] }
})

test('G07-2 宿主回报克隆失败 → 详情「准备失败」+ 失败原因', { timeout: 120_000 }, async () => {
  const projectId = await createProject(G07_FAILED_KEY, detailHostId, { repoUrl: G07_FAILED_REPO })
  await grant(projectId, 'platform-admins')
  await beatHost(detailHostId, detailHostCredential, [
    { projectId, ok: false, error: G07_FAILURE }
  ])

  const page = await loginAs('admin', 'Adm1n!')
  const row = await rowWhenRendered(page, G07_FAILED_KEY)
  ;(entryIn(row, '详情') as HTMLButtonElement).click()
  await page.settle()
  const text = dialogBody(page).textContent ?? ''

  assert.match(text, /准备失败/, 'the failed badge is shown')
  assert.ok(text.includes(G07_FAILURE), 'the provisioningError reason is shown inline')
  assert.match(text, /准备失败原因/, 'the reason has its own labelled row')

  matrix.g07_2 = { status: '准备失败', error: G07_FAILURE }
})

test('G07-3 详情刷新 GET 失败 → 顶部黄条，缓存数据仍展示', { timeout: 120_000 }, async () => {
  const page = await loginAs('admin', 'Adm1n!')
  page.fail('GET', `/v1/projects/${detailProjectId}`)
  ;(entryIn(rowFor(page, 'detail-project'), '详情') as HTMLButtonElement).click()
  await page.settle()

  const warn = page.window.document.querySelector<HTMLElement>('.dialog-backdrop .note.warn')
  assert.ok(warn, 'a failed project refresh renders the yellow note')
  assert.match(warn.textContent ?? '', /未能刷新项目信息，以下为最近一次加载的数据/)
  const text = dialogBody(page).textContent ?? ''
  assert.ok(text.includes('detail-project'), 'the cached row still fills the dialog')
  assert.match(text, /就绪/, 'the cached status is kept rather than blanked')

  matrix.g07_3 = { banner: warn.textContent?.trim(), cached: 'detail-project' }
})

test('G07-4 路径/仓库复制 toast「已复制」；在线宿主详情含独立页链接', { timeout: 120_000 }, async () => {
  const payload = (await api(`/v1/projects/${detailProjectId}`)).body as {
    path: string
    repoUrl: string
    sessionPageUrl: string
    hostStatus: string
  }
  assert.equal(payload.hostStatus, 'online', 'the independent-page link is asserted on an online host')
  assert.ok(payload.sessionPageUrl, 'an online host with TLS + direct address has a session page')

  const page = await loginAs('admin', 'Adm1n!')
  ;(entryIn(rowFor(page, 'detail-project'), '详情') as HTMLButtonElement).click()
  await page.settle()

  const link = [...dialogBody(page).querySelectorAll<HTMLAnchorElement>('a')].find(
    (candidate) => candidate.getAttribute('href') === payload.sessionPageUrl
  )
  assert.ok(link, 'the detail dialog carries the independent session-page link')
  assert.equal(link.textContent?.trim(), '在独立页打开会话页')
  assert.equal(link.getAttribute('target'), '_blank')
  assert.equal(link.getAttribute('rel'), 'noopener')

  const copies: string[] = []
  Object.defineProperty(page.window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: (value: string) => (copies.push(value), Promise.resolve()) }
  })
  for (const value of [payload.path, payload.repoUrl]) {
    const button = page.window.document.querySelector<HTMLButtonElement>(
      `.dialog-backdrop [data-copy="${value}"]`
    )
    assert.ok(button, `the detail dialog carries a copy button for ${value}`)
    button.click()
    await page.settle()
  }
  assert.deepEqual(copies, [payload.path, payload.repoUrl], 'both copy buttons write their value')
  assert.equal(lastToast(page), '已复制', 'copy is confirmed with the shared toast')

  matrix.g07_4 = { copied: copies, sessionPageUrl: payload.sessionPageUrl }
})
