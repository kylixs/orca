import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { login, saveEvidence, spawnService, type Service } from './harness.ts'
import { loadWebConsolePage, type WebConsolePage } from './web-console-page.ts'

/**
 * U46-3 (FR-3.11 R3): 「打开」 enters a same-page overlay instead of a new tab.
 *
 * W46-O1..O5 per the U46 design §6.2, driven through the real console files
 * against a real platform process:
 * - O1: exactly one admin-surface handoff, the overlay carries an iframe whose
 *   src is that host-served cloud-admin.html entry, zero window.open, zero /connect
 * - O2: a failed mint states the reason and keeps 「在新标签打开 Orca Web」,
 *   which re-mints without surface and opens exactly one new tab
 * - O3: an old platform answers web-index.html → fall back to a new tab + toast
 * - O4: ready/dirty/close message flow; 关闭 asks the iframe, 300ms fallback
 *   removes it, the underlying route and request count stay untouched
 * - O5: logout removes the overlay first and tells the iframe to drop its session
 *
 * The iframe document itself is not loaded in happy-dom; its src shape and the
 * postMessage protocol are what this suite can assert. U46-8 owns the real
 * browser journey.
 */

const EVIDENCE = 'u46-3-overlay'
const INTERNAL_TOKEN = 'u46-3-internal-token'
const PROJECT_ID = 'proj_payment'
const PROJECT_KEY = 'payment-service'
const DIRECT_ORIGIN = 'https://127.0.0.1:16768'
const HANDOFF_PATH = `/v1/projects/${PROJECT_ID}/web-handoff`

let service: Service
let adminToken = ''
const matrix: Record<string, unknown> = {}

