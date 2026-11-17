import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createNetServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Request
} from 'playwright'
import { ROOT, spawnService, type Service } from './harness.ts'

/**
 * U197 S5 (Web client side): the real console at apps/web runs in real
 * Chromium against the real API process. The Cookie transport, the capability
 * marker, the migration branch and the localStorage (never-mode) contract are
 * all judged by the browser itself — no happy-dom, no mocked cookie jar.
 */

const HOST = '127.0.0.1'
const READY = /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/
const WEB_SOURCE = join(ROOT, 'apps/web')
const USERNAME = 'admin'
const PASSWORD = 'Adm1n!'
const VIEW_APP = '#view-app'
const VIEW_LOGIN = '#view-login'

type StoredAuth = {
  access: string | null
  refresh: string | null
  mode: string | null
}

/** Requests and statuses the page emitted, in call order. */
type RefreshTrace = {
  bodies: (string | null)[]
  statuses: number[]
}

let browser: Browser
let workDir = ''
let cookieMode: Service
let legacyMode: Service
let shortAccess: Service

async function reservePort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, HOST, () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('expected a TCP address')
  }
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

function startApi(
  key: string,
  mode: string,
  publicOrigin: string,
  port: number,
  extraEnv: Record<string, string> = {}
): Promise<Service> {
  return spawnService(
    'apps/api/src/server.ts',
    {
      PORT: String(port),
      INTERNAL_TOKEN: `u197-web-cookie-${key}`,
      ORCA_CLOUD_COOKIE_MODE: mode,
      // Empty string pins the value even if the developer shell exports one.
      ORCA_CLOUD_PUBLIC_ORIGIN: publicOrigin,
      ORCA_CLOUD_WEB_ROOT: WEB_SOURCE,
      AUDIT_LOG_PATH: join(workDir, `audit-${key}.log`),
      ORCA_PLATFORM_STORE_FILE: '',
      ORCA_CLOUD_LDAP_REQUIRED_GROUP: '',
      ORCA_CLOUD_LOGIN_LOCKOUT_URL: '',
      ORCA_CLOUD_AUDIT_WRITER_URL: '',
      ORCA_CLOUD_AUDIT_WRITER_URLS: '',
      ...extraEnv
    },
    READY,
    `api-u197-web-${key}`
  )
}

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'u197-web-cookie-browser-'))
  // Sequential: a reserved port is only safe until the next listener takes it.
  const cookiePort = await reservePort()
  const legacyPort = await reservePort()
  const shortPort = await reservePort()
  cookieMode = await startApi('cookie', 'always', `http://${HOST}:${cookiePort}`, cookiePort)
  // never + no PUBLIC_ORIGIN is the pre-U197 deployment contract.
  legacyMode = await startApi('legacy', 'never', '', legacyPort)
  // A short access TTL makes a page-internal 401 observable without a reload.
  shortAccess = await startApi(
    'short',
    'always',
    `http://${HOST}:${shortPort}`,
    shortPort,
    { ORCA_CLOUD_ACCESS_TTL_MS: '1500' }
  )
  browser = await chromium.launch({ headless: true })
}, 180_000)

after(async () => {
  await browser?.close()
  await Promise.all([cookieMode?.stop(), legacyMode?.stop(), shortAccess?.stop()])
  if (workDir !== '') {
    rmSync(workDir, { recursive: true, force: true })
  }
})

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRefreshRequest(request: Request): boolean {
  return (
    request.method() === 'POST' && new URL(request.url()).pathname === '/v1/auth/refresh'
  )
}

function traceRefresh(page: Page): RefreshTrace {
  const trace: RefreshTrace = { bodies: [], statuses: [] }
  page.on('request', (request) => {
    if (isRefreshRequest(request)) {
      trace.bodies.push(request.postData())
    }
  })
  page.on('response', (response) => {
    if (isRefreshRequest(response.request())) {
      trace.statuses.push(response.status())
    }
  })
  return trace
}

function readStoredAuth(page: Page): Promise<StoredAuth> {
  return page.evaluate(() => ({
    access: window.localStorage.getItem('orca.access'),
    refresh: window.localStorage.getItem('orca.refresh'),
    mode: window.localStorage.getItem('orca.authMode')
  }))
}

async function refreshCookieOf(context: BrowserContext) {
  // Secure cookies do not match an http URL for cookies(url), so read the jar.
  const cookies = await context.cookies()
  return cookies.find((cookie) => cookie.name === 'orca_refresh' && cookie.path === '/v1/auth')
}

async function openConsole(base: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector(VIEW_LOGIN, { state: 'visible', timeout: 15_000 })
  return { context, page }
}

