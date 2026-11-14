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
 *   TLS direct address, and stays empty without that address
 * - 工作台 and 我的项目 rows render the same two entries: 「详情」 for admins
 *   only, 「Orca Web」 for open-permission holders, both opening a new tab and
 *   both greyed out while the host is offline
 * - the developer 打开 dialog leads with the desktop-client guidance
 */

const EVIDENCE = 'w3-admin-entry'
const INTERNAL_TOKEN = 'w3-internal-token'
const BROWSER_EDGE_HOST = 'edge.w3.test:8443'

let service: Service
let adminToken = ''
let devToken = ''
let liveProjectId = ''
let liveSessionPageUrl = ''
let liveBrowserEntryUrl = ''
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
  liveSessionPageUrl = 'https://127.0.0.1:17001/cloud-admin.html'
  liveBrowserEntryUrl = `https://${BROWSER_EDGE_HOST}/h/dev-tls/web-index.html`

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

  // The admin's and the developer's groups both hold open on the two beating
  // hosts' projects, so each role exercises every online row state.
  for (const project of ['live-project', 'noedge-project']) {
    const id = await api('/v1/projects').then(
      (view) => view.body.projects.find((p: { key: string }) => p.key === project)?.id
    )
    for (const subjectId of ['platform-admins', 'team-payment']) {
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
  }

  // Keeps both beating hosts inside the heartbeat window; the rest stay silent
  // and are the offline side of the matrix.
  beat = setInterval(() => {
    for (const host of [tlsHost, noEdgeHost]) {
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

test('W3-payload 宿主 TLS 直连首项生成 sessionPageUrl', async () => {
  const adminView = await api('/v1/projects')
  const live = adminView.body.projects.find((p: { key: string }) => p.key === 'live-project')
  assert.equal(
    live.sessionPageUrl,
    'https://127.0.0.1:17001/cloud-admin.html',
    'the first TLS direct address must become the session page URL'
  )
  // The seeded host carries a TLS fingerprint and one direct address too.
  const seeded = adminView.body.projects.find((p: { key: string }) => p.key === 'payment-service')
  assert.equal(seeded.sessionPageUrl, 'https://127.0.0.1:16768/cloud-admin.html')

  const devView = await api('/v1/projects', { token: devToken })
  const devLive = devView.body.projects.find((p: { key: string }) => p.key === 'live-project')
  assert.ok(devLive, 'precondition: the developer holds open on the live project')
  assert.equal(devLive.sessionPageUrl, live.sessionPageUrl)

  saveEvidence(EVIDENCE, 'session-page-url-payload.json', {
    tlsHost: live.sessionPageUrl,
    seededHost: seeded.sessionPageUrl,
    developerSees: devLive.sessionPageUrl
  })
  matrix['payload'] = `TLS 直连 → ${live.sessionPageUrl}；开发者列表同值`
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
  assert.equal(detail.target, '_blank', 'the session page must open in a new tab')
  assert.equal(detail.rel, 'noopener')
  const orca = entryIn(liveRow, 'Orca Web') as HTMLAnchorElement | null
  assert.ok(orca, 'an open-permission admin gets the Orca Web entry')
  assert.equal(orca.href, liveBrowserEntryUrl, 'the entry carries the platform browser entry URL')
  assert.equal(orca.target, '_blank')

  // Beating host, but its route key never serves a browser edge.
  const noEdgeOrca = entryIn(rowFor(page, 'noedge-project'), 'Orca Web') as HTMLButtonElement | null
  assert.ok(noEdgeOrca?.disabled, 'a host without a browser edge keeps the entry greyed')
  assert.match(noEdgeOrca.title, /暂无浏览器入口/)

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
    live: { detail: detail.href, orcaWeb: orca.href },
    noBrowserEdge: noEdgeOrca.title,
    offlineDetail: offlineDetail.title
  })
  matrix['admin'] =
    '在线 → 详情指向 sessionPageUrl、Orca Web 指向 browserEntryUrl（均新标签）；无浏览器入口 → 占位禁用；离线 → 详情禁用 title=主机离线'
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
  matrix['orca-web-visibility'] = '有 open → 渲染；无 open（未授权管理员）→ 不渲染'
}, 120_000)

test('W3-developer 开发者无详情入口，Orca Web 随权限与浏览器入口渲染', async () => {
  await announceBrowserEdge()
  const page = loadWebConsolePage(service.url)
  await page.settle()
  await page.submitLogin('zhangsan', 'Passw0rd!')
  await page.clickNav('workbench')

  const liveRow = rowFor(page, 'live-project')
  assert.equal(entryIn(liveRow, '详情'), null, 'developers never get the detail entry')
  const orca = entryIn(liveRow, 'Orca Web') as HTMLAnchorElement | null
  assert.ok(orca, 'an open-permission holder sees the Orca Web entry')
  assert.equal(orca.href, liveBrowserEntryUrl)
  assert.equal(orca.target, '_blank')
  const openBtn = entryIn(liveRow, '打开') as HTMLButtonElement | null
  assert.equal(openBtn?.disabled, false, 'the developer can still open the project')

  const noEdgeOrca = entryIn(rowFor(page, 'noedge-project'), 'Orca Web') as HTMLButtonElement | null
  assert.ok(noEdgeOrca?.disabled)
  assert.match(noEdgeOrca.title, /暂无浏览器入口/)
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
    live: { orcaWeb: orca.href, openEnabled: openBtn?.disabled === false },
    noBrowserEdge: noEdgeOrca.title,
    offline: offlineOrca.title,
    pagesIdentical: actionsCell(projectsRow) === actionsCell(liveRow)
  })
  matrix['developer'] =
    '无详情入口；Orca Web 在线真链接、无浏览器入口占位、离线 title=主机离线；两页 actions 一致'
}, 120_000)

test('W3-guide 打开对话框首行引导使用桌面客户端', async () => {
  const page = loadWebConsolePage(service.url)
  await page.settle()
  await page.submitLogin('zhangsan', 'Passw0rd!')
  await page.clickNav('workbench')

  const openBtn = entryIn(rowFor(page, 'live-project'), '打开') as HTMLButtonElement
  openBtn.click()
  await page.settle()

  const body = page.window.document.querySelector('.dialog .body')
  assert.ok(body, 'opening a project must show the connect dialog')
  const firstLine = body.querySelector('p')?.textContent ?? ''
  assert.match(firstLine, /请在 Orca 桌面客户端中打开此项目/)
  assert.match(firstLine, /客户端将自动探测直连并连接/)
  assert.ok(
    page.calls().some((call) => call === `POST /v1/projects/${liveProjectId}/connect`),
    'the guidance rides on a real connect call'
  )
  saveEvidence(EVIDENCE, 'open-dialog-guidance.json', { firstLine: firstLine.trim() })
  matrix['open-dialog'] = '首行：请在 Orca 桌面客户端中打开此项目（客户端将自动探测直连并连接）'
}, 120_000)
