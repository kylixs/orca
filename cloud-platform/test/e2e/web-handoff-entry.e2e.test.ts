import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { saveEvidence, spawnService, type Service } from './harness.ts'
import { loadWebConsolePage, type WebConsolePage } from './web-console-page.ts'

/**
 * W7b · M122 handoff consumption side (FR-3.10): the controlled CORS handshake
 * the host-served pages need, the entry URL composition (relay browser edge
 * first, TLS direct address second, `?api=` always), and the console project row
 * minting a one-time handoff URL per click.
 */

const EVIDENCE = 'w7b-handoff-web'
const INTERNAL_TOKEN = 'w7b-internal-token'
const BROWSER_EDGE_HOST = 'edge.w7b.test:8443'
/** The seeded host's direct address: the origin a real web-index page would run on. */
const HOST_ORIGIN = 'https://127.0.0.1:16768'
const EDGE_ORIGIN = `https://${BROWSER_EDGE_HOST}`

let service: Service
let adminToken = ''
let devToken = ''
let relayedProjectId = ''
let relayOnlyProjectId = ''
let directProjectId = ''
let beat: ReturnType<typeof setInterval> | undefined
const beating: { hostId: string; credential: string }[] = []
const matrix: Record<string, string> = {}

async function api(
  path: string,
  init: RequestInit & { token?: string; origin?: string } = {}
): Promise<{ status: number; headers: Headers; body: unknown }> {
  const res = await fetch(`${service.url}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${init.token ?? adminToken}`,
      ...(init.origin ? { origin: init.origin } : {}),
      ...init.headers
    },
    body: init.body
  })
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => ({})) }
}

async function registerHost(input: {
  name: string
  directAddr?: string
  relayRoute?: string
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
      runtimeCapabilities: ['pty', 'files']
    })
  })
  const body = (await res.json()) as { hostId?: string; credential?: string }
  assert.equal(res.status, 201, JSON.stringify(body))
  return { hostId: body.hostId ?? '', credential: body.credential ?? '' }
}

