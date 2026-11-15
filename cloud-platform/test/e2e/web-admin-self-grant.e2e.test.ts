import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { login, saveEvidence, spawnService, type Service } from './harness.ts'
import { loadWebConsolePage, type WebConsolePage } from './web-console-page.ts'

/**
 * AA5 · U40: an admin reaches every project row while carrying no grant, so
 * 打开 mints a credential with no permissions and the host refuses it (403).
 * The console answers with an additive 「授权并打开」 entry, driven through the
 * real console files against a real platform process:
 *
 * - the entry renders next to the still-greyed 打开 for an admin without open,
 *   on 工作台 and 我的项目 alike, and never for anyone else
 * - confirming states the five bits a self-service project is born with plus
 *   the disconnect warning, sends exactly one PUT /grants carrying the admin's
 *   own username (the platform resolves it to the id), then hands off as usual
 * - cancelling sends nothing; an admin already holding open keeps the plain
 *   direct handoff; a developer's 403/404 semantics stay untouched
 */

const EVIDENCE = 'aa5-self-grant'
const INTERNAL_TOKEN = 'aa5-internal-token'
/** The self-service default set — what a granted-to-self admin ends up holding. */
const SELF_GRANT = ['open', 'terminal', 'agent', 'file:read', 'file:write']

let service: Service
let adminToken = ''
let devToken = ''
let hostId = ''
let hostCredential = ''
let beat: ReturnType<typeof setInterval> | undefined
const matrix: Record<string, string> = {}

