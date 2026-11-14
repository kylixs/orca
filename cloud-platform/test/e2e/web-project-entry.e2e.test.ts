import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { login, saveEvidence, spawnService, type Service } from './harness.ts'
import { loadWebConsolePage, type WebConsolePage } from './web-console-page.ts'

/**
 * W3 · M117 admin session-page entry plus the per-project row entries
 * (FR-3.8 / FR-3.11), driven through the real console files against a real
 * platform process.
 *
 * - the project payload carries `sessionPageUrl` built from the host's first
 *   TLS direct address plus `?api=<平台地址>` (the page is served by the host,
 *   so the param is how it finds the platform), and stays empty without a
 *   dialable TLS address in host:port form
 * - 工作台 and 我的项目 rows render the same two entries: 「详情」 for admins
 *   only (a link, opening a new tab), 「Orca Web」 for open-permission holders
 *   (an action button since M122: it mints a one-time handoff URL per click);
 *   both grey out while the host is offline or in maintenance
 * - W3c (FR-3.11 revision): 「打开」 is the same handoff entry — it mints a
 *   one-time URL and opens the workspace in a new tab, and the raw-address
 *   「连接信息已就绪」 dialog is gone
 */

const EVIDENCE = 'w3-fixes'
const INTERNAL_TOKEN = 'w3-internal-token'
const BROWSER_EDGE_HOST = 'edge.w3.test:8443'

let service: Service
let adminToken = ''
let devToken = ''
let liveProjectId = ''
let liveSessionPageUrl = ''
let maintHostId = ''
let beat: ReturnType<typeof setInterval> | undefined
const matrix: Record<string, string> = {}