async function api(
  path: string,
  init: RequestInit & { token?: string } = {}
  // oxlint-disable-next-line typescript/no-explicit-any -- same assert-driven shape as web-project-detail.e2e.test.ts
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

before(async () => {
  service = await spawnService(
    'apps/api/src/server.ts',
    // The seeded host must stay online for every mint in this file.
    { PORT: '0', INTERNAL_TOKEN, ORCA_CLOUD_HOST_OFFLINE_MS: '600000' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-u46-3-overlay'
  )
  adminToken = await login(service.url, 'admin', 'Adm1n!')
}, 120_000)

after(async () => {
  await service?.stop()
  saveEvidence(EVIDENCE, 'overlay-matrix.json', {
    feature: 'U46-3 「打开」同页覆盖层',
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

function entryIn(row: HTMLElement, label: string): HTMLButtonElement | null {
  return (
    [...row.querySelectorAll<HTMLButtonElement>('button')].find(
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

async function loginDevWorkbench(timerScale?: number): Promise<WebConsolePage> {
  const page = loadWebConsolePage(service.url, { timerScale })
  await page.settle()
  await page.submitLogin('zhangsan', 'Passw0rd!')
  await page.clickNav('workbench')
  return page
}

function overlayOf(page: WebConsolePage): HTMLElement {
  const overlay = page.window.document.querySelector<HTMLElement>('#workspaceOverlay')
  assert.ok(overlay, 'the workspace overlay must be mounted')
  return overlay
}

function iframeOf(page: WebConsolePage): HTMLIFrameElement {
  const iframe = overlayOf(page).querySelector<HTMLIFrameElement>('iframe')
  assert.ok(iframe, 'the overlay must carry the workspace iframe')
  return iframe
}

async function openProject(page: WebConsolePage): Promise<void> {
  const button = entryIn(rowFor(page, PROJECT_KEY), '打开')
  assert.ok(button, 'the seeded project row renders 打开')
  assert.equal(button.disabled, false, 'the seeded host is online and the dev holds open')
  button.click()
  await page.settle()
}

/** Delivers one iframe → parent message through the console's own listener. */
function postFromIframe(
  page: WebConsolePage,
  iframe: HTMLIFrameElement,
  data: Record<string, unknown>,
  origin = DIRECT_ORIGIN
): void {
  const event = new page.window.MessageEvent('message', {
    data,
    origin,
    source: iframe.contentWindow
  })
  page.window.dispatchEvent(event)
}

function redactHandoff(url: string): string {
  return url.replace(/#handoff=[A-Za-z0-9_-]+/, '#handoff=<redacted>')
}

test('W46-O1 点「打开」恰一次 admin handoff → 覆盖层 iframe 换页，零新标签零 /connect', async () => {
  const page = await loginDevWorkbench()
  const { opened } = captureOpened(page)
  const before = page.calls()

  await openProject(page)

  const since = page.calls().slice(before.length)
  assert.deepEqual(
    since.filter((call) => call.endsWith('/web-handoff')),
    [`POST ${HANDOFF_PATH}`],
    'exactly one handoff mint'
  )
  assert.equal(
    since.some((call) => call.endsWith('/connect')),
    false,
    'the console never talks to the desktop /connect'
  )
  assert.equal(opened.length, 0, 'the overlay replaces the placeholder new tab')

  const iframe = iframeOf(page)
  assert.equal(iframe.title, '项目工作区')
  const url = new URL(iframe.src)
  assert.equal(url.origin, DIRECT_ORIGIN, 'the host serves the workspace document')
  assert.equal(url.pathname, '/cloud-admin.html', 'the admin surface swaps the page')
  assert.equal(url.searchParams.get('api'), service.url)
  assert.equal(url.searchParams.get('embed'), '1', 'the embed entry is requested')
  assert.equal(url.searchParams.get('project'), PROJECT_ID)
  assert.match(url.hash, new RegExp(`^#handoff=[A-Za-z0-9_-]+&project=${PROJECT_ID}$`))

  // The body the console sent is the admin surface — the platform's audit knows.
  const audit = await api(`/v1/audit/events?eventType=web_handoff&actor=zhangsan&limit=50`)
  const event = (audit.body.events ?? []).find(
    (candidate: { targetId?: string }) => candidate.targetId === PROJECT_ID
  )
  assert.ok(event, 'the handoff lands in the audit trail')
  assert.equal(event.metadata.surface, 'admin')

  matrix.o1 = {
    calls: [`POST ${HANDOFF_PATH}`],
    src: redactHandoff(iframe.src),
    opened: opened.length,
    surface: event.metadata.surface
  }
}, 120_000)

test('W46-O2 签发失败 → 原因 + 在新标签打开 Orca Web → 无 surface 的第二次 POST + 恰一次新标签', async () => {
  const page = await loginDevWorkbench()
  const { opened } = captureOpened(page)
  page.fail('POST', HANDOFF_PATH)

  await openProject(page)

  const overlay = overlayOf(page)
  const alert = overlay.querySelector('[role="alert"]')
  assert.ok(alert, 'the failure state is announced')
  assert.match(alert.textContent ?? '', /工作区打开失败/)
  assert.match(alert.textContent ?? '', /模拟平台故障/, 'the platform reason is stated')

  const fallback = [...overlay.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === '在新标签打开 Orca Web'
  )
  assert.ok(fallback, 'the failure state keeps the Orca Web escape hatch')

  page.clearFails()
  const before = page.calls()
  fallback.click()
  await page.settle()

  assert.deepEqual(
    page.calls().slice(before.length),
    [`POST ${HANDOFF_PATH}`],
    'the fallback re-mints through the same endpoint'
  )
  assert.equal(opened.length, 1, 'the fallback opens exactly one new tab')
  const url = new URL(opened[0])
  assert.equal(url.pathname, '/web-index.html', 'the fallback asks for the web surface')
  assert.equal(url.searchParams.has('embed'), false)
  assert.equal(url.searchParams.has('project'), false)
  assert.equal(new URLSearchParams(url.hash.slice(1)).get('project'), PROJECT_ID)

  matrix.o2 = {
    failureShown: true,
    fallbackPath: url.pathname,
    opened: opened.length
  }
}, 120_000)

test('W46-O2b 失败态 shell 已登记：登出同样移除（F-08）', async () => {
  const page = await loginDevWorkbench()
  page.fail('POST', HANDOFF_PATH)
  await openProject(page)
  assert.ok(page.window.document.querySelector('[role="alert"]'), 'the failure shell is on screen')

  page.window.document.querySelector<HTMLButtonElement>('#logoutBtn')?.click()
  await page.settle()

  assert.equal(
    page.window.document.querySelector('#workspaceOverlay'),
    null,
    'logout releases the registered failure shell'
  )
  matrix.o2b = { failureShellRegistered: true, logoutRemoves: true }
}, 120_000)

test('W46-O3 旧平台回 web-index.html → 不挂覆盖层，回落新标签 + toast', async () => {
  const page = await loginDevWorkbench()
  const { opened } = captureOpened(page)
  const legacy = `${DIRECT_ORIGIN}/web-index.html?api=${encodeURIComponent(service.url)}#handoff=legacy&project=${PROJECT_ID}`
  page.fail('POST', HANDOFF_PATH, { status: 201, body: { url: legacy, expiresIn: 60 } })

  await openProject(page)

  assert.equal(
    page.window.document.querySelector('#workspaceOverlay'),
    null,
    'an old platform never gets the overlay'
  )
  assert.deepEqual(opened, [legacy], 'the issued entry opens as a new tab')
  assert.equal(
    page.window.document.querySelector('.toast')?.textContent,
    '当前平台版本不支持内嵌工作区，已在新标签打开',
    'the console explains the fallback'
  )

  matrix.o3 = { overlay: null, opened: opened.length, toast: true }
}, 120_000)

test('W46-O4 ready/dirty 消息流 + 关闭握手（close→closed→移除）与 300ms 兜底', async () => {
  const page = await loginDevWorkbench()
  const contentBefore = page.window.document.querySelector('#content')?.innerHTML ?? ''
  await openProject(page)
  const overlay = overlayOf(page)
  const iframe = iframeOf(page)
  const route = overlay.querySelector<HTMLElement>('[data-workspace-route]')
  const dirty = overlay.querySelector<HTMLElement>('[data-workspace-dirty]')
  assert.ok(route && dirty)
  assert.equal(route.hidden, true, 'no route badge before ready')

  // A message from another origin or window is ignored.
  postFromIframe(
    page,
    iframe,
    { source: 'orca-cloud-admin', type: 'ready', route: 'direct', latencyMs: 99 },
    'https://evil.example'
  )
  assert.equal(route.hidden, true, 'foreign origins never drive the overlay')

  postFromIframe(page, iframe, {
    source: 'orca-cloud-admin',
    type: 'ready',
    route: 'relay',
    latencyMs: 18
  })
  assert.equal(route.hidden, false, 'ready reveals the route badge')
  assert.equal(route.textContent, '中继 18ms')
  const status = overlay.querySelector<HTMLElement>('[data-workspace-status]')
  assert.equal(status?.hidden, true, 'ready dismisses the entering state')

  postFromIframe(page, iframe, { source: 'orca-cloud-admin', type: 'dirty', count: 2 })
  assert.equal(dirty.hidden, false)
  assert.equal(dirty.textContent, '2 个未保存文件')

  // dirty > 0 asks before dropping the document; a cancelled confirm keeps it.
  const prompts: string[] = []
  page.window.confirm = (text?: string) => (prompts.push(text ?? ''), false)
  const sent: unknown[] = []
  iframe.contentWindow!.postMessage = ((message: unknown) => {
    sent.push(message)
    return undefined
    // oxlint-disable-next-line typescript/no-explicit-any -- happy-dom's cross-origin window is structurally wider
  }) as any
  overlay.querySelector<HTMLButtonElement>('[data-workspace-close]')?.click()
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(page.window.document.querySelector('#workspaceOverlay'), overlay, 'cancel keeps it')
  assert.match(prompts[0] ?? '', /2 个文件未保存/)
  assert.deepEqual(sent, [], 'no close message while the user has second thoughts')

  // Confirm: the console asks the iframe to close, then removes on `closed`.
  page.window.confirm = () => true
  overlay.querySelector<HTMLButtonElement>('[data-workspace-close]')?.click()
  assert.deepEqual(sent, [{ type: 'close' }], 'the close request reaches the iframe')
  postFromIframe(page, iframe, { source: 'orca-cloud-admin', type: 'closed' })
  assert.equal(
    page.window.document.querySelector('#workspaceOverlay'),
    null,
    'the acknowledged close removes the overlay'
  )
  assert.equal(
    page.window.document.querySelector('#content')?.innerHTML,
    contentBefore,
    'the underlying route survives the overlay'
  )
  const callsAfterClose = page.calls().length

  // No reply: the 300ms fallback still releases the console.
  await openProject(page)
  overlayOf(page).querySelector<HTMLButtonElement>('[data-workspace-close]')?.click()
  await page.settle()
  assert.equal(
    page.window.document.querySelector('#workspaceOverlay'),
    null,
    'an unresponsive iframe is force-removed'
  )
  assert.equal(
    page.calls().length,
    callsAfterClose + 1,
    'closing mints nothing new; only the reopening handoff was added'
  )

  matrix.o4 = {
    route: route.textContent,
    dirty: dirty.textContent,
    closeHandshake: 'close→closed→removed',
    fallback: '300ms'
  }
}, 120_000)

async function waitUntil(cond: () => boolean, message: string, timeoutMs = 5000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (cond()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.fail(message)
}

test('W46-O6 ready 超时保留失败态：重试重签 handoff+重建 iframe，次数用尽引导独立页', async () => {
  // 0.05 × 20s = 1s per ready attempt; the real timeout path still runs.
  const page = await loginDevWorkbench(0.05)
  const { opened } = captureOpened(page)
  const handoffs = () => page.calls().filter((call) => call === `POST ${HANDOFF_PATH}`).length

  const hasIframe = () => page.window.document.querySelector('#workspaceOverlay iframe') !== null
  const hasFailure = () =>
    page.window.document.querySelector('[data-workspace-ready-failure]') !== null

  await openProject(page)
  await waitUntil(hasFailure, 'the ready timeout must keep a failure state')
  let overlay = overlayOf(page)
  const failureText = overlay.textContent ?? ''
  assert.match(failureText, /工作区加载超时/)
  assert.match(failureText, /20 秒内未收到就绪信号/)
  assert.equal(overlay.querySelector('iframe'), null, 'the timed-out frame is gone')
  assert.ok(
    [...overlay.querySelectorAll<HTMLButtonElement>('button')].some(
      (button) => button.textContent?.trim() === '重试'
    ),
    'the failure state offers 重试'
  )
  assert.ok(
    [...overlay.querySelectorAll<HTMLButtonElement>('button')].some(
      (button) => button.textContent?.trim() === '在新标签打开 Orca Web'
    ),
    'the failure state keeps the standalone entry'
  )
  assert.equal(handoffs(), 1)
  assert.equal(
    page.window.document.querySelector('.toast')?.textContent,
    undefined,
    'a timeout is a page state, not a transient toast'
  )

  // Retry #1: re-mint the admin handoff and rebuild the iframe.
  overlay.querySelector<HTMLButtonElement>('[data-workspace-retry]')?.click()
  await waitUntil(hasIframe, 'retry rebuilds iframe')
  assert.equal(handoffs(), 2, 'the retry re-mints the handoff')
  const retried = new URL(iframeOf(page).src)
  assert.equal(retried.pathname, '/cloud-admin.html')
  assert.equal(retried.searchParams.get('embed'), '1')
  await waitUntil(hasFailure, 'retry #1 times out again')

  // Retry #2: budget is spent; only the standalone entry remains.
  overlayOf(page).querySelector<HTMLButtonElement>('[data-workspace-retry]')?.click()
  await waitUntil(hasIframe, 'retry #2 rebuilds iframe')
  await waitUntil(hasFailure, 'retry #2 times out again')
  overlay = overlayOf(page)
  assert.equal(handoffs(), 3)
  assert.equal(
    overlay.querySelector('[data-workspace-retry]'),
    null,
    'the retry button is gone once the budget is spent'
  )
  assert.match(overlay.textContent ?? '', /已重试 2 次仍未就绪/)
  assert.match(overlay.textContent ?? '', /在新标签页打开 Orca Web/)

  // The standalone entry still mints a web-surface handoff in a new tab.
  const fallback = [...overlay.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === '在新标签打开 Orca Web'
  )
  assert.ok(fallback)
  fallback.click()
  await waitUntil(() => opened.length === 1, 'the standalone entry opens one tab')
  assert.equal(new URL(opened[0]).pathname, '/web-index.html')

  matrix.o6 = {
    failureStateRetained: true,
    retries: 2,
    handoffs: handoffs(),
    standalonePath: new URL(opened[0]).pathname
  }
}, 120_000)

test('W46-O5 登出先移除覆盖层并 postMessage(logout)', async () => {
  const page = await loginDevWorkbench()
  await openProject(page)
  const iframe = iframeOf(page)
  const sent: unknown[] = []
  iframe.contentWindow!.postMessage = ((message: unknown) => {
    sent.push(message)
    return undefined
    // oxlint-disable-next-line typescript/no-explicit-any -- happy-dom's cross-origin window is structurally wider
  }) as any

  page.window.document.querySelector<HTMLButtonElement>('#logoutBtn')?.click()
  await page.settle()

  assert.deepEqual(sent, [{ type: 'logout' }], 'the iframe is told to drop its session')
  assert.equal(
    page.window.document.querySelector('#workspaceOverlay'),
    null,
    'logout removes the overlay before the console signs out'
  )
  assert.equal(page.window.document.querySelector<HTMLElement>('#view-login')?.hidden, false)
  assert.equal(page.window.document.querySelector<HTMLElement>('#view-app')?.hidden, true)

  matrix.o5 = { logoutMessage: true, overlayRemoved: true, loginShown: true }
}, 120_000)

test('W46-O7 suspend/end：能力声明决定按钮与消息；close 为 suspend，suspended/ended 均移除', async () => {
  const page = await loginDevWorkbench()
  await openProject(page)
  const iframe = iframeOf(page)
  const sent: unknown[] = []
  iframe.contentWindow!.postMessage = ((message: unknown) => {
    sent.push(message)
    return undefined
    // oxlint-disable-next-line typescript/no-explicit-any -- happy-dom's cross-origin window is structurally wider
  }) as any

  // §4.2: without the capability the console hides the explicit end action.
  const endButton = () => overlayOf(page).querySelector<HTMLButtonElement>('[data-workspace-end]')
  assert.equal(endButton()?.hidden, true, 'end stays hidden before ready')
  postFromIframe(page, iframe, {
    source: 'orca-cloud-admin',
    type: 'ready',
    route: 'direct',
    latencyMs: 12,
    features: ['suspend', 'end']
  })
  assert.equal(endButton()?.hidden, false, 'ready advertises end')

  // 关闭 = suspend: no closeProject on the console; the iframe acknowledges.
  overlayOf(page).querySelector<HTMLButtonElement>('[data-workspace-close]')?.click()
  assert.deepEqual(sent, [{ type: 'suspend' }], 'close suspends instead of ending')
  postFromIframe(page, iframe, { source: 'orca-cloud-admin', type: 'suspended' })
  assert.equal(
    page.window.document.querySelector('#workspaceOverlay'),
    null,
    'suspended removes the overlay'
  )

  // Reopen: the explicit end asks first, then waits for `ended`.
  await openProject(page)
  const reopened = iframeOf(page)
  const endSent: unknown[] = []
  reopened.contentWindow!.postMessage = ((message: unknown) => {
    endSent.push(message)
    return undefined
    // oxlint-disable-next-line typescript/no-explicit-any -- happy-dom's cross-origin window is structurally wider
  }) as any
  postFromIframe(page, reopened, {
    source: 'orca-cloud-admin',
    type: 'ready',
    route: 'direct',
    latencyMs: 8,
    features: ['suspend', 'end']
  })
  page.window.confirm = () => true
  overlayOf(page).querySelector<HTMLButtonElement>('[data-workspace-end]')?.click()
  assert.deepEqual(endSent, [{ type: 'end' }], 'end is an explicit action')
  postFromIframe(page, reopened, { source: 'orca-cloud-admin', type: 'ended' })
  assert.equal(
    page.window.document.querySelector('#workspaceOverlay'),
    null,
    'ended removes the overlay'
  )

  matrix.o7 = { endGatedByFeature: true, close: 'suspend', end: 'explicit' }
}, 120_000)
