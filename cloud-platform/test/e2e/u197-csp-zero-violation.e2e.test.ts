import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createServer as createHttpsServer } from 'node:https'
import type { Server as HttpsServer } from 'node:https'
import { join } from 'node:path'
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Response
} from 'playwright'
import { STATIC_CSP_REPORT_ONLY } from '../../apps/api/src/static-delivery.ts'
import { ROOT, login, makeTlsCerts, spawnService, type Service } from './harness.ts'

/**
 * U197 T2/T3: the Report-Only CSP must produce zero violations for a real
 * browser walking the real console. Chromium itself judges both channels:
 * the `securitypolicyviolation` event and the `[Report Only] …` console report.
 * No happy-dom, no synthetic renderer.
 */

const HEADER = 'content-security-policy-report-only'
const READY = /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/
const WEB_SOURCE = join(ROOT, 'apps/web')
/** Any ` on<event>=` in HTML, including handlers inside template strings. */
const INLINE_HANDLER = /\son(?:click|change|submit|input|keydown|load|error)=/i
const USERNAME = 'admin'
const PASSWORD = 'Adm1n!'
const PROJECT_KEY = 'u197-csp-project'

type CspViolation = {
  violatedDirective: string
  effectiveDirective: string
  blockedURI: string
  sourceFile: string
  lineNumber: number
  sample: string
  disposition: string
}

declare global {
  interface Window {
    __cspViolations?: CspViolation[]
  }
}

const HOST_PAGES: Record<string, string> = {
  '/cloud-admin.html':
    '<!doctype html><html><head><meta charset="utf-8"><title>host cloud-admin</title></head><body data-page="cloud-admin">host cloud-admin</body></html>',
  '/web-index.html':
    '<!doctype html><html><head><meta charset="utf-8"><title>host web-index</title></head><body data-page="web-index">host web-index</body></html>',
  // Negative control: an inline script reports at parse time and an inline
  // handler reports when evaluated, proving the observer really sees both.
  '/csp-control.html':
    '<!doctype html><html><head><meta charset="utf-8"><title>csp control</title></head><body><button onclick="void 0">control</button><script>void 0</script></body></html>'
}

let api: Service
let browser: Browser
let adminToken = ''
let projectId = ''
let tls: HttpsServer
let tlsPort = 0
let certDir = ''
let hostBase = ''
/** Every path the host-served fake requested, in order. */
const hostRequests: string[] = []

type Observed = {
  context: BrowserContext
  page: Page
  consoleReports: string[]
  violations: () => Promise<CspViolation[]>
}

function startHost(): Promise<void> {
  const certs = makeTlsCerts()
  certDir = certs.dir
  tls = createHttpsServer(
    { key: readFileSync(certs.key), cert: readFileSync(certs.cert) },
    (req, res) => {
      const pathname = (req.url ?? '/').split('?')[0] ?? '/'
      hostRequests.push(pathname)
      const body = HOST_PAGES[pathname]
      if (body === undefined) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('not found')
        return
      }
      const headers: Record<string, string> = {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store'
      }
      if (pathname === '/csp-control.html') {
        headers[HEADER] = STATIC_CSP_REPORT_ONLY
      }
      res.writeHead(200, headers)
      res.end(body)
    }
  )
  return new Promise((resolve, reject) => {
    tls.once('error', reject)
    tls.listen(0, '127.0.0.1', () => {
      const address = tls.address()
      assert.ok(address !== null && typeof address === 'object', 'the fake host must bind a port')
      tlsPort = address.port
      hostBase = `https://127.0.0.1:${tlsPort}`
      resolve()
    })
  })
}

