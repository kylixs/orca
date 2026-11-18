import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { login, registerHost, saveEvidence, spawnService, type Service } from './harness.ts'
import {
  assertInstallTemplateInterpolations,
  renderInstallCommand
} from './helpers/install-command-harness.ts'
import { loadWebConsolePage, readWebAppSource, type WebConsolePage } from './web-console-page.ts'

/**
 * G09: the maintenance/revoke console actions and the registration dialog
 * (AC-M4-07/09, D2) must report failures instead of dropping the rejection.
 *
 * - entering maintenance redraws the row and disables the project open entry
 * - revoking asks the native confirm; cancel sends no DELETE, confirm revokes
 * - the registration dialog copies the command, keeps itself open, and toasts
 * - a refused mint/maintenance/revoke surfaces `<action>失败：<reason>`
 *   and leaves both the drawer and the platform state untouched
 */

const EVIDENCE = 'g09-host-lifecycle-feedback'
const FAILURE_BODY = { error: { code: 'SIMULATED_FAILURE', message: '模拟平台故障' } }

/**
 * U288: derive the expected command from the same cached app.js read the page
 * runs. Import stays disk-free, so one bad read cannot take all four cases down.
 */
function installTemplate(): { file: string; template: string } {
  const appSource = readWebAppSource()
  const fn = /function installCommand\(url\) \{\n([\s\S]*?)\n\}/.exec(appSource)
  assert.ok(fn, 'app.js must define installCommand(url)')
  const file = /const file = '([^']+)'/.exec(fn[1])?.[1]
  assert.ok(file, 'installCommand must bind the temp file path')
  const template = /return `([\s\S]*?)`/.exec(fn[1])?.[1]
  assert.ok(template, 'installCommand must return a template literal')
  assertInstallTemplateInterpolations(template)
  return { file, template }
}

let service: Service
let adminToken = ''
let lifecycleHostId = ''
let failHostId = ''
let projectName = ''
const cases: Record<string, string> = {}

type HostPayload = { id: string; status: string; revokedAt?: string | null }