async function api(
  path: string,
  init: RequestInit & { token?: string } = {}
  // oxlint-disable-next-line typescript/no-explicit-any -- same assert-driven shape as web-exploratory-fixes.e2e.test.ts
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

/**
 * Registers a host straight through the platform API so a test can pick its TLS
 * fingerprint and address list — the knobs `sessionPageUrl` reads.
 */
async function registerHost(input: {
  name: string
  directAddr?: string
  relayRoute?: string
  tlsFingerprint?: string
}): Promise<{ hostId: string; credential: string }> {
  const tokenRes = await fetch(`${service.url}/v1/hosts/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}` }
  })
  const { token } = (await tokenRes.json()) as { token: string }
  const res = await fetch(`${service.url}/v1/hosts/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      name: input.name,
      fingerprint: `sha256:${input.name}`,
      e2eePublicKeyB64: 'test-e2ee-key',
      orcaVersion: '1.5.0',
      protocolVersion: 3,
      networkZone: 'intranet',
      directAddrs: input.directAddr ? [input.directAddr] : [],
      ...(input.directAddr ? { relayTarget: input.directAddr } : {}),
      relayRoute: input.relayRoute ?? input.name,
      runtimeCapabilities: ['pty', 'files', 'managed-credential'],
      ...(input.tlsFingerprint ? { tlsFingerprint: input.tlsFingerprint } : {})
    })
  })
  if (!res.ok) {
    throw new Error(`register ${input.name} failed: ${await res.text()}`)
  }
  return (await res.json()) as { hostId: string; credential: string }
}

/** The relay node lives 30s per announcement, so every page check re-announces. */
async function announceBrowserEdge(): Promise<void> {
  const res = await fetch(`${service.url}/v1/internal/relay-endpoint`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
    body: JSON.stringify({
      id: 'relay-w3',
      host: '127.0.0.1',
      port: 18001,
      browserHost: BROWSER_EDGE_HOST
    })
  })
  assert.equal(res.status, 200, JSON.stringify(await res.json()))
}

async function createProject(key: string, hostId: string): Promise<string> {
  const created = await api('/v1/projects', {
    method: 'POST',
    body: JSON.stringify({ key, name: key, hostId, path: `/srv/work/${key}` })
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  return (created.body as { id: string }).id
}

/** Puts the open-permission bundle for one group on one project's row. */
async function grantOpen(projectKey: string, subjectId: string): Promise<void> {
  const view = await api('/v1/projects')
  const id = view.body.projects.find((p: { key: string }) => p.key === projectKey)?.id
  assert.ok(id, `precondition: ${projectKey} must be listed`)
  const granted = await api(`/v1/projects/${id}/grants`, {
    method: 'PUT',
    body: JSON.stringify({
      subjectType: 'group',
      subjectId,
      permissions: ['open', 'terminal', 'agent', 'file:read', 'file:write']
    })
  })
  assert.equal(granted.status, 200, JSON.stringify(granted.body))
}

before(async () => {
  service = await spawnService(
    'apps/api/src/server.ts',
    // The seeded host stops beating once the test starts, so liveness comes from
    // the heartbeat window rather than the stored status.
    { PORT: '0', INTERNAL_TOKEN, ORCA_CLOUD_HOST_OFFLINE_MS: '1500' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-web-project-entry'
  )
  adminToken = await login(service.url, 'admin', 'Adm1n!')
  devToken = await login(service.url, 'zhangsan', 'Passw0rd!')

  const tlsHost = await registerHost({
    name: 'dev-tls',
    directAddr: '127.0.0.1:17001',
    tlsFingerprint: 'sha256:devtls'
  })
  liveProjectId = await createProject('live-project', tlsHost.hostId)
  // The api param is what the host-served admin page uses to find the platform,
  // so it must be the platform address this console talks to — not the host.
  const platformApi = encodeURIComponent(service.url)
  liveSessionPageUrl = `https://127.0.0.1:17001/cloud-admin.html?api=${platformApi}`

  // A dotted route key is one the relay's /h/ parser refuses, so this host keeps
  // beating yet never gets a browser entry: the placeholder side of the matrix.
  const noEdgeHost = await registerHost({
    name: 'dev.noedge',
    directAddr: '127.0.0.1:17002',
    relayRoute: 'dev.noedge',
    tlsFingerprint: 'sha256:noedge'
  })
  await createProject('noedge-project', noEdgeHost.hostId)

  await createProject('locked-project', tlsHost.hostId)

  const plainHost = await registerHost({ name: 'dev-plain', directAddr: '127.0.0.1:17003' })
  await createProject('plain-project', plainHost.hostId)

  const addrlessHost = await registerHost({ name: 'dev-addrless' })
  await createProject('addrless-project', addrlessHost.hostId)

  // Registration stores directAddrs unvalidated, so an out-of-range port is the
  // only way the isDirectAddrForm negative branch is reachable.
  const badAddrHost = await registerHost({
    name: 'dev-badaddr',
    directAddr: '127.0.0.1:99999',
    tlsFingerprint: 'sha256:badaddr'
  })
  await createProject('badaddr-project', badAddrHost.hostId)

  // Two hosts with both entries visible to the admin: one is driven into
  // maintenance mid-run, the other is never beaten and so goes offline.
  const maintHost = await registerHost({
    name: 'dev-maint',
    directAddr: '127.0.0.1:17004',
    tlsFingerprint: 'sha256:maint'
  })
  maintHostId = maintHost.hostId
  await createProject('maint-project', maintHost.hostId)

  const comboHost = await registerHost({
    name: 'dev-combo',
    directAddr: '127.0.0.1:17005',
    tlsFingerprint: 'sha256:combo'
  })
  await createProject('combo-project', comboHost.hostId)

  // The admin's and the developer's groups both hold open on the two beating
  // hosts' projects, so each role exercises every online row state.
  for (const project of ['live-project', 'noedge-project']) {
    for (const subjectId of ['platform-admins', 'team-payment']) {
      await grantOpen(project, subjectId)
    }
  }
  for (const project of ['badaddr-project', 'maint-project', 'combo-project']) {
    await grantOpen(project, 'platform-admins')
  }

  // Keeps every beating host inside the heartbeat window; the rest stay silent
  // and are the offline side of the matrix.
  beat = setInterval(() => {
    for (const host of [tlsHost, noEdgeHost, badAddrHost, maintHost]) {
      void fetch(`${service.url}/v1/hosts/${host.hostId}/heartbeat`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${host.credential}`
        },
        body: JSON.stringify({ status: 'online' })
      }).catch(() => undefined)
    }
  }, 400)
}, 120_000)

after(async () => {
  if (beat) {
    clearInterval(beat)
  }
  await service?.stop()
  saveEvidence(EVIDENCE, 'entry-matrix.json', { feature: 'W3 M117+M122 双入口', cases: matrix })
})

/** The `tr` for the named project row in the main content table. */
function rowFor(page: WebConsolePage, name: string): HTMLElement {
  const row = [...page.window.document.querySelectorAll<HTMLElement>('#content tbody tr')].find(
    (candidate) => candidate.textContent?.includes(name)
  )
  assert.ok(row, `a row for ${name} must be rendered`)
  return row
}

function entryIn(row: HTMLElement, label: string): HTMLButtonElement | HTMLAnchorElement | null {
  return (
    [...row.querySelectorAll<HTMLButtonElement>('button')].find(
      (candidate) => candidate.textContent?.trim() === label
    ) ??
    [...row.querySelectorAll<HTMLAnchorElement>('a')].find(
      (candidate) => candidate.textContent?.trim() === label
    ) ??
    null
  )
}

function actionsCell(row: HTMLElement): string {
  return (row.querySelector('td.actions')?.innerHTML ?? '').replace(/\s+/g, ' ').trim()
}

test('W3-payload 宿主 TLS 直连首项生成 sessionPageUrl（含 ?api= 平台地址）', async () => {
  const adminView = await api('/v1/projects')
  const live = adminView.body.projects.find((p: { key: string }) => p.key === 'live-project')
  assert.equal(
    live.sessionPageUrl,
    liveSessionPageUrl,
    'the first TLS direct address plus the platform origin must become the session page URL'
  )
  const liveUrl = new URL(live.sessionPageUrl)
  // Cross-origin by construction: the page lives on the host's origin, so the
  // api param is the only way it can find the platform the admin came from.
  assert.equal(liveUrl.origin, 'https://127.0.0.1:17001', 'the page is served by the host')
  assert.equal(
    liveUrl.searchParams.get('api'),
    service.url,
    'api must point back at the platform, not the host serving the page'
  )
  // The seeded host carries a TLS fingerprint and one direct address too.
  const seeded = adminView.body.projects.find((p: { key: string }) => p.key === 'payment-service')
  assert.equal(
    seeded.sessionPageUrl,
    `https://127.0.0.1:16768/cloud-admin.html?api=${encodeURIComponent(service.url)}`
  )

  const devView = await api('/v1/projects', { token: devToken })
  const devLive = devView.body.projects.find((p: { key: string }) => p.key === 'live-project')
  assert.ok(devLive, 'precondition: the developer holds open on the live project')
  assert.equal(devLive.sessionPageUrl, live.sessionPageUrl)

  saveEvidence(EVIDENCE, 'session-page-url-payload.json', {
    tlsHost: live.sessionPageUrl,
    apiParam: liveUrl.searchParams.get('api'),
    platformOrigin: service.url,
    pageOrigin: liveUrl.origin,
    seededHost: seeded.sessionPageUrl,
    developerSees: devLive.sessionPageUrl
  })
  matrix['payload'] = `TLS 直连 + ?api=${service.url} → ${live.sessionPageUrl}；开发者列表同值`
}, 120_000)

test('W3-payload 无 TLS 指纹或无直连地址时 sessionPageUrl 为空串', async () => {
  const view = await api('/v1/projects')
  const plain = view.body.projects.find((p: { key: string }) => p.key === 'plain-project')
  const addrless = view.body.projects.find((p: { key: string }) => p.key === 'addrless-project')
  assert.equal(plain.sessionPageUrl, '', 'a host without a TLS fingerprint has no session page')
  assert.equal(addrless.sessionPageUrl, '', 'a host without direct addresses has no session page')
  saveEvidence(EVIDENCE, 'session-page-url-negative.json', {
    noTlsFingerprint: plain.sessionPageUrl,
    noDirectAddr: addrless.sessionPageUrl
  })
  matrix['payload-negative'] = '无 TLS 指纹 → ""；无直连地址 → ""'
}, 120_000)

test('W3-payload 直连地址非 host:port 形态时 sessionPageUrl 为空串', async () => {
  const view = await api('/v1/projects')
  const bad = view.body.projects.find((p: { key: string }) => p.key === 'badaddr-project')
  assert.equal(
    bad.sessionPageUrl,
    '',
    'a direct address outside host:port form must never become a session page URL'
  )
  saveEvidence(EVIDENCE, 'session-page-url-malformed-addr.json', {
    directAddr: '127.0.0.1:99999',
    sessionPageUrl: bad.sessionPageUrl
  })
  matrix['payload-malformed-addr'] = '直连地址端口越界（99999）→ ""（isDirectAddrForm 负例）'
}, 120_000)

test('W3-admin 管理员双入口：详情与 Orca Web 新标签，离线置灰', async () => {
  await announceBrowserEdge()
  const page = loadWebConsolePage(service.url)
  await page.settle()
  await page.submitLogin('admin', 'Adm1n!')
  await page.clickNav('workbench')

  const liveRow = rowFor(page, 'live-project')
  const detail = entryIn(liveRow, '详情') as HTMLAnchorElement | null
  assert.ok(detail, 'an online host shows the admin detail entry')
  assert.equal(detail.href, liveSessionPageUrl)
  // The browser opens the page on the host's origin, which is not the platform's
  // — the api param is what carries the platform address across.
  assert.equal(new URL(detail.href).searchParams.get('api'), service.url)
  assert.equal(detail.target, '_blank', 'the session page must open in a new tab')
  assert.equal(detail.rel, 'noopener')
  // M122: the entry mints a handoff URL per click, so it is an action button.
  const orca = entryIn(liveRow, 'Orca Web') as HTMLButtonElement | null
  assert.ok(orca, 'an open-permission admin gets the Orca Web entry')
  assert.equal(orca.tagName, 'BUTTON', 'Orca Web mints its URL per click, so it is not a link')
  assert.equal(orca.dataset.orcaWeb, liveProjectId)
  assert.equal(orca.disabled, false)

  // Beating host, but its route key never serves a browser edge: M122 leaves the
  // click to the platform, which still serves the host's direct web-index entry.
  const noEdgeOrca = entryIn(rowFor(page, 'noedge-project'), 'Orca Web') as HTMLButtonElement | null
  assert.ok(noEdgeOrca, 'a host without a browser edge keeps the entry clickable')
  assert.equal(noEdgeOrca.disabled, false, 'the platform, not the console, decides per click')

  const offlineRow = rowFor(page, 'payment-service')
  const offlineDetail = entryIn(offlineRow, '详情') as HTMLButtonElement | null
  assert.ok(offlineDetail, 'the detail entry stays visible while the host is down')
  assert.equal(offlineDetail.disabled, true, 'an offline host greys the detail entry')
  assert.equal(offlineDetail.title, '主机离线')
  // The seeded project carries no grant for the admin's group, so it correctly
  // renders no Orca Web entry at all — the offline greying of that entry is
  // covered on the developer rows below.

  await page.clickNav('projects')
  const projectsRow = rowFor(page, 'payment-service')
  assert.equal(
    (entryIn(projectsRow, '详情') as HTMLButtonElement | null)?.disabled,
    true,
    'the projects page greys the detail entry the same way'
  )
  saveEvidence(EVIDENCE, 'admin-entries.json', {
    live: { detail: detail.href, orcaWeb: `action:${orca.dataset.orcaWeb}` },
    noBrowserEdge: `clickable:${noEdgeOrca.disabled === false}`,
    offlineDetail: offlineDetail.title
  })
  matrix['admin'] =
    '在线 → 详情指向 sessionPageUrl（新标签）、Orca Web 为 mint-per-click 动作按钮；无浏览器入口 → 仍可点击由平台裁定；离线 → 详情禁用 title=主机离线'
}, 120_000)

test('W3-orca-web 无 open 权限不渲染 Orca Web 入口', async () => {
  await announceBrowserEdge()
  const page = loadWebConsolePage(service.url)
  await page.settle()
  await page.submitLogin('admin', 'Adm1n!')
  await page.clickNav('workbench')

  const lockedRow = rowFor(page, 'locked-project')
  assert.ok(entryIn(lockedRow, '详情'), 'the admin still gets the detail entry')
  assert.equal(
    entryIn(lockedRow, 'Orca Web'),
    null,
    'a user without open must not see the Orca Web entry at all'
  )
  // W3c: 打开 mints a handoff now, so it greys out for the same reason — the
  // platform would refuse the mint (403 PROJECT_FORBIDDEN) without the grant.
  const openBtn = entryIn(lockedRow, '打开') as HTMLButtonElement | null
  assert.equal(openBtn?.disabled, true, 'a user without open cannot open the project')
  assert.match(openBtn?.title ?? '', /未授权/)
  matrix['orca-web-visibility'] = '有 open → 渲染；无 open（未授权管理员）→ 不渲染且打开置灰'
}, 120_000)

test('W3-developer 开发者无详情入口，Orca Web 随权限与浏览器入口渲染', async () => {
  await announceBrowserEdge()
  const page = loadWebConsolePage(service.url)
  await page.settle()
  await page.submitLogin('zhangsan', 'Passw0rd!')
  await page.clickNav('workbench')

  const liveRow = rowFor(page, 'live-project')
  assert.equal(entryIn(liveRow, '详情'), null, 'developers never get the detail entry')
  const orca = entryIn(liveRow, 'Orca Web') as HTMLButtonElement | null
  assert.ok(orca, 'an open-permission holder sees the Orca Web entry')
  assert.equal(orca.dataset.orcaWeb, liveProjectId)
  assert.equal(orca.disabled, false)
  const openBtn = entryIn(liveRow, '打开') as HTMLButtonElement | null
  assert.equal(openBtn?.disabled, false, 'the developer can still open the project')

  const noEdgeOrca = entryIn(rowFor(page, 'noedge-project'), 'Orca Web') as HTMLButtonElement | null
  assert.ok(noEdgeOrca)
  assert.equal(noEdgeOrca.disabled, false, 'a host without a browser edge still mints an entry')
  const offlineOrca = entryIn(
    rowFor(page, 'payment-service'),
    'Orca Web'
  ) as HTMLButtonElement | null
  assert.equal(offlineOrca?.disabled, true, 'an offline host greys the Orca Web entry')
  assert.equal(offlineOrca.title, '主机离线')

  await page.clickNav('projects')
  const projectsRow = rowFor(page, 'live-project')
  assert.equal(entryIn(projectsRow, '详情'), null, 'no detail entry on the projects page either')
  assert.equal(
    actionsCell(projectsRow),
    actionsCell(liveRow),
    '工作台 and 我的项目 must render identical row entries'
  )
  saveEvidence(EVIDENCE, 'developer-entries.json', {
    live: { orcaWeb: `action:${orca.dataset.orcaWeb}`, openEnabled: openBtn?.disabled === false },
    noBrowserEdge: `clickable:${noEdgeOrca.disabled === false}`,
    offline: offlineOrca.title,
    pagesIdentical: actionsCell(projectsRow) === actionsCell(liveRow)
  })
  matrix['developer'] =
    '无详情入口；Orca Web 在线为动作按钮、无浏览器入口仍可点击、离线 title=主机离线；两页 actions 一致'
}, 120_000)

test('W3c-open 打开走 web-handoff 新标签进入工作区，不再弹连接信息对话框', async () => {
  await announceBrowserEdge()
  const page = loadWebConsolePage(service.url)
  await page.settle()
  await page.submitLogin('zhangsan', 'Passw0rd!')
  await page.clickNav('workbench')

  const opened: string[] = []
  page.window.open = ((url?: string | URL) => {
    opened.push(String(url))
    return null
    // oxlint-disable-next-line typescript/no-explicit-any -- happy-dom's open signature is wider than the stub needs
  }) as any

  const openBtn = entryIn(rowFor(page, 'live-project'), '打开') as HTMLButtonElement
  assert.equal(openBtn.disabled, false, 'an open-permission holder can open the project')
  openBtn.click()
  await page.settle()

  assert.equal(
    page.window.document.querySelector('.dialog'),
    null,
    'the raw-address「连接信息已就绪」dialog must be gone'
  )
  assert.deepEqual(
    page.calls().filter((call) => call.endsWith('/connect') || call.includes('/web-handoff')),
    [`POST /v1/projects/${liveProjectId}/web-handoff`],
    '打开 mints a handoff and never calls the desktop /connect'
  )
  assert.equal(opened.length, 1, 'the issued URL opens exactly one new tab')
  const openedUrl = new URL(opened[0])
  assert.equal(openedUrl.searchParams.get('api'), service.url)
  assert.match(openedUrl.hash, /^#handoff=[A-Za-z0-9_-]+&project=/)

  saveEvidence(EVIDENCE, 'open-handoff-entry.json', {
    call: `POST /v1/projects/${liveProjectId}/web-handoff`,
    opened: opened[0].replace(/#handoff=[A-Za-z0-9_-]+/, '#handoff=<redacted>'),
    dialogShown: page.window.document.querySelector('.dialog') !== null
  })
  matrix['open-entry'] =
    '有 open 权限点「打开」→ POST web-handoff → window.open(一次性 URL) 进工作区；无连接信息对话框、无 /connect 调用'
}, 120_000)

test('W3-admin 在线但无可直达会话页地址时详情置灰', async () => {
  await announceBrowserEdge()
  const page = loadWebConsolePage(service.url)
  await page.settle()
  await page.submitLogin('admin', 'Adm1n!')
  await page.clickNav('workbench')

  const row = rowFor(page, 'badaddr-project')
  const detail = entryIn(row, '详情') as HTMLButtonElement | null
  assert.ok(detail, 'an online host still renders the detail entry')
  assert.equal(detail.disabled, true, 'no session page address means the entry cannot open')
  assert.equal(detail.title, '该主机没有可直达的会话页地址')
  // The host is online with a healthy browser edge, so the row is not dead —
  // the greyed entry is about the session page alone.
  const orca = entryIn(row, 'Orca Web') as HTMLButtonElement | null
  assert.ok(orca, 'the same online row keeps a live Orca Web entry')
  assert.equal(
    orca.tagName,
    'BUTTON',
    'Orca Web must stay an action button, not inherit the greyed state'
  )
  assert.equal(orca.disabled, false)
  saveEvidence(EVIDENCE, 'online-no-session-page-detail.json', {
    detailTitle: detail.title,
    detailDisabled: detail.disabled,
    orcaWebClickable: orca.disabled === false
  })
  matrix['online-no-addr'] =
    '在线 + 无会话页地址 → 详情 disabled title=该主机没有可直达的会话页地址；Orca Web 仍可点击'
}, 120_000)

test('W3-maintenance 维护态双入口置灰，退出维护恢复真链接', async () => {
  await announceBrowserEdge()
  const entered = await api(`/v1/hosts/${maintHostId}/maintenance`, {
    method: 'POST',
    body: JSON.stringify({ enabled: true, reason: 'W3 审计维护演练' })
  })
  assert.equal(entered.status, 200, JSON.stringify(entered.body))

  const page = loadWebConsolePage(service.url)
  await page.settle()
  await page.submitLogin('admin', 'Adm1n!')
  await page.clickNav('workbench')

  const row = rowFor(page, 'maint-project')
  const detail = entryIn(row, '详情') as HTMLButtonElement | null
  const orca = entryIn(row, 'Orca Web') as HTMLButtonElement | null
  assert.ok(detail, 'a maintenance host keeps the detail entry visible')
  assert.ok(orca, 'a maintenance host keeps the Orca Web entry visible')
  assert.equal(detail.disabled, true)
  assert.equal(detail.title, '主机维护中')
  assert.equal(orca.disabled, true)
  assert.equal(orca.title, '主机维护中')
  saveEvidence(EVIDENCE, 'maintenance-entries.json', {
    detail: detail.title,
    orcaWeb: orca.title
  })

  // Recovery: leaving maintenance turns both entries back into real links, so
  // the greying is the maintenance window speaking, not a permanent state.
  const exited = await api(`/v1/hosts/${maintHostId}/maintenance`, {
    method: 'POST',
    body: JSON.stringify({ enabled: false })
  })
  assert.equal(exited.status, 200, JSON.stringify(exited.body))
  const recovered = loadWebConsolePage(service.url)
  await recovered.settle()
  await recovered.submitLogin('admin', 'Adm1n!')
  await recovered.clickNav('workbench')
  const liveRow = rowFor(recovered, 'maint-project')
  const liveDetail = entryIn(liveRow, '详情') as HTMLAnchorElement | null
  const liveOrca = entryIn(liveRow, 'Orca Web') as HTMLButtonElement | null
  assert.ok(liveDetail, 'the detail entry comes back as a link')
  assert.ok(liveOrca, 'the Orca Web entry comes back clickable')
  assert.equal(liveDetail.tagName, 'A', 'recovery must restore the anchor, not the greyed button')
  assert.equal(
    new URL(liveDetail.href).searchParams.get('api'),
    service.url,
    'the recovered detail entry still carries the platform api param'
  )
  assert.equal(liveOrca.disabled, false, 'recovery must restore the Orca Web action')
  saveEvidence(EVIDENCE, 'maintenance-recovered.json', {
    detail: liveDetail.href,
    orcaWeb: `clickable:${liveOrca.disabled === false}`
  })
  matrix['maintenance'] =
    '维护中 → 详情/Orca Web 均 disabled title=主机维护中；退出维护 → 详情恢复真链接（含 ?api=）、Orca Web 恢复可点击'
}, 120_000)

test('W3-admin-open 离线宿主行三控件同态置灰', async () => {
  await announceBrowserEdge()
  const page = loadWebConsolePage(service.url)
  await page.settle()
  await page.submitLogin('admin', 'Adm1n!')
  await page.clickNav('workbench')

  const open = entryIn(rowFor(page, 'combo-project'), '打开') as HTMLButtonElement | null
  const detail = entryIn(rowFor(page, 'combo-project'), '详情') as HTMLButtonElement | null
  const orca = entryIn(rowFor(page, 'combo-project'), 'Orca Web') as HTMLButtonElement | null
  const titles: Record<string, string> = {}
  for (const control of [open, detail, orca]) {
    assert.ok(control, 'an admin holding open sees all three controls on the row')
    assert.equal(control.disabled, true, `${control.textContent} must be greyed while offline`)
    assert.equal(control.title, '主机离线', `${control.textContent} must name the offline reason`)
    titles[control.textContent?.trim() ?? ''] = control.title
  }
  saveEvidence(EVIDENCE, 'offline-admin-open-combo.json', titles)
  matrix['offline-combo'] =
    'admin+open+离线 → 打开/详情/Orca Web 三控件 disabled 且 title 同为主机离线'
}, 120_000)