async function apiCall(
  path: string,
  init: { method?: string; body?: unknown; token?: string } = {}
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${api.url}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${init.token ?? adminToken}`
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body)
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

async function seedHostAndProject(): Promise<void> {
  const tokenRes = await apiCall('/v1/hosts/tokens', { method: 'POST' })
  assert.equal(tokenRes.status, 201, JSON.stringify(tokenRes.body))
  const hostToken = (tokenRes.body as { token: string }).token
  const directAddr = `127.0.0.1:${tlsPort}`
  const registered = await fetch(`${api.url}/v1/hosts/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${hostToken}` },
    body: JSON.stringify({
      name: 'dev-u197-csp',
      fingerprint: 'sha256:dev-u197-csp',
      e2eePublicKeyB64: 'test-e2ee-key',
      orcaVersion: '1.5.0',
      protocolVersion: 3,
      networkZone: 'intranet',
      directAddrs: [directAddr],
      relayTarget: directAddr,
      relayRoute: 'dev-u197-csp',
      runtimeCapabilities: ['pty', 'files']
    })
  })
  const registeredBody = await registered.text()
  assert.equal(registered.status, 201, registeredBody)
  const hostId = (JSON.parse(registeredBody) as { hostId: string }).hostId

  const created = await apiCall('/v1/projects', {
    method: 'POST',
    body: {
      key: PROJECT_KEY,
      name: PROJECT_KEY,
      hostId,
      path: `/srv/work/${PROJECT_KEY}`
    }
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  projectId = (created.body as { id: string }).id

  // Handoff issuance demands an explicit open grant even for an admin.
  const granted = await apiCall(`/v1/projects/${projectId}/grants`, {
    method: 'PUT',
    body: { subjectType: 'user', subjectId: 'admin', permissions: ['open'] }
  })
  assert.equal(granted.status, 200, JSON.stringify(granted.body))
}

function assertDocumentPolicy(response: Response | null): void {
  assert.ok(response, 'the console document must return a response')
  const policy = response.headers()[HEADER]
  assert.ok(policy, `the HTML document must carry ${HEADER}`)
  // Exact text: an appended `'unsafe-inline'` must turn this red.
  assert.equal(policy, STATIC_CSP_REPORT_ONLY, 'the document policy must match the shipped constant')
}

function installObserver(context: BrowserContext): Promise<void> {
  return context.addInitScript(() => {
    window.__cspViolations = []
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__cspViolations?.push({
        violatedDirective: event.violatedDirective,
        effectiveDirective: event.effectiveDirective,
        blockedURI: event.blockedURI,
        sourceFile: event.sourceFile,
        lineNumber: event.lineNumber,
        sample: event.sample,
        disposition: event.disposition
      })
    })
  })
}

/** Both Chromium wordings: the classic `[Report Only] Refused …` and the newer `report-only … logged`. */
function isCspConsoleReport(text: string): boolean {
  return /\[Report Only\]|Content Security Policy|report-only/i.test(text)
}

async function openConsole(): Promise<Observed> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  await installObserver(context)
  const page = await context.newPage()
  const consoleReports: string[] = []
  page.on('console', (message) => {
    if (isCspConsoleReport(message.text())) consoleReports.push(message.text())
  })
  const initial = await page.goto(`${api.url}/`, { waitUntil: 'domcontentloaded' })
  assertDocumentPolicy(initial)
  await page.waitForSelector('#view-login', { state: 'visible', timeout: 15_000 })
  return {
    context,
    page,
    consoleReports,
    violations: () => page.evaluate(() => window.__cspViolations ?? [])
  }
}

async function loginThroughUi(page: Page): Promise<void> {
  await page.fill('#username', USERNAME)
  await page.fill('#password', PASSWORD)
  await page.click('#loginBtn')
  await page.waitForSelector('#view-app', { state: 'visible', timeout: 20_000 })
  await page.waitForFunction(
    () => (document.querySelector('#userName')?.textContent ?? '—').trim() !== '—'
  )
}

async function openProjects(page: Page): Promise<void> {
  await page.click('#nav .nav-item[data-route="projects"]')
  await page.waitForFunction(
    () => document.querySelector('#content h1')?.textContent === '我的项目'
  )
  await page.waitForSelector('#refreshProjectsBtn', { state: 'visible' })
}

function summarize(violations: CspViolation[]): string[] {
  return violations.map(
    (violation) =>
      `${violation.effectiveDirective || violation.violatedDirective} blocked ${violation.blockedURI} ` +
      `at ${violation.sourceFile}:${violation.lineNumber} sample=${violation.sample}`
  )
}

async function assertClean(observed: Observed, label: string): Promise<void> {
  // Give the report pipeline a beat: both channels are asynchronous.
  await observed.page.waitForTimeout(250)
  const violations = await observed.violations()
  assert.deepEqual(summarize(violations), [], `${label}: zero CSP violations expected`)
  assert.deepEqual(observed.consoleReports, [], `${label}: no [Report Only] console reports`)
}

before(async () => {
  await startHost()
  api = await spawnService(
    'apps/api/src/server.ts',
    {
      PORT: '0',
      INTERNAL_TOKEN: 'u197-csp-zero-violation',
      ORCA_CLOUD_COOKIE_MODE: 'never',
      // Pin both knobs so a developer shell cannot move the fixture.
      ORCA_CLOUD_CSP_REPORT_ONLY: 'on',
      ORCA_CLOUD_HOST_OFFLINE_MS: '600000',
      ORCA_CLOUD_WEB_ROOT: WEB_SOURCE,
      ORCA_PLATFORM_STORE_FILE: '',
      ORCA_CLOUD_LDAP_REQUIRED_GROUP: '',
      ORCA_CLOUD_LOGIN_LOCKOUT_URL: '',
      ORCA_CLOUD_AUDIT_WRITER_URL: '',
      ORCA_CLOUD_AUDIT_WRITER_URLS: ''
    },
    READY,
    'api-u197-csp-zero-violation'
  )
  adminToken = await login(api.url, USERNAME, PASSWORD)
  await seedHostAndProject()
  browser = await chromium.launch({ headless: true })
}, { timeout: 180_000 })

after(async () => {
  await browser?.close()
  if (tls) {
    await new Promise<void>((resolve) => tls.close(() => resolve()))
  }
  await api?.stop()
  if (certDir !== '') rmSync(certDir, { recursive: true, force: true })
})

describe('U197 T2/T3 真实 Chromium：Report-Only CSP 全流程零违规', () => {
  test('① 登录页首屏 → 登录成功 → 应用壳渲染：零违规', async () => {
    const observed = await openConsole()
    try {
      await assertClean(observed, 'login screen')
      await loginThroughUi(observed.page)
      assert.equal(
        (await observed.page.locator('#content').textContent())?.trim() === '',
        false,
        'the app shell must render content'
      )
      await assertClean(observed, 'app shell')
    } finally {
      await observed.context.close()
    }
  })

  test('② 项目页刷新按钮：无内联处理器、绑定存在、零违规', async () => {
    const observed = await openConsole()
    try {
      await loginThroughUi(observed.page)
      await openProjects(observed.page)

      const refresh = observed.page.locator('#refreshProjectsBtn')
      assert.equal(await refresh.count(), 1, 'the projects page must render the refresh button')
      assert.equal(await refresh.getAttribute('onclick'), null, 'no inline onclick attribute')
      assert.equal(
        await refresh.evaluate((element) => typeof element.onclick),
        'function',
        'the refresh handler must be bound in app.js'
      )
      assert.deepEqual(
        await observed.page.evaluate(() =>
          [...document.querySelectorAll('*')].flatMap((element) =>
            [...element.attributes]
              .filter((attribute) => attribute.name.startsWith('on'))
              .map((attribute) => `${element.tagName.toLowerCase()}:${attribute.name}`)
          )
        ),
        [],
        'no element in the projects view may carry an inline handler'
      )
      await assertClean(observed, 'projects page')
    } finally {
      await observed.context.close()
    }
  })

  test('③ 工作区 iframe 加载跨源 cloud-admin.html：零违规', async () => {
    const observed = await openConsole()
    try {
      await loginThroughUi(observed.page)
      await openProjects(observed.page)

      const start = hostRequests.length
      const frameResponse = observed.page.waitForResponse(
        (response) => new URL(response.url()).pathname === '/cloud-admin.html',
        { timeout: 20_000 }
      )
      const row = observed.page
        .locator('#content tbody tr')
        .filter({ hasText: PROJECT_KEY })
      await row.locator('button[data-open]').click()
      const response = await frameResponse
      assert.equal(response.status(), 200, 'the host must serve the embed page')

      const entry = new URL(response.url())
      assert.equal(entry.origin, hostBase, 'the iframe must run on the cross-origin host')
      assert.equal(entry.pathname, '/cloud-admin.html')
      assert.equal(entry.searchParams.get('embed'), '1')
      assert.equal(entry.searchParams.get('project'), projectId)
      // The fragment never reaches the wire, so read the hash off the element.
      await observed.page.waitForSelector('#workspaceOverlay iframe', { timeout: 10_000 })
      const iframeSrc = await observed.page
        .locator('#workspaceOverlay iframe')
        .getAttribute('src')
      assert.ok(iframeSrc, 'the overlay iframe must carry its entry URL')
      assert.match(new URL(iframeSrc).hash, /^#handoff=[A-Za-z0-9_-]+&project=/)

      const body = observed.page.frameLocator('#workspaceOverlay iframe').locator('body')
      await body.waitFor({ timeout: 10_000 })
      assert.match((await body.textContent()) ?? '', /host cloud-admin/)
      assert.ok(
        hostRequests.slice(start).includes('/cloud-admin.html'),
        'the cross-origin host must serve the embed document'
      )

      await assertClean(observed, 'workspace iframe')
    } finally {
      await observed.context.close()
    }
  })

  test('④ Orca Web web-handoff 一跳：新标签加载宿主页，控制台零违规', async () => {
    const observed = await openConsole()
    try {
      await loginThroughUi(observed.page)
      await openProjects(observed.page)

      const start = hostRequests.length
      const popupPromise = observed.context.waitForEvent('page', { timeout: 20_000 })
      await observed.page
        .locator(`[data-orca-web="${projectId}"]`)
        .click()
      const popup = await popupPromise
      await popup.waitForLoadState('domcontentloaded')
      const finalUrl = new URL(popup.url())
      assert.equal(finalUrl.origin, hostBase, 'the handoff must land on the host origin')
      assert.equal(finalUrl.pathname, '/web-index.html')
      assert.match(finalUrl.hash, /^#handoff=[A-Za-z0-9_-]+&project=/)
      assert.ok(
        hostRequests.slice(start).includes('/web-index.html'),
        'the hop must reach the host web entry'
      )
      await popup.close()

      await assertClean(observed, 'web-handoff hop')
    } finally {
      await observed.context.close()
    }
  })

  test('检测器自证：Report-Only 内联处理器违规确实被两条通道捕获', async () => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true })
    try {
      await installObserver(context)
      const page = await context.newPage()
      const consoleReports: string[] = []
      page.on('console', (message) => {
        if (isCspConsoleReport(message.text())) consoleReports.push(message.text())
      })
      const control = await page.goto(`${hostBase}/csp-control.html`, {
        waitUntil: 'domcontentloaded'
      })
      assert.equal(
        control?.headers()[HEADER],
        STATIC_CSP_REPORT_ONLY,
        'the control page must exercise the shipped policy, byte for byte'
      )
      // Inline scripts report at parse; an inline handler reports when invoked.
      await page.click('button')
      await page.waitForFunction(
        () =>
          (window.__cspViolations ?? []).some(
            (violation) => violation.effectiveDirective === 'script-src-attr'
          ),
        null,
        { timeout: 10_000 }
      )
      const violations = await page.evaluate(() => window.__cspViolations ?? [])
      assert.ok(
        violations.some(
          (violation) => violation.effectiveDirective === 'script-src-attr'
        ),
        `expected an inline event-handler violation, got ${JSON.stringify(violations)}`
      )
      assert.ok(
        violations.some((violation) => violation.effectiveDirective === 'script-src-elem'),
        `expected an inline script violation, got ${JSON.stringify(violations)}`
      )
      assert.ok(
        consoleReports.length > 0,
        'Chromium must also report the violation on the console channel'
      )
    } finally {
      await context.close()
    }
  })

  test('内联处理器静态扫描：apps/web 全量源文件零命中', () => {
    const offenders: string[] = []
    for (const entry of readdirSync(WEB_SOURCE, { recursive: true })) {
      const filePath = join(WEB_SOURCE, entry)
      if (!statSync(filePath).isFile()) continue
      for (const [index, line] of readFileSync(filePath, 'utf8').split('\n').entries()) {
        if (INLINE_HANDLER.test(line)) offenders.push(`${entry}:${index + 1}: ${line.trim()}`)
      }
    }
    assert.deepEqual(offenders, [], 'apps/web must ship no inline event handler')
  })
})
