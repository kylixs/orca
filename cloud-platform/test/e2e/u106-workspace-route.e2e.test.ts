import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { login, spawnService, type Service } from './harness.ts'
import { loadWebConsolePage, type WebConsolePage } from './web-console-page.ts'

/**
 * U106 R4 (D4): 项目工作区覆盖层是 URL 状态 `#/workspace/<projectId>`。
 * 直链进入即挂覆盖层；刷新保留覆盖层但重新 mint handoff（Q2 审计噪声）；
 * 关闭回来源页（push）或 `#/projects`（深链）；未知/不可见 id 走 404 语义（T5）；
 * 覆盖层打开时换项目 → hash 更新、旧层释放。
 */

const PROJECT_ID = 'proj_payment'
const PROJECT_NAME = 'payment-service'
const HANDOFF_PATH = `/v1/projects/${PROJECT_ID}/web-handoff`

let service: Service
let adminToken = ''
let secondProjectId = ''

function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  return fetch(`${service.url}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${adminToken}`,
      ...init.headers
    }
  }).then(async (res) => {
    const body = (await res.json().catch(() => ({}))) as T
    if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${JSON.stringify(body)}`)
    return body
  })
}

before(async () => {
  service = await spawnService(
    'apps/api/src/server.ts',
    {
      PORT: '0',
      INTERNAL_TOKEN: 'u106-workspace-internal-token',
      ORCA_CLOUD_HOST_OFFLINE_MS: '600000'
    },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-u106-workspace'
  )
  adminToken = await login(service.url, 'admin', 'Adm1n!')
  const created = await api<{ id: string }>('/v1/projects', {
    method: 'POST',
    body: JSON.stringify({
      key: 'r4-second',
      name: 'r4-second',
      hostId: 'host_dev001',
      path: '/srv/work/r4-second'
    })
  })
  secondProjectId = created.id
  // zhangsan (team-payment) must see and open the second project too.
  await api(`/v1/projects/${secondProjectId}/grants`, {
    method: 'PUT',
    body: JSON.stringify({
      subjectType: 'group',
      subjectId: 'team-payment',
      permissions: ['open']
    })
  })
}, { timeout: 120_000 })

after(async () => {
  await service?.stop()
})

/** 直链 = 打开该 URL 后再登录（登录保留目标 hash，D7）。 */
async function openDeepLink(hash: string): Promise<WebConsolePage> {
  const page = loadWebConsolePage(service.url, { hash })
  await page.settle()
  await page.submitLogin('zhangsan', 'Passw0rd!')
  return page
}

async function openWorkbench(): Promise<WebConsolePage> {
  const page = loadWebConsolePage(service.url)
  await page.settle()
  await page.submitLogin('zhangsan', 'Passw0rd!')
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

function handoffsOf(page: WebConsolePage): string[] {
  return page.calls().filter((call) => call === `POST ${HANDOFF_PATH}`)
}

async function waitUntil(
  condition: () => boolean,
  message: string,
  timeoutMs = 5000
): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.fail(message)
}

test('R4 直链 #/workspace/<id> 直接挂覆盖层且只 mint 一次', async () => {
  const hash = `#/workspace/${PROJECT_ID}`
  const page = await openDeepLink(hash)

  const overlay = overlayOf(page)
  assert.match(
    overlay.querySelector('.workspace-title')?.textContent ?? '',
    new RegExp(PROJECT_NAME)
  )
  assert.equal(page.window.location.hash, hash, 'the workspace URL stays canonical')

  const url = new URL(iframeOf(page).src)
  assert.equal(url.pathname, '/cloud-admin.html', 'the admin surface serves the embed page')
  assert.equal(url.searchParams.get('embed'), '1')
  assert.equal(url.searchParams.get('project'), PROJECT_ID)
  assert.match(url.hash, new RegExp(`^#handoff=[A-Za-z0-9_-]+&project=${PROJECT_ID}$`))
  assert.deepEqual(handoffsOf(page), [`POST ${HANDOFF_PATH}`], 'a direct link mints exactly once')
})

