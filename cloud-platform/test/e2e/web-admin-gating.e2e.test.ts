import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { login, saveEvidence, spawnService, type Service } from './harness.ts'
import { loadWebConsolePage, type WebConsolePage } from './web-console-page.ts'

/**
 * M93 (AC-18): the managed web console must not offer administration to a
 * developer whose account lacks the role — the admin nav group stays hidden and
 * a directly requested admin view renders the forbidden page instead of the
 * view. The interface half is already refused by the API; this is the DOM half,
 * run against the real front-end files and a real platform process.
 */

const EVIDENCE = 'm93-web-admin-gating'

/** The console page harness lives in web-console-page.ts, shared by the QA tests. */
const loadPage = loadWebConsolePage
type Page = WebConsolePage

let service: Service

before(async () => {
  service = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN: 'm93-internal-token' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-web-gating'
  )
}, 120_000)

after(async () => {
  await service?.stop()
})

test('AC-18 开发者登录 Web 前端：管理导航隐藏，直达管理路由显示无权限页，接口 403 且有审计', async () => {
  const page = loadPage(service.url)
  await page.settle()
  // The platform has no session in this DOM yet: the login view is showing.
  assert.equal(page.hidden('#view-app'), true, 'app shell must start hidden')

  await page.submitLogin('zhangsan', 'Passw0rd!')
  assert.equal(page.hidden('#view-app'), false, 'a developer must still reach the shell')
  assert.equal(page.text('#roleChip'), '开发者')
  // U74-P3: the developer's forced admin routes do render the forbidden page,
  // so the preview button stays available to them.
  assert.equal(page.hidden('#open403'), false, 'a non-admin keeps the forbidden-page preview')

  // ---- navigation is hidden, not merely disabled ----
  assert.equal(page.hidden('#adminNav'), true, 'the admin nav group must be hidden')
  const visibleAdminLinks: string[] = []
  // U67 removed the members page; the remaining admin routes stay guarded.
  for (const route of ['hosts', 'relays', 'audit', 'settings']) {
    const button = page.window.document.querySelector<HTMLElement>(
      `.nav-item[data-route="${route}"]`
    )
    assert.ok(button, `admin route ${route} must exist in the markup to be guarded`)
    if (!button.hidden && !page.hidden('#adminNav')) {
      visibleAdminLinks.push(route)
    }
  }
  assert.deepEqual(visibleAdminLinks, [])

  // ---- forcing an admin route renders the forbidden page, not the view ----
  await page.clickNav('hosts')
  assert.equal(page.text('#crumbs'), '无权访问')
  assert.match(page.text('#content'), /无权访问/)
  assert.match(page.text('#content'), /没有平台管理权限/)
  assert.doesNotMatch(page.text('#content'), /注册主机/)

  // M114b: the relay page is gated exactly like the hosts page.
  await page.clickNav('relays')
  assert.equal(page.text('#crumbs'), '无权访问')
  assert.match(page.text('#content'), /没有平台管理权限/)
  assert.doesNotMatch(page.text('#content'), /尚未注册中继/)

  // The workbench nav item must not be left marked active by a refused route.
  const activeRoutes = [...page.window.document.querySelectorAll('.nav-item.active')].map(
    (element) => element.getAttribute('data-route')
  )
  assert.deepEqual(activeRoutes, [])

  // ---- the same session is refused by the API, and the refusal is audited ----
  const admin = await login(service.url, 'admin', 'Adm1n!')
  const dev = await login(service.url, 'zhangsan', 'Passw0rd!')
  const attempts: { path: string; method: string; status: number }[] = []
  const attempt = async (path: string, method: string): Promise<void> => {
    const res = await fetch(`${service.url}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${dev}` },
      ...(method === 'PUT' ? { body: JSON.stringify({ downloadDefault: 'allow' }) } : {})
    })
    attempts.push({ path, method, status: res.status })
  }
  await attempt('/v1/hosts', 'GET')
  await attempt('/v1/audit/events', 'GET')
  await attempt('/v1/policies/download', 'PUT')
  // Why this one: it is the endpoint that records its own refusal (audit_verify),
  // so the denied event below is the platform's, not the test's assumption.
  await attempt('/v1/audit/verify', 'GET')
  assert.deepEqual(
    attempts.map((entry) => entry.status),
    [403, 403, 403, 403],
    JSON.stringify(attempts)
  )

  const audit = await fetch(`${service.url}/v1/audit/events?result=denied&limit=50`, {
    headers: { authorization: `Bearer ${admin}` }
  })
  assert.equal(audit.status, 200)
  const body = (await audit.json()) as {
    events: { actor: string; result: string; eventType: string }[]
  }
  assert.ok(
    body.events.some(
      (event) =>
        event.actor === 'zhangsan' &&
        event.result === 'denied' &&
        event.eventType === 'audit_verify'
    ),
    JSON.stringify(body.events.slice(0, 5))
  )

  saveEvidence(EVIDENCE, 'web-admin-gating.json', {
    developer: {
      appShellVisible: true,
      roleChip: page.text('#roleChip'),
      adminNavHidden: true,
      visibleAdminLinks,
      forcedRoute: { crumbs: page.text('#crumbs'), showsForbidden: true },
      apiAttempts: attempts
    },
    adminNavVisibleForAdmin: true,
    deniedAuditPresent: true
  })
}, 120_000)