async function api(
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${service.url}${path}`, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: init.body
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

async function hostFromPlatform(id: string): Promise<HostPayload> {
  const res = await api('/v1/hosts')
  assert.equal(res.status, 200)
  const hosts = res.body.hosts as HostPayload[]
  const host = hosts.find((candidate) => candidate.id === id)
  assert.ok(host, `host ${id} must exist on the platform`)
  return host
}

function lastToast(page: WebConsolePage): string {
  return [...page.window.document.querySelectorAll('.toast')].at(-1)?.textContent ?? ''
}

function callsTo(page: WebConsolePage, method: string, path: string): number {
  return page.calls().filter((call) => call === `${method} ${path}`).length
}

function bodyOf(page: WebConsolePage, call: string): unknown {
  return page.bodies().find((entry) => entry.call === call)?.body
}

function rows(page: WebConsolePage): HTMLElement[] {
  return [...page.window.document.querySelectorAll<HTMLElement>('#content tbody tr')]
}

function rowFor(page: WebConsolePage, name: string): HTMLElement {
  const row = rows(page).find((candidate) => candidate.textContent?.includes(name))
  assert.ok(row, `a row for ${name} must be rendered`)
  return row
}

async function loginAsAdmin(page: WebConsolePage): Promise<void> {
  await page.settle()
  await page.submitLogin('admin', 'Adm1n!')
}

async function openHostDrawer(page: WebConsolePage, hostId: string): Promise<void> {
  await page.clickNav('hosts')
  const button = [...page.window.document.querySelectorAll<HTMLButtonElement>('[data-host]')].find(
    (candidate) => candidate.dataset.host === hostId
  )
  assert.ok(button, 'the hosts page must list the host')
  button.click()
  await page.settle()
}

function drawer(page: WebConsolePage): HTMLElement | null {
  return page.window.document.querySelector<HTMLElement>('.drawer')
}

before(async () => {
  // U288: surface an unreadable app.js here, once, instead of failing at import.
  installTemplate()
  service = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN: 'g09-internal-token' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-web-host-lifecycle-feedback'
  )
  adminToken = await login(service.url, 'admin', 'Adm1n!')

  const lifecycle = await registerHost({
    apiUrl: service.url,
    adminToken,
    name: 'dev-g09-lifecycle',
    directAddr: '127.0.0.1:17190',
    relayTarget: '127.0.0.1:17190',
    projectsRoot: '/srv/g09'
  })
  lifecycleHostId = lifecycle.hostId

  const failing = await registerHost({
    apiUrl: service.url,
    adminToken,
    name: 'dev-g09-fail',
    directAddr: '127.0.0.1:17191',
    relayTarget: '127.0.0.1:17191'
  })
  failHostId = failing.hostId

  projectName = 'g09-lifecycle-project'
  const created = await api('/v1/projects', {
    method: 'POST',
    body: JSON.stringify({
      key: projectName,
      name: projectName,
      hostId: lifecycleHostId,
      path: '/srv/g09/g09-lifecycle-project'
    })
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
}, { timeout: 120_000 })

after(async () => {
  await service?.stop()
  saveEvidence(EVIDENCE, 'summary.json', {
    workOrder: 'G09 host maintenance/revoke UI + registration dialog feedback',
    lifecycleHostId,
    failHostId,
    projectName,
    cases
  })
})

test('G09-1 抽屉「进入维护模式」→ 行变维护中、项目打开入口禁用', { timeout: 120_000 }, async () => {
  const page = loadWebConsolePage(service.url)
  await loginAsAdmin(page)
  await openHostDrawer(page, lifecycleHostId)

  const maintenancePath = `/v1/hosts/${lifecycleHostId}/maintenance`
  page.window.document.querySelector<HTMLButtonElement>('#maintenanceBtn')!.click()
  await page.settle()

  assert.equal(callsTo(page, 'POST', maintenancePath), 1, 'the maintenance POST is sent once')
  assert.deepEqual(
    bodyOf(page, `POST ${maintenancePath}`),
    { enabled: true, reason: '管理员操作' },
    'the drawer enters maintenance with its reason'
  )
  assert.equal(drawer(page), null, 'success closes the drawer')
  assert.match(rowFor(page, 'dev-g09-lifecycle').textContent ?? '', /维护中/)
  assert.equal((await hostFromPlatform(lifecycleHostId)).status, 'maintenance')

  await page.clickNav('workbench')
  const projectRow = rowFor(page, projectName)
  const open = projectRow.querySelector<HTMLButtonElement>('[data-open]')
  assert.ok(open, 'the project row must carry an open entry')
  assert.equal(open.disabled, true, 'a project on a maintenance host cannot be opened')
  assert.match(open.title, /维护/)

  cases['maintenance-enter'] =
    '抽屉进入维护 → POST {enabled:true,reason}；列表行维护中；项目打开禁用（主机维护中）'
})

test('G09-2 下线：样式化确认卡取消零 DELETE，确认后行变已吊销', { timeout: 120_000 }, async () => {
  const page = loadWebConsolePage(service.url)
  await loginAsAdmin(page)
  await openHostDrawer(page, lifecycleHostId)

  const revokePath = `/v1/hosts/${lifecycleHostId}`
  page.window.document.querySelector<HTMLButtonElement>('#revokeHostBtn')!.click()
  await page.settle()

  const cancelCard = page.window.document.querySelector<HTMLElement>('.dialog-backdrop')
  assert.ok(cancelCard, 'the styled confirm card opens instead of window.confirm')
  assert.match(cancelCard.textContent ?? '', /下线后.*凭证失效.*不可撤销/)
  cancelCard.querySelector<HTMLButtonElement>('[data-action="0"]')!.click()
  await page.settle()

  assert.equal(callsTo(page, 'DELETE', revokePath), 0, 'cancel sends no DELETE')
  assert.ok(drawer(page), 'cancel keeps the drawer open')
  assert.equal((await hostFromPlatform(lifecycleHostId)).revokedAt ?? null, null)

  page.window.document.querySelector<HTMLButtonElement>('#revokeHostBtn')!.click()
  await page.settle()
  page.window.document
    .querySelector<HTMLButtonElement>('.dialog-backdrop [data-action="1"]')!
    .click()
  await page.settle()

  assert.equal(callsTo(page, 'DELETE', revokePath), 1, 'confirm sends exactly one DELETE')
  assert.equal(drawer(page), null, 'success closes the drawer')
  assert.match(rowFor(page, 'dev-g09-lifecycle').textContent ?? '', /已吊销/)
  assert.ok((await hostFromPlatform(lifecycleHostId)).revokedAt, 'the platform records revocation')

  cases['revoke-confirm'] =
    '样式化确认卡：取消 → 0 DELETE、抽屉不关、平台未吊销；确认 → 1 DELETE、行已吊销'
})

test('G09-3 注册弹框「复制命令」：写入完整命令、toast 已复制、弹框保持', { timeout: 120_000 }, async () => {
  const page = loadWebConsolePage(service.url)
  await loginAsAdmin(page)
  await page.clickNav('hosts')

  const copies: string[] = []
  Object.defineProperty(page.window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: (value: string) => (copies.push(value), Promise.resolve()) }
  })

  page.window.document.querySelector<HTMLButtonElement>('#registerHostBtn')!.click()
  await page.settle()

  // QA-033: opening mints nothing; the token comes from the explicit action.
  assert.equal(callsTo(page, 'POST', '/v1/hosts/tokens'), 0, 'opening mints no token')
  page.window.document.querySelector<HTMLButtonElement>('#generateHostTokenBtn')!.click()
  await page.settle()
  assert.equal(callsTo(page, 'POST', '/v1/hosts/tokens'), 1, 'generate mints one token')
  const command = page.window.document.querySelector('#installCmd')?.textContent ?? ''
  const installUrl = /curl -fsSL "([^"]+)"/.exec(command)?.[1]
  assert.ok(installUrl, 'command downloads the script from the install endpoint')
  // U288: pins the URL app.js builds, not the server route (the matrix suite
  // covers the route); echoing the command's own URL could not catch drift.
  const endpoint = new URL(installUrl)
  assert.equal(
    endpoint.origin,
    'https://web.console.local',
    'the one-liner targets the console origin'
  )
  assert.equal(endpoint.pathname, '/install/host.sh', 'the path app.js builds is pinned')
  assert.ok(endpoint.searchParams.get('token'), 'the install URL carries the registration token')
  // Derive the expected command from app.js's own template so a template edit
  // cannot stale this assertion; the contract itself is pinned below (U284).
  const install = installTemplate()
  assert.equal(
    command,
    renderInstallCommand(install.template, install.file, installUrl),
    'the dialog renders the current one-liner template verbatim'
  )
  assert.match(command, /token=/)
  assert.match(command, /trap '[^']+' EXIT;/, 'an EXIT trap cleans up the temp file')
  assert.match(
    command,
    /-o "\$file" \|\| \{[^}]*exit 65; \}/,
    'a failed download exits 65 instead of running an empty script (U182/U276)'
  )
  assert.match(command, /exit "\$code"$/, 'the install script exit code is propagated (U181)')
  assert.doesNotMatch(command, /bash <\(curl/)

  page.window.document.querySelector<HTMLButtonElement>('#copyInstallCmd')!.click()
  await page.settle()

  assert.deepEqual(copies, [command], 'the copy action writes the full command')
  assert.equal(lastToast(page), '已复制')
  assert.ok(page.window.document.querySelector('.dialog-backdrop'), 'copy keeps the dialog open')

  cases['copy-command'] = '注册弹框展示命令；复制写入完整 bash 命令、toast 已复制、弹框保持'
})

test('G09-4 失败态：令牌/维护/下线请求失败均 toast 原因且状态不变', { timeout: 120_000 }, async () => {
  const page = loadWebConsolePage(service.url)
  await loginAsAdmin(page)
  await page.clickNav('hosts')

  page.fail('POST', '/v1/hosts/tokens', { status: 500, body: FAILURE_BODY })
  page.window.document.querySelector<HTMLButtonElement>('#registerHostBtn')!.click()
  await page.settle()
  assert.equal(callsTo(page, 'POST', '/v1/hosts/tokens'), 0, 'opening mints no token')
  page.window.document.querySelector<HTMLButtonElement>('#generateHostTokenBtn')!.click()
  await page.settle()
  assert.equal(callsTo(page, 'POST', '/v1/hosts/tokens'), 1, 'generate attempts one mint')
  assert.match(
    page.window.document.querySelector('#registerHostTokenError')?.textContent ?? '',
    /^生成注册命令失败：模拟平台故障$/
  )
  assert.ok(
    page.window.document.querySelector('.dialog-backdrop'),
    'a refused mint keeps the dialog open for retry'
  )

  await openHostDrawer(page, failHostId)
  const maintenancePath = `/v1/hosts/${failHostId}/maintenance`
  page.fail('POST', maintenancePath, { status: 500, body: FAILURE_BODY })
  page.window.document.querySelector<HTMLButtonElement>('#maintenanceBtn')!.click()
  await page.settle()
  assert.match(lastToast(page), /^进入维护模式失败：模拟平台故障$/)
  assert.ok(drawer(page), 'a refused maintenance leaves the drawer open')
  assert.equal((await hostFromPlatform(failHostId)).status, 'online')

  const revokePath = `/v1/hosts/${failHostId}`
  page.fail('DELETE', revokePath, { status: 500, body: FAILURE_BODY })
  page.window.document.querySelector<HTMLButtonElement>('#revokeHostBtn')!.click()
  await page.settle()
  page.window.document
    .querySelector<HTMLButtonElement>('.dialog-backdrop [data-action="1"]')!
    .click()
  await page.settle()
  assert.match(lastToast(page), /^下线主机失败：模拟平台故障$/)
  assert.ok(drawer(page), 'a refused revoke leaves the drawer open')
  assert.equal((await hostFromPlatform(failHostId)).revokedAt ?? null, null)

  page.clearFails()
  cases['failure-toast'] =
    '令牌 500 → 注册主机失败：模拟平台故障（不开弹框）；维护 500 → 进入维护模式失败、状态 online；下线 500 → 下线主机失败、未吊销'
})