async function loginThroughUi(page: Page): Promise<void> {
  await page.fill('#username', USERNAME)
  await page.fill('#password', PASSWORD)
  await page.click('#loginBtn')
  await page.waitForSelector(VIEW_APP, { state: 'visible', timeout: 20_000 })
}

async function isVisible(page: Page, selector: string): Promise<boolean> {
  return page.locator(selector).isVisible()
}

describe('U197 S5 Web 客户端真实 Chromium：Cookie 会话 / 迁移 / 回退', () => {
  test('AC9a 标记真 + 旧键 + 有效 Cookie：一次无 body 刷新后删旧键并进入应用', async () => {
    const { context, page } = await openConsole(cookieMode.url)
    try {
      await loginThroughUi(page)
      assert.ok(await refreshCookieOf(context), 'real login must set the HttpOnly cookie')

      // Simulate a browser left behind by an older build: legacy keys still
      // exist while the capability marker is already true.
      await page.evaluate(() => {
        window.localStorage.setItem('orca.access', 'legacy-access-u197')
        window.localStorage.setItem('orca.refresh', 'legacy-refresh-u197')
        window.localStorage.setItem('orca.authMode', 'cookie')
      })

      const trace = traceRefresh(page)
      const meResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/v1/me' && response.status() === 200,
        { timeout: 20_000 }
      )
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForSelector(VIEW_APP, { state: 'visible', timeout: 20_000 })
      assert.equal((await meResponse).status(), 200, '/v1/me must prove the session')
      await delay(150)

      assert.equal(trace.bodies.length, 1, 'exactly one refresh on load')
      assert.equal(trace.bodies[0], null, 'the recovery refresh must carry no body')
      assert.deepEqual(trace.statuses, [200])

      const stored = await readStoredAuth(page)
      assert.equal(stored.access, null, 'legacy access must be deleted after the refresh')
      assert.equal(stored.refresh, null, 'legacy refresh must be deleted after the refresh')
      assert.equal(stored.mode, 'cookie')

      const userName = await page.locator('#userName').textContent()
      assert.ok(userName !== null && userName.trim() !== '' && userName.trim() !== '—')
      assert.equal(await isVisible(page, VIEW_LOGIN), false)
    } finally {
      await context.close()
    }
  })

  test('document.cookie 不含 orca_refresh，localStorage 无令牌（Cookie 模式登录后）', async () => {
    const { context, page } = await openConsole(cookieMode.url)
    try {
      await loginThroughUi(page)

      const observed = await page.evaluate(() => ({
        cookie: document.cookie,
        access: window.localStorage.getItem('orca.access'),
        refresh: window.localStorage.getItem('orca.refresh'),
        mode: window.localStorage.getItem('orca.authMode')
      }))
      assert.equal(observed.cookie.includes('orca_refresh'), false, 'HttpOnly cookie is invisible')
      assert.equal(observed.access, null, 'access stays in memory only')
      assert.equal(observed.refresh, null, 'no body refresh token is persisted')
      assert.equal(observed.mode, 'cookie')

      const jarCookie = await refreshCookieOf(context)
      assert.ok(jarCookie, 'the credential must still exist in the browser jar')
      assert.equal(jarCookie.httpOnly, true)
    } finally {
      await context.close()
    }
  })

  test('AC12 页面重载：一次 Cookie 刷新直接进入应用，登录表单保持隐藏', async () => {
    const { context, page } = await openConsole(cookieMode.url)
    try {
      await loginThroughUi(page)
      const before = await refreshCookieOf(context)
      assert.ok(before)
      const stored = await readStoredAuth(page)
      assert.equal(stored.mode, 'cookie')
      assert.equal(stored.access, null)

      const trace = traceRefresh(page)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForSelector(VIEW_APP, { state: 'visible', timeout: 20_000 })
      await delay(150)

      assert.equal(trace.bodies.length, 1, 'one Cookie refresh restores the session')
      assert.equal(trace.bodies[0], null)
      assert.deepEqual(trace.statuses, [200])
      assert.equal(await isVisible(page, VIEW_LOGIN), false, 'no login form on restore')
      assert.equal((await readStoredAuth(page)).mode, 'cookie')

      const after = await refreshCookieOf(context)
      assert.ok(after)
      assert.equal(after.value, before.value, 'a sliding resend keeps the same value')
    } finally {
      await context.close()
    }
  })

  test('多标签：同 context 两页同时重载，各自一次刷新、都进入应用、Cookie 值不变', async () => {
    const { context, page } = await openConsole(cookieMode.url)
    try {
      await loginThroughUi(page)
      const before = await refreshCookieOf(context)
      assert.ok(before)

      const second = await context.newPage()
      await second.goto(`${cookieMode.url}/`, { waitUntil: 'domcontentloaded' })
      await second.waitForSelector(VIEW_APP, { state: 'visible', timeout: 20_000 })

      const firstTrace = traceRefresh(page)
      const secondTrace = traceRefresh(second)
      await Promise.all([
        page.reload({ waitUntil: 'domcontentloaded' }),
        second.reload({ waitUntil: 'domcontentloaded' })
      ])
      await Promise.all([
        page.waitForSelector(VIEW_APP, { state: 'visible', timeout: 20_000 }),
        second.waitForSelector(VIEW_APP, { state: 'visible', timeout: 20_000 })
      ])
      await delay(200)

      for (const trace of [firstTrace, secondTrace]) {
        assert.equal(trace.bodies.length, 1, 'each tab refreshes once')
        assert.equal(trace.bodies[0], null)
        assert.deepEqual(trace.statuses, [200], 'concurrent tabs must not revoke the session')
      }
      assert.equal(await isVisible(page, VIEW_LOGIN), false)
      assert.equal(await isVisible(second, VIEW_LOGIN), false)

      const after = await refreshCookieOf(context)
      assert.ok(after, 'the shared cookie must survive concurrent reloads')
      assert.equal(after.value, before.value)
    } finally {
      await context.close()
    }
  })

  test('Cookie 缺失：恰好一次失败刷新后回登录，无循环、不重建旧键', async () => {
    const { context, page } = await openConsole(cookieMode.url)
    try {
      await loginThroughUi(page)
      // The migration already finished in this context: no legacy key remains.
      assert.equal((await readStoredAuth(page)).refresh, null)

      await context.clearCookies()
      assert.equal(await refreshCookieOf(context), undefined)

      const trace = traceRefresh(page)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForSelector(VIEW_LOGIN, { state: 'visible', timeout: 20_000 })
      // Any loop would land another request during this window.
      await delay(800)

      assert.equal(trace.bodies.length, 1, 'exactly one failed refresh')
      assert.equal(trace.bodies[0], null, 'no body fallback without a legacy key')
      assert.deepEqual(trace.statuses, [401])
      assert.equal(await isVisible(page, VIEW_APP), false)
      assert.equal(await isVisible(page, VIEW_LOGIN), true)

      const stored = await readStoredAuth(page)
      assert.equal(stored.access, null)
      assert.equal(stored.refresh, null)
      assert.equal(stored.mode, 'cookie', 'the capability marker is not a credential')
    } finally {
      await context.close()
    }
  })

  test('never / 无 PUBLIC_ORIGIN：登录仍写 localStorage，无 Cookie、无标记', async () => {
    const { context, page } = await openConsole(legacyMode.url)
    try {
      await loginThroughUi(page)

      const stored = await readStoredAuth(page)
      assert.ok(stored.access, 'legacy access must be persisted')
      assert.ok(stored.refresh, 'legacy refresh must be persisted')
      assert.equal(stored.mode, null, 'never mode must not set the capability marker')
      assert.equal(await refreshCookieOf(context), undefined)

      // The old contract reloads from localStorage without any refresh call.
      const trace = traceRefresh(page)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForSelector(VIEW_APP, { state: 'visible', timeout: 20_000 })
      await delay(150)
      assert.equal(trace.bodies.length, 0, 'a valid access token needs no refresh')
      assert.equal(await isVisible(page, VIEW_LOGIN), false)
    } finally {
      await context.close()
    }
  })

  test('AC14 页内业务请求 401 → 恰一次 Cookie 刷新并重放成功', async () => {
    const { context, page } = await openConsole(shortAccess.url)
    try {
      await loginThroughUi(page)
      const trace = traceRefresh(page)
      await delay(1900)

      const replayed = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/v1/relays' && response.status() === 200,
        { timeout: 20_000 }
      )
      await page.locator('.nav-item[data-route="relays"]').click()
      await replayed
      await page.waitForFunction(() =>
        (document.querySelector('#content')?.textContent ?? '').includes('中继')
      )
      await delay(150)

      assert.equal(trace.bodies.length, 1, 'one Cookie refresh for the in-page 401')
      assert.equal(trace.bodies[0], null, 'no body token in Cookie mode')
      assert.deepEqual(trace.statuses, [200])
      assert.equal(await isVisible(page, VIEW_APP), true)
      assert.equal(await isVisible(page, VIEW_LOGIN), false, 'the user stays signed in')
    } finally {
      await context.close()
    }
  })

  test('Cookie 模式并发 401 只刷新一次（同页两请求）', async () => {
    const { context, page } = await openConsole(shortAccess.url)
    try {
      await loginThroughUi(page)
      const trace = traceRefresh(page)
      await delay(1900)

      const projects = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/v1/projects' && response.status() === 200,
        { timeout: 20_000 }
      )
      const policy = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/v1/policies/download' &&
          response.status() === 200,
        { timeout: 20_000 }
      )
      await page.locator('.nav-item[data-route="projects"]').click()
      await Promise.all([projects, policy])
      await page.waitForFunction(() =>
        (document.querySelector('#content')?.textContent ?? '').includes('我的项目')
      )
      await delay(150)

      assert.equal(trace.bodies.length, 1, 'simultaneous 401s must share one refresh')
      assert.equal(trace.bodies[0], null)
      assert.deepEqual(trace.statuses, [200])
      assert.equal(await isVisible(page, VIEW_APP), true)
      assert.equal(await isVisible(page, VIEW_LOGIN), false)
    } finally {
      await context.close()
    }
  })

  test('真实登出：清 Cookie、旧键与标记并回登录页', async () => {
    const { context, page } = await openConsole(cookieMode.url)
    try {
      await loginThroughUi(page)
      assert.ok(await refreshCookieOf(context))
      // Simulate a browser left behind by an older build: legacy keys still exist.
      await page.evaluate((username) => {
        window.localStorage.setItem('orca.access', 'legacy-access')
        window.localStorage.setItem('orca.refresh', 'legacy-refresh')
        window.localStorage.setItem('orca.tokenOwner', username)
      }, USERNAME)

      const responded = page.waitForResponse(
        (response) => new URL(response.url()).pathname === '/v1/auth/logout',
        { timeout: 20_000 }
      )
      await page.locator('#logoutBtn').click()
      assert.equal((await responded).status(), 200)
      await page.waitForSelector(VIEW_LOGIN, { state: 'visible', timeout: 15_000 })
      await delay(250)

      const stored = await page.evaluate(() => ({
        access: window.localStorage.getItem('orca.access'),
        refresh: window.localStorage.getItem('orca.refresh'),
        mode: window.localStorage.getItem('orca.authMode'),
        owner: window.localStorage.getItem('orca.tokenOwner'),
        pending: window.localStorage.getItem('orca.pendingLogout')
      }))
      assert.equal(stored.access, null)
      assert.equal(stored.refresh, null)
      assert.equal(stored.mode, null)
      assert.equal(stored.owner, null)
      assert.equal(stored.pending, null, 'a reached logout leaves no pending marker')
      assert.equal(await refreshCookieOf(context), undefined, 'the Cookie is cleared')
      assert.equal(await isVisible(page, VIEW_APP), false)
      assert.equal(await isVisible(page, VIEW_LOGIN), true)
    } finally {
      await context.close()
    }
  })

  test('伪造 orca.authMode=cookie 且无 Cookie：一次失败刷新后回登录，无循环', async () => {
    const context = await browser.newContext()
    const page = await context.newPage()
    try {
      await page.goto(`${cookieMode.url}/`, { waitUntil: 'domcontentloaded' })
      await page.waitForSelector(VIEW_LOGIN, { state: 'visible', timeout: 15_000 })
      await page.evaluate(() => window.localStorage.setItem('orca.authMode', 'cookie'))

      const trace = traceRefresh(page)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForSelector(VIEW_LOGIN, { state: 'visible', timeout: 15_000 })
      await delay(800)

      assert.equal(trace.bodies.length, 1, 'exactly one failed probe')
      assert.equal(trace.bodies[0], null, 'no legacy key means no body fallback')
      assert.deepEqual(trace.statuses, [401])
      assert.equal(await isVisible(page, VIEW_APP), false)
      assert.equal(await isVisible(page, VIEW_LOGIN), true)
    } finally {
      await context.close()
    }
  })

  test('刷新传输失败 → 登录页，不空白且无未捕获异常', async () => {
    const { context, page } = await openConsole(cookieMode.url)
    try {
      await loginThroughUi(page)
      const pageErrors: string[] = []
      page.on('pageerror', (error) => pageErrors.push(String(error)))
      await page.route('**/v1/auth/refresh', (route) => route.abort())
      await page.reload({ waitUntil: 'domcontentloaded' })

      await page.waitForSelector(VIEW_LOGIN, { state: 'visible', timeout: 15_000 })
      await delay(300)
      assert.equal(await isVisible(page, VIEW_APP), false)
      assert.equal(await isVisible(page, VIEW_LOGIN), true, 'never a blank page')
      assert.deepEqual(pageErrors, [], 'the failed probe must not escape as a page error')
    } finally {
      await context.close()
    }
  })

  test(
    'AC9c 清空 localStorage 后仅凭 Cookie 恢复',
    { skip: 'blocked by D17/U219: the unproven-capability Cookie probe is undecided' },
    async () => {
      // Deliberately empty: AC9c depends on the D17 decision, so no passing
      // assertion may be written here yet.
    }
  )
})