async function createProject(key: string, hostId: string): Promise<string> {
  const created = await api('/v1/projects', {
    method: 'POST',
    body: JSON.stringify({ key, name: key, hostId, path: `/srv/work/${key}` })
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  return (created.body as { id: string }).id
}

async function grantOpen(projectId: string): Promise<void> {
  const granted = await api(`/v1/projects/${projectId}/grants`, {
    method: 'PUT',
    body: JSON.stringify({
      subjectType: 'group',
      subjectId: 'team-payment',
      permissions: ['open', 'terminal', 'file:read']
    })
  })
  assert.equal(granted.status, 200, JSON.stringify(granted.body))
}

/** The relay node lives 30s per announcement, so the suite keeps re-announcing. */
async function announceBrowserEdge(): Promise<void> {
  const res = await fetch(`${service.url}/v1/internal/relay-endpoint`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
    body: JSON.stringify({
      id: 'relay-w7b',
      host: '127.0.0.1',
      port: 18011,
      browserHost: BROWSER_EDGE_HOST
    })
  })
  assert.equal(res.status, 200, JSON.stringify(await res.json()))
}

/** Issues a handoff and returns the raw URL the console would open. */
async function issueHandoff(token: string, projectId: string): Promise<string> {
  const res = await api(`/v1/projects/${projectId}/web-handoff`, { method: 'POST', token })
  assert.equal(res.status, 201, JSON.stringify(res.body))
  return (res.body as { url: string }).url
}

before(async () => {
  service = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN, ORCA_CLOUD_HOST_OFFLINE_MS: '1500' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-web-handoff-entry'
  )
  const login = async (username: string, password: string): Promise<string> => {
    const res = await fetch(`${service.url}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password, deviceName: 'w7b-entry' })
    })
    return ((await res.json()) as { accessToken: string }).accessToken
  }
  adminToken = await login('admin', 'Adm1n!')
  devToken = await login('zhangsan', 'Passw0rd!')

  // A relayed host keeps its direct address too: the relay edge must win.
  const relayedHost = await registerHost({
    name: 'w7b-relayed',
    directAddr: '127.0.0.1:17012',
    relayRoute: 'w7b-relayed'
  })
  relayedProjectId = await createProject('w7b-relayed', relayedHost.hostId)
  await grantOpen(relayedProjectId)
  beating.push(relayedHost)

  // A relay-only host is exactly the case W7a had to refuse: no direct address,
  // so the browser edge is its only web entry.
  const relayOnlyHost = await registerHost({ name: 'w7b-only', relayRoute: 'w7b-only' })
  relayOnlyProjectId = await createProject('w7b-only', relayOnlyHost.hostId)
  await grantOpen(relayOnlyProjectId)
  beating.push(relayOnlyHost)

  // A dotted route key is one the relay's /h/ parser refuses, so this host has
  // no browser edge even while one is healthy: the direct-fallback side.
  const directHost = await registerHost({
    name: 'w7b-direct',
    directAddr: '127.0.0.1:17013',
    relayRoute: 'w7b.direct'
  })
  directProjectId = await createProject('w7b-direct', directHost.hostId)
  await grantOpen(directProjectId)
  beating.push(directHost)

  await announceBrowserEdge()
  beat = setInterval(() => {
    void announceBrowserEdge().catch(() => undefined)
    for (const host of beating) {
      void fetch(`${service.url}/v1/hosts/${host.hostId}/heartbeat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${host.credential}` },
        body: JSON.stringify({ status: 'online' })
      }).catch(() => undefined)
    }
  }, 700)
}, { timeout: 120_000 })

after(async () => {
  if (beat) {
    clearInterval(beat)
  }
  await service?.stop()
  saveEvidence(EVIDENCE, 'entry-matrix.json', { feature: 'W7b handoff consumption', cases: matrix })
})

test('W7b-cors 白名单宿主页来源：预检 204 且放行 authorization/content-type', { timeout: 120_000 }, async () => {
  const preflight = await fetch(`${service.url}/v1/projects`, {
    method: 'OPTIONS',
    headers: {
      origin: HOST_ORIGIN,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization, content-type'
    }
  })
  assert.equal(preflight.status, 204, 'a listed page origin gets a real preflight answer')
  assert.equal(preflight.headers.get('access-control-allow-origin'), HOST_ORIGIN)
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS')
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'authorization, content-type')
  assert.ok(preflight.headers.get('access-control-max-age'))

  // The edge origin (relay browser mode) is listed too: it serves web-index.
  const edgePreflight = await fetch(`${service.url}/v1/web/handoff`, {
    method: 'OPTIONS',
    headers: { origin: EDGE_ORIGIN }
  })
  assert.equal(edgePreflight.headers.get('access-control-allow-origin'), EDGE_ORIGIN)

  // Actual cross-origin reads carry the origin back, including errors — the
  // fallback notice in the web page reads the 410/403 body.
  const listed = await api('/v1/projects', { token: devToken, origin: HOST_ORIGIN })
  assert.equal(listed.status, 200)
  assert.equal(listed.headers.get('access-control-allow-origin'), HOST_ORIGIN)
  assert.equal(listed.headers.get('vary'), 'Origin')
  const denied = await fetch(`${service.url}/v1/web/handoff`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: HOST_ORIGIN },
    body: JSON.stringify({ code: 'not-a-code' })
  })
  assert.equal(denied.status, 410)
  assert.equal(denied.headers.get('access-control-allow-origin'), HOST_ORIGIN)

  saveEvidence(EVIDENCE, 'cors-allowlisted-origin.json', {
    preflight: {
      status: preflight.status,
      allowOrigin: preflight.headers.get('access-control-allow-origin'),
      allowMethods: preflight.headers.get('access-control-allow-methods'),
      allowHeaders: preflight.headers.get('access-control-allow-headers'),
      maxAge: preflight.headers.get('access-control-max-age')
    },
    edgeOriginAllowed: EDGE_ORIGIN,
    getWithOrigin: listed.status,
    errorReplyStillAllowed: {
      status: denied.status,
      allowOrigin: denied.headers.get('access-control-allow-origin')
    }
  })
  matrix['cors-allow'] =
    `宿主页来源 ${HOST_ORIGIN} 与中继边缘 ${EDGE_ORIGIN} 预检 204 + ACAO 回显；410 错误响应同样携带 ACAO`
})

test('W7b-cors 非白名单来源无 CORS 头（负向）', { timeout: 120_000 }, async () => {
  const preflight = await fetch(`${service.url}/v1/projects`, {
    method: 'OPTIONS',
    headers: {
      origin: 'https://evil.example',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization, content-type'
    }
  })
  assert.equal(preflight.status, 204)
  assert.equal(
    preflight.headers.get('access-control-allow-origin'),
    null,
    'an unknown origin must not learn it may read replies'
  )
  assert.equal(preflight.headers.get('access-control-allow-methods'), null)

  const actual = await api('/v1/projects', { token: devToken, origin: 'https://evil.example' })
  assert.equal(actual.status, 200)
  assert.equal(actual.headers.get('access-control-allow-origin'), null)
  assert.equal(actual.headers.get('access-control-allow-headers'), null)

  // Internal routes have no browser caller: even a listed origin gets nothing.
  const internal = await fetch(`${service.url}/v1/internal/relay-endpoint`, {
    method: 'OPTIONS',
    headers: { origin: HOST_ORIGIN }
  })
  assert.equal(internal.headers.get('access-control-allow-origin'), null)

  // The same-origin console sends no Origin header and must be unaffected.
  const sameOrigin = await api('/v1/projects', { token: devToken })
  assert.equal(sameOrigin.status, 200)
  assert.equal(sameOrigin.headers.get('access-control-allow-origin'), null)

  saveEvidence(EVIDENCE, 'cors-negative.json', {
    unknownOrigin: { preflight: preflight.status, allowOrigin: null },
    unknownOriginActual: { status: actual.status, allowOrigin: null },
    internalRouteUnlisted: true,
    sameOriginUnaffected: sameOrigin.status
  })
  matrix['cors-deny'] =
    'evil.example 预检与实际响应零 CORS 头；/v1/internal/* 不参与；同源控制台不受影响'
})

test('W7b-url 入口 URL：中继边缘优先、直连兜底、恒带 ?api= 平台地址', { timeout: 120_000 }, async () => {
  const relayed = new URL(await issueHandoff(devToken, relayedProjectId))
  assert.equal(relayed.origin, EDGE_ORIGIN, 'a healthy browser edge wins over the direct address')
  assert.equal(relayed.pathname, '/h/w7b-relayed/web-index.html')
  assert.equal(relayed.searchParams.get('api'), service.url)
  assert.match(relayed.hash, /^#handoff=[A-Za-z0-9_-]+&project=/)

  const direct = new URL(await issueHandoff(devToken, directProjectId))
  assert.equal(`${direct.protocol}//${direct.host}`, 'https://127.0.0.1:17013')
  assert.equal(direct.pathname, '/web-index.html')
  assert.equal(direct.searchParams.get('api'), service.url)
  assert.match(direct.hash, /^#handoff=[A-Za-z0-9_-]+&project=/)

  // Relay-only host: the edge is its only entry, and it now issues (W7a n-2).
  const relayOnly = new URL(await issueHandoff(devToken, relayOnlyProjectId))
  assert.equal(relayOnly.pathname, '/h/w7b-only/web-index.html')
  assert.equal(relayOnly.searchParams.get('api'), service.url)

  saveEvidence(EVIDENCE, 'entry-url-composition.json', {
    relayed: relayed.toString(),
    direct: direct.toString(),
    relayOnly: relayOnly.toString(),
    apiParam: service.url
  })
  matrix['entry-url'] =
    '中继边缘优先 /h/<route>/web-index.html?api=…；无边缘回落直连；中继-only 宿主可签发'
})

test('W7b-button 「Orca Web」点击真实走 web-handoff 并用一次性 URL 开新标签', { timeout: 120_000 }, async () => {
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

  const button = orcaWebButton(page, 'w7b-relayed')
  assert.ok(button?.dataset.orcaWeb, 'the row carries the action button with the project id')
  assert.equal(button.disabled, false)
  button.click()
  await page.settle()

  assert.deepEqual(
    page.calls().filter((call) => call.includes('/web-handoff')),
    [`POST /v1/projects/${relayedProjectId}/web-handoff`]
  )
  assert.equal(opened.length, 1, 'the issued URL opens exactly one new tab')
  const openedUrl = new URL(opened[0])
  assert.equal(openedUrl.origin, EDGE_ORIGIN)
  assert.equal(openedUrl.searchParams.get('api'), service.url)
  assert.match(openedUrl.hash, /^#handoff=[A-Za-z0-9_-]+&project=/)

  saveEvidence(EVIDENCE, 'console-button-click.json', {
    call: `POST /v1/projects/${relayedProjectId}/web-handoff`,
    opened: opened[0].replace(/#handoff=[A-Za-z0-9_-]+/, '#handoff=<redacted>'),
    buttonProjectId: button.dataset.orcaWeb
  })
  matrix['button'] = '点击 → POST web-handoff → window.open(一次性 URL)，URL 与签发响应同源同形'
})

test('W7b-button 签发失败以 toast 提示（QA-009 形态）', { timeout: 120_000 }, async () => {
  const page = loadWebConsolePage(service.url)
  await page.settle()
  await page.submitLogin('zhangsan', 'Passw0rd!')
  await page.clickNav('workbench')
  page.fail('POST', `/v1/projects/${relayedProjectId}/web-handoff`, {
    status: 409,
    body: { error: { code: 'HOST_MAINTENANCE', message: '主机维护中，暂时无法打开项目。' } }
  })

  const button = orcaWebButton(page, 'w7b-relayed')
  assert.ok(button)
  button.click()
  await page.settle()

  const toast = page.window.document.querySelector('.toast')
  assert.ok(toast, 'a failed mint must explain itself in a toast')
  assert.match(toast.textContent ?? '', /打开失败/)
  assert.match(toast.textContent ?? '', /主机维护中/)
  saveEvidence(EVIDENCE, 'console-button-failure.json', { toast: toast.textContent?.trim() })
  matrix['button-failure'] = '签发失败 → toast「打开失败：<平台消息>」，不打开新标签'
})

/** The Orca Web action button on the named project's workbench row. */
function orcaWebButton(page: WebConsolePage, projectKey: string): HTMLButtonElement | null {
  const row = [...page.window.document.querySelectorAll<HTMLElement>('#content tbody tr')].find(
    (candidate) => candidate.textContent?.includes(projectKey)
  )
  if (!row) {
    throw new Error(`no workbench row for ${projectKey}`)
  }
  return (
    [...row.querySelectorAll<HTMLButtonElement>('button')].find(
      (candidate) => candidate.textContent?.trim() === 'Orca Web'
    ) ?? null
  )
}
