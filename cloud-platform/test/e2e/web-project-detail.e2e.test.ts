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
}, 120_000)

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

test('W46-D1 管理员「详情」是按钮；弹框出现且只有一次项目 GET、零写、零新标签', async () => {
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
}, 120_000)

test('W46-D2 弹框字段逐项等于 payload；ID 可复制；失败原因按 failed 展示', async () => {
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
}, 120_000)

test('W46-D3 开发者无入口；离线/维护行可看详情，弹框打开按钮与行内同因置灰', async () => {
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
}, 120_000)

test('W46-D4 createdBy 只随 admin/auditor 下发（新增平台断言）', async () => {
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
}, 120_000)

test('W46-D5 弹框「打开项目」关闭弹框并在同页覆盖层进入工作区（U46-3）', async () => {
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
}, 120_000)

test('W46-D6 Escape 关闭弹框且焦点回到「详情」按钮', async () => {
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
}, 120_000)