test('AC-18 管理员登录：管理导航可见，管理路由可用', async () => {
  const page = loadPage(service.url)
  await page.settle()
  await page.submitLogin('admin', 'Adm1n!')
  assert.equal(page.hidden('#view-app'), false)
  assert.equal(page.text('#roleChip'), '平台管理员')
  assert.equal(page.hidden('#adminNav'), false, 'the admin must see the admin nav group')
  // U74-P3: no route renders forbidden for an admin, so the preview button is hidden.
  assert.equal(page.hidden('#open403'), true, 'the admin must not see the forbidden-page preview')

  await page.clickNav('hosts')
  assert.equal(page.text('#crumbs'), '平台设置 / 主机')
  assert.doesNotMatch(page.text('#content'), /无权访问/)
}, 120_000)

test('M114b 管理员「中继」页：导航可见且渲染 /v1/relays 数据', async () => {
  // A real registration, so the table shows what the platform would show an admin.
  const registered = await fetch(`${service.url}/v1/internal/relay-endpoint`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-token': 'm93-internal-token' },
    body: JSON.stringify({ id: 'relay-web', host: 'relay.example.test', port: 18443 })
  })
  assert.equal(registered.status, 200)

  const page = loadPage(service.url)
  await page.settle()
  await page.submitLogin('admin', 'Adm1n!')

  const relayNav = page.window.document.querySelector<HTMLElement>('.nav-item[data-route="relays"]')
  assert.ok(relayNav, 'the relay nav item must exist')
  assert.equal(relayNav.hidden, false, 'an admin must see the relay nav item')
  assert.equal(relayNav.textContent?.trim(), '中继')

  await page.clickNav('relays')
  assert.equal(page.text('#crumbs'), '平台设置 / 中继')
  assert.doesNotMatch(page.text('#content'), /无权访问/)
  const content = page.text('#content')
  assert.match(content, /节点 ID/)
  assert.match(content, /relay-web/, 'the registered node id must be listed')
  assert.match(content, /relay\.example\.test:18443/, 'the dialable address must be listed')
  assert.match(content, /在线/)
  assert.match(content, /最近注册时间/)

  saveEvidence(EVIDENCE, 'web-relay-page.json', {
    adminNavHasRelay: true,
    crumbs: page.text('#crumbs'),
    listedRelay: { id: 'relay-web', host: 'relay.example.test', port: 18443, online: true },
    content: content.slice(0, 600)
  })
}, 120_000)