async function api(
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

/** Resolves a project id by key, so the tests read by the key they created. */
async function projectIdOf(key: string): Promise<string> {
  const view = await api('/v1/projects')
  const found = (view.body.projects as { key: string; id: string }[]).find((p) => p.key === key)
  assert.ok(found, `precondition: ${key} must be listed`)
  return found.id
}

async function createProject(key: string): Promise<string> {
  const created = await api('/v1/projects', {
    method: 'POST',
    body: JSON.stringify({ key, name: key, hostId, path: `/srv/work/${key}` })
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  return (created.body as { id: string }).id
}

/** Puts one permission set on one project row for one group. */
async function grantGroup(
  projectId: string,
  subjectId: string,
  permissions: string[]
): Promise<void> {
  const granted = await api(`/v1/projects/${projectId}/grants`, {
    method: 'PUT',
    body: JSON.stringify({ subjectType: 'group', subjectId, permissions })
  })
  assert.equal(granted.status, 200, JSON.stringify(granted.body))
}

type GrantRow = { subjectType: string; subjectId: string; username?: string; permissions: string[] }

async function getGrants(projectId: string, token = adminToken): Promise<GrantRow[]> {
  const res = await api(`/v1/projects/${projectId}/grants`, { token })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  return res.body.grants
}

before(async () => {
  service = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN, ORCA_CLOUD_HOST_OFFLINE_MS: '1500' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-web-admin-self-grant'
  )
  adminToken = await login(service.url, 'admin', 'Adm1n!')
  devToken = await login(service.url, 'zhangsan', 'Passw0rd!')

  const tokenRes = await fetch(`${service.url}/v1/hosts/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}` }
  })
  const { token } = (await tokenRes.json()) as { token: string }
  // A host:port direct address is the fallback web entry, so the handoff mints
  // without a relay browser edge — the grant, not the edge, is what is under test.
  const registered = await fetch(`${service.url}/v1/hosts/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      name: 'dev-selfgrant',
      fingerprint: 'sha256:dev-selfgrant',
      e2eePublicKeyB64: 'test-e2ee-key',
      orcaVersion: '1.5.0',
      protocolVersion: 3,
      networkZone: 'intranet',
      directAddrs: ['127.0.0.1:17021'],
      relayTarget: '127.0.0.1:17021',
      relayRoute: 'dev-selfgrant',
      runtimeCapabilities: ['pty', 'files', 'managed-credential']
    })
  })
  assert.equal(registered.status, 201, registered.ok ? '' : await registered.text())
  const host = (await registered.json()) as { hostId: string; credential: string }
  hostId = host.hostId
  hostCredential = host.credential

  // Two projects the admin holds no grant on (one per confirm outcome), one the
  // admin already holds open on, one the developer holds open on.
  const selfGrantId = await createProject('selfgrant-project')
  const cancelId = await createProject('cancel-project')
  const grantedId = await createProject('granted-project')
  const devId = await createProject('dev-project')
  await grantGroup(grantedId, 'platform-admins', SELF_GRANT)
  await grantGroup(devId, 'team-payment', SELF_GRANT)
  matrix['setup'] = `selfgrant=${selfGrantId} cancel=${cancelId} granted=${grantedId} dev=${devId}`

  // Keeps the host inside the heartbeat window for every handoff mint below.
  beat = setInterval(() => {
    void fetch(`${service.url}/v1/hosts/${hostId}/heartbeat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${hostCredential}`
      },
      body: JSON.stringify({ status: 'online' })
    }).catch(() => undefined)
  }, 400)
}, 120_000)

after(async () => {
  if (beat) {
    clearInterval(beat)
  }
  await service?.stop()
  saveEvidence(EVIDENCE, 'self-grant-summary.json', {
    feature: 'AA5 U40 admin 自授并打开',
    cases: matrix
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

function entryIn(row: HTMLElement, label: string): HTMLButtonElement | null {
  return (
    [...row.querySelectorAll<HTMLButtonElement>('button')].find(
      (candidate) => candidate.textContent?.trim() === label
    ) ?? null
  )
}

function dialogText(page: WebConsolePage): string {
  const body = page.window.document.querySelector('.dialog-backdrop .body')
  assert.ok(body, 'the confirmation dialog must be open')
  return body.textContent ?? ''
}

/** `confirm` is the primary action, `close` the ghost button that cancels. */
function clickDialogAction(page: WebConsolePage, action: 'confirm' | 'close'): void {
  const selector = action === 'close' ? '[data-action="close"]' : '[data-action="0"]'
  const button = page.window.document.querySelector<HTMLButtonElement>(
    `.dialog-backdrop ${selector}`
  )
  assert.ok(button, `the confirmation dialog must render ${action}`)
  button.click()
}

function callsSince(page: WebConsolePage, before: string[]): string[] {
  return page.calls().slice(before.length)
}

/** Stubs window.open so a handoff is observable without leaving the page. */
function captureOpened(page: WebConsolePage): { opened: string[] } {
  const opened: string[] = []
  page.window.open = ((url?: string | URL) => {
    opened.push(String(url))
    return null
    // oxlint-disable-next-line typescript/no-explicit-any -- happy-dom's open signature is wider than the stub needs
  }) as any
  return { opened }
}

async function loginAdminWorkbench(): Promise<WebConsolePage> {
  const page = loadWebConsolePage(service.url)
  await page.settle()
  await page.submitLogin('admin', 'Adm1n!')
  await page.clickNav('workbench')
  return page
}

function redactHandoff(url: string): string {
  return url.replace(/#handoff=[A-Za-z0-9_-]+/, '#handoff=<redacted>')
}

test('AA5-1 未授权管理员「授权并打开」：确认五位→恰好一次 PUT grants→同页覆盖层', async () => {
  const page = await loginAdminWorkbench()
  const row = rowFor(page, 'selfgrant-project')
  const projectId = await projectIdOf('selfgrant-project')

  // Additive entry: the greyed 打开 keeps saying why, Orca Web still hides, and
  // the new entry is what carries the self-grant.
  const openBtn = entryIn(row, '打开')
  assert.ok(openBtn, 'the 打开 entry stays rendered')
  assert.equal(openBtn.disabled, true, '打开 stays greyed until a grant exists')
  assert.match(openBtn.title, /未授权/)
  assert.equal(entryIn(row, 'Orca Web'), null, 'no Orca Web entry without open')
  const entry = entryIn(row, '授权并打开')
  assert.ok(entry, 'an unauthorized admin gets the self-grant entry')
  assert.equal(entry.disabled, false)
  assert.equal(entry.dataset.selfGrant, projectId)

  const { opened } = captureOpened(page)
  entry.click()
  await page.settle()

  const text = dialogText(page)
  for (const bit of SELF_GRANT) {
    assert.ok(text.includes(bit), `the dialog must list ${bit}`)
  }
  assert.match(text, /断开你当前全部云会话/, 'the disconnect warning must travel with the bits')

  const beforePut = page.calls()
  clickDialogAction(page, 'confirm')
  await page.settle()

  assert.deepEqual(
    callsSince(page, beforePut).filter(
      (call) => call.includes('/grants') || call.includes('/web-handoff')
    ),
    [`PUT /v1/projects/${projectId}/grants`, `POST /v1/projects/${projectId}/web-handoff`],
    'one grant write then the usual handoff, nothing else'
  )
  assert.equal(opened.length, 0, 'U46-3 enters the same-page overlay, not a new tab')
  const iframe = page.window.document.querySelector<HTMLIFrameElement>('#workspaceOverlay iframe')
  assert.ok(iframe, 'the self-grant enters the workspace overlay')
  const url = new URL(iframe.src)
  assert.equal(url.pathname, '/cloud-admin.html')
  assert.equal(url.searchParams.get('api'), service.url)
  assert.equal(url.searchParams.get('embed'), '1')
  assert.equal(new URLSearchParams(url.hash.slice(1)).get('project'), projectId)

  // The platform holds what the dialog promised: a named user row for the admin.
  const grants = await getGrants(projectId)
  const adminRow = grants.find((g) => g.subjectType === 'user' && g.username === 'admin')
  assert.ok(adminRow, 'the grants must hold a user row named admin')
  assert.deepEqual([...adminRow.permissions].sort(), [...SELF_GRANT].sort())

  // Single source of truth: the write is the ordinary grant_update event.
  const audit = await api('/v1/audit/events?eventType=grant_update&actor=admin&limit=50')
  const event = (audit.body.events ?? []).find(
    (e: { targetId?: string }) => e.targetId === projectId
  )
  assert.ok(event, 'the self-grant must land in the grant_update audit trail')
  assert.equal(event.result, 'success')

  // After the grant the row reads like any authorized one.
  const reopened = await loginAdminWorkbench()
  const freshRow = rowFor(reopened, 'selfgrant-project')
  assert.equal(
    entryIn(freshRow, '授权并打开'),
    null,
    'the self-grant entry retires once open is held'
  )
  assert.equal(entryIn(freshRow, '打开')?.disabled, false, '打开 is live after the grant')
  assert.equal(entryIn(freshRow, 'Orca Web')?.disabled, false, 'Orca Web appears after the grant')

  saveEvidence(EVIDENCE, 'self-grant-open.json', {
    project: projectId,
    put: `PUT /v1/projects/${projectId}/grants`,
    handoff: redactHandoff(iframe.src),
    grantedPermissions: adminRow.permissions,
    auditResult: event.result
  })
  matrix['self-grant-open'] =
    '授权并打开 → 确认五位+断开提示 → 1×PUT grants(username=admin) → 1×POST admin web-handoff 同页覆盖层；授权后行恢复 打开/Orca Web'
}, 120_000)

test('AA5-2 取消自授：关闭确认框零请求，grants 无 admin 行', async () => {
  const page = await loginAdminWorkbench()
  const entry = entryIn(rowFor(page, 'cancel-project'), '授权并打开')
  assert.ok(entry, 'the cancel-project row carries the self-grant entry')
  entry.click()
  await page.settle()
  assert.match(dialogText(page), /授权/)

  const beforeClose = page.calls()
  clickDialogAction(page, 'close')
  await page.settle()

  assert.deepEqual(callsSince(page, beforeClose), [], 'cancelling must not send a single request')
  assert.equal(page.window.document.querySelector('.dialog-backdrop'), null, 'the dialog is gone')
  const cancelId = await projectIdOf('cancel-project')
  assert.equal((await getGrants(cancelId)).length, 0, 'no row landed')

  // 工作台 and 我的项目 come from one builder, so the entry reads the same there.
  await page.clickNav('projects')
  assert.ok(
    entryIn(rowFor(page, 'cancel-project'), '授权并打开'),
    'the projects page has the same entry'
  )
  saveEvidence(EVIDENCE, 'cancel-zero-request.json', {
    project: cancelId,
    requestsAfterCancel: 0,
    grantsRows: 0,
    projectsPageEntry: true
  })
  matrix['cancel'] = '关闭确认框 → 请求增量为空、grants 仍为空；我的项目行渲染同一入口'
}, 120_000)

test('AA5-3 已授权管理员：打开直接 handoff，无确认框无 PUT', async () => {
  const page = await loginAdminWorkbench()
  const row = rowFor(page, 'granted-project')
  assert.equal(entryIn(row, '授权并打开'), null, 'an admin holding open needs no self-grant entry')
  const openBtn = entryIn(row, '打开')
  assert.ok(openBtn)
  assert.equal(openBtn.disabled, false)

  const { opened } = captureOpened(page)
  const before = page.calls()
  openBtn.click()
  await page.settle()

  assert.equal(
    page.window.document.querySelector('.dialog-backdrop'),
    null,
    'no confirmation dialog'
  )
  const projectId = await projectIdOf('granted-project')
  assert.deepEqual(callsSince(page, before), [`POST /v1/projects/${projectId}/web-handoff`])
  assert.equal(opened.length, 0, 'U46-3 opens the overlay instead of a tab')
  const iframe = page.window.document.querySelector<HTMLIFrameElement>('#workspaceOverlay iframe')
  assert.ok(iframe, 'an authorized admin enters the workspace overlay')
  assert.equal(new URL(iframe.src).searchParams.get('project'), projectId)
  saveEvidence(EVIDENCE, 'granted-admin-direct.json', {
    project: projectId,
    calls: callsSince(page, before),
    dialogShown: false,
    overlay: redactHandoff(iframe.src)
  })
  matrix['granted-admin'] = '已有 open 的 admin → 打开直接 POST admin web-handoff 进同页覆盖层，零确认框零 PUT'
}, 120_000)

test('AA5-4 非 admin：不渲染自授入口，直调 PUT 403、项目 404 语义不变', async () => {
  // The write path stays the platform's: a project the developer cannot see
  // answers 404 (existence is never leaked), one they hold open on answers 403.
  const selfGrantId = await projectIdOf('selfgrant-project')
  const invisible = await api(`/v1/projects/${selfGrantId}/grants`, {
    method: 'PUT',
    token: devToken,
    body: JSON.stringify({ subjectType: 'user', subjectId: 'zhangsan', permissions: SELF_GRANT })
  })
  assert.equal(invisible.status, 404, 'an ungranted project is not even reachable for a developer')
  const hidden = await api(`/v1/projects/${selfGrantId}`, { token: devToken })
  assert.equal(hidden.status, 404, 'an ungranted project stays invisible to a developer')

  const devId = await projectIdOf('dev-project')
  const refused = await api(`/v1/projects/${devId}/grants`, {
    method: 'PUT',
    token: devToken,
    body: JSON.stringify({ subjectType: 'user', subjectId: 'zhangsan', permissions: SELF_GRANT })
  })
  assert.equal(refused.status, 403)
  assert.equal(refused.body.error?.code, 'PERMISSION_DENIED')
  const adminView = await getGrants(devId)
  assert.equal(
    adminView.filter((g) => g.username === 'zhangsan').length,
    0,
    'the refused PUT must not land a row'
  )

  const page = loadWebConsolePage(service.url)
  await page.settle()
  await page.submitLogin('zhangsan', 'Passw0rd!')
  await page.clickNav('workbench')
  assert.equal(
    page.window.document.querySelector('[data-self-grant]'),
    null,
    'a developer never gets the self-grant entry anywhere'
  )
  const devRow = rowFor(page, 'dev-project')
  assert.equal(entryIn(devRow, '授权并打开'), null)
  const openBtn = entryIn(devRow, '打开')
  assert.ok(openBtn)
  assert.equal(openBtn.disabled, false, 'an open-holding developer opens as before')

  const { opened } = captureOpened(page)
  const before = page.calls()
  openBtn.click()
  await page.settle()
  assert.equal(page.window.document.querySelector('.dialog-backdrop'), null)
  assert.deepEqual(callsSince(page, before), [`POST /v1/projects/${devId}/web-handoff`])
  assert.equal(opened.length, 0, 'U46-3 opens the overlay instead of a tab')
  const iframe = page.window.document.querySelector<HTMLIFrameElement>('#workspaceOverlay iframe')
  assert.ok(iframe, 'a developer holding open enters the workspace overlay')
  saveEvidence(EVIDENCE, 'non-admin-403.json', {
    invisibleGrantStatus: invisible.status,
    putStatus: refused.status,
    projectStatus: hidden.status,
    devHandoff: redactHandoff(iframe.src),
    selfGrantEntries: 0
  })
  matrix['non-admin'] =
    'developer：无自授入口、PUT 403 PERMISSION_DENIED、项目 404、持 open 直接 handoff'
}, 120_000)