test('R4 覆盖层刷新保持：同一 hash 重建页面再次挂载并重新 mint（Q2 审计噪声）', async () => {
  const hash = `#/workspace/${PROJECT_ID}`
  const first = await openDeepLink(hash)
  assert.ok(overlayOf(first))

  const reloaded = await openDeepLink(hash)
  const overlay = overlayOf(reloaded)
  assert.match(
    overlay.querySelector('.workspace-title')?.textContent ?? '',
    new RegExp(PROJECT_NAME),
    'the reload restores the same project overlay'
  )
  assert.equal(reloaded.window.location.hash, hash)
  assert.deepEqual(handoffsOf(reloaded), [`POST ${HANDOFF_PATH}`], 'the reload mints once itself')

  // Q2: a refresh re-mints instead of reusing the old iframe session.
  let events: { targetId?: string; result?: string }[] = []
  for (let round = 0; round < 40; round += 1) {
    const audit = await api<{ events: { targetId?: string; result?: string }[] }>(
      '/v1/audit/events?eventType=web_handoff&actor=zhangsan&limit=50'
    )
    events = audit.events.filter(
      (event) => event.targetId === PROJECT_ID && event.result === 'success'
    )
    if (events.length >= 2) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.ok(events.length >= 2, 'two page loads = two web_handoff audit events')
})

test('R4 深链关闭 → hash 回 #/projects 并渲染列表', async () => {
  const hash = `#/workspace/${PROJECT_ID}`
  const page = await openDeepLink(hash)
  overlayOf(page).querySelector<HTMLButtonElement>('[data-workspace-close]')?.click()
  await page.settle()

  assert.equal(page.window.document.querySelector('#workspaceOverlay'), null)
  assert.equal(page.window.location.hash, '#/projects', 'a direct deep link closes to the list')
  assert.match(page.text('#content'), /我的项目/)
})

test('R4 列表打开 push 工作区路由，关闭回来源页（浏览器后退）', async () => {
  const page = await openWorkbench()
  const row = [...page.window.document.querySelectorAll<HTMLElement>('#content tbody tr')].find(
    (candidate) => candidate.textContent?.includes(PROJECT_NAME)
  )
  assert.ok(row, 'the seeded project row must render')
  const open = [...row.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === '打开'
  )
  assert.ok(open)
  open.click()
  await page.settle()

  assert.equal(page.window.location.hash, `#/workspace/${PROJECT_ID}`, '打开 writes the route')
  overlayOf(page).querySelector<HTMLButtonElement>('[data-workspace-close]')?.click()
  await waitUntil(
    () => page.window.location.hash === '#/workbench',
    'closing a pushed overlay returns to its source entry'
  )
  await page.settle()
  assert.equal(page.window.document.querySelector('#workspaceOverlay'), null)
  assert.match(page.text('#content'), /最近项目/, 'the source workbench survives underneath')
})

test('R4 未知 / 不可见项目 id → 404 语义，URL 保留且不 mint', async () => {
  const hash = '#/workspace/proj_missing'
  const page = await openDeepLink(hash)

  assert.equal(page.window.location.hash, hash, 'the unknown id keeps its URL')
  assert.equal(page.window.document.querySelector('#workspaceOverlay'), null)
  assert.deepEqual(handoffsOf(page), [], 'an invisible project never mints a handoff')
  assert.match(page.text('#content'), /页面不存在/)
  assert.match(page.text('#content'), /不存在或当前账号不可见/, 'no existence leak (T5)')
})

test('R4 覆盖层打开时换项目 → hash 更新且旧层释放、新项目挂载', async () => {
  const page = await openDeepLink(`#/workspace/${PROJECT_ID}`)
  assert.ok(overlayOf(page))
  const before = page.calls().length

  page.window.location.hash = `#/workspace/${secondProjectId}`
  await waitUntil(
    () => page.window.location.hash === `#/workspace/${secondProjectId}`,
    'the hash follows the new project'
  )
  await page.settle()

  assert.equal(page.window.location.hash, `#/workspace/${secondProjectId}`)
  const overlay = overlayOf(page)
  assert.match(overlay.querySelector('.workspace-title')?.textContent ?? '', /r4-second/)
  assert.equal(
    page
      .calls()
      .slice(before)
      .filter((call) => call === `POST /v1/projects/${secondProjectId}/web-handoff`).length,
    1,
    'the new project mints exactly one handoff'
  )
})
