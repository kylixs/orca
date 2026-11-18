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
  type Cookie,
  type Page,
  type Request
} from 'playwright'
import { ROOT, spawnService, type Service } from './harness.ts'

/**
 * U197 S5 (Web client side): the real console at apps/web runs in real
 * Chromium against the real API process. This suite covers the migration and
 * probe outcomes plus the U231/U232 late-response races observed by the
 * browser itself — no happy-dom, no mocked cookie jar.
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
  workDir = mkdtempSync(join(tmpdir(), 'u197-web-cookie-browser-race-'))
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

/**
 * U232: `route.fetch()` has already sent the request, and Playwright applies its
 * Set-Cookie to the shared jar immediately. Tests that model a *late* arrival
 * must undo that early application or they cannot observe the race at all.
 */
async function restoreCookie(context: BrowserContext, cookie: Cookie): Promise<void> {
  await context.clearCookies()
  await context.addCookies([
    {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain === '' ? HOST : cookie.domain,
      path: cookie.path,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: cookie.sameSite
    }
  ])
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

describe('U197 S5 Web 客户端真实 Chromium：迁移 / 探测与 U231/U232 竞态', () => {
  test('U232 F3 慢 logout 晚于新登录：真响应被丢弃，新 Cookie 保留且业务 200', async () => {
    const { context, page } = await openConsole(shortAccess.url)
    try {
      await loginThroughUi(page)
      const cookieBeforeLogout = await refreshCookieOf(context)
      assert.ok(cookieBeforeLogout, 'login must set an HttpOnly Cookie')

      let releaseLogout = (): void => {}
      const logoutGate = new Promise<void>((resolve) => {
        releaseLogout = resolve
      })
      let logoutHeld = (): void => {}
      const held = new Promise<void>((resolve) => {
        logoutHeld = resolve
      })
      let logoutSettled = (): void => {}
      const settled = new Promise<void>((resolve) => {
        logoutSettled = resolve
      })
      let exchange: { status: number; setCookie: string } | null = null
      const logoutRequests: string[] = []

      page.on('request', (request) => {
        if (new URL(request.url()).pathname === '/v1/auth/logout') {
          logoutRequests.push(request.method())
        }
      })
      await page.route('**/v1/auth/logout', async (route) => {
        // Real server response: its 200 is the proof the platform saw the logout,
        // and its Set-Cookie is the clearing header a late arrival would apply.
        const response = await route.fetch()
        exchange = {
          status: response.status(),
          setCookie: response.headers()['set-cookie'] ?? ''
        }
        // `route.fetch()` applied that Set-Cookie early; undo it so this test
        // observes the late delivery the UI is racing against.
        await restoreCookie(context, cookieBeforeLogout)
        logoutHeld()
        await logoutGate
        await route.fulfill({ response }).catch(() => {})
        logoutSettled()
      })

      await page.locator('#logoutBtn').click()
      await held
      await page.waitForSelector(VIEW_LOGIN, { state: 'visible', timeout: 15_000 })
      const observed = exchange as { status: number; setCookie: string } | null
      assert.equal(logoutRequests[0], 'POST', 'the network event reached the logout path')
      assert.equal(observed?.status, 200, 'the server actually received the logout')
      assert.match(
        observed?.setCookie ?? '',
        /orca_refresh=[^;]*;.*Max-Age=0/is,
        'the delayed real response carries the clearing Cookie header'
      )

      // The held logout has not been delivered yet; a fresh login must win the race.
      await loginThroughUi(page)
      const newCookie = await refreshCookieOf(context)
      assert.ok(newCookie, 'the new login must set a Cookie')
      assert.notEqual(newCookie.value, cookieBeforeLogout.value, 'a new session, not a resend')

      releaseLogout()
      await settled
      await delay(300)

      const afterLate = await refreshCookieOf(context)
      assert.ok(afterLate, 'the late logout response must not clear the new Cookie')
      assert.equal(afterLate.value, newCookie.value, 'the new login Cookie must survive')

      // The access token lapses: only the new Cookie can serve the next call.
      await delay(1700)
      const replayed = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/v1/relays' && response.status() === 200,
        { timeout: 20_000 }
      )
      await page.locator('.nav-item[data-route="relays"]').click()
      await replayed
      assert.equal(await isVisible(page, VIEW_APP), true)
      assert.equal(await isVisible(page, VIEW_LOGIN), false)
    } finally {
      await context.close()
    }
  })

  test('U232 refresh 竞态：旧刷新晚于重登，新 Cookie 与业务请求都存活', async () => {
    const { context, page } = await openConsole(shortAccess.url)
    try {
      await loginThroughUi(page)
      const cookieBeforeRefresh = await refreshCookieOf(context)
      assert.ok(cookieBeforeRefresh)
      // Let the access token lapse so a business click starts a Cookie refresh.
      await delay(1900)

      let releaseRefresh = (): void => {}
      const refreshGate = new Promise<void>((resolve) => {
        releaseRefresh = resolve
      })
      let refreshHeld = (): void => {}
      const held = new Promise<void>((resolve) => {
        refreshHeld = resolve
      })
      let refreshSettled = (): void => {}
      const settled = new Promise<void>((resolve) => {
        refreshSettled = resolve
      })
      let exchange: { status: number; setCookie: string } | null = null

      await page.route('**/v1/auth/refresh', async (route) => {
        const response = await route.fetch()
        exchange = {
          status: response.status(),
          setCookie: response.headers()['set-cookie'] ?? ''
        }
        // Undo the early Set-Cookie so the release models a late delivery.
        await restoreCookie(context, cookieBeforeRefresh)
        refreshHeld()
        await refreshGate
        await route.fulfill({ response }).catch(() => {})
        refreshSettled()
      })

      // The expired access token gets a 401; its refresh is held mid-flight.
      await page.locator('.nav-item[data-route="relays"]').click()
      await held
      const observed = exchange as { status: number; setCookie: string } | null
      assert.equal(observed?.status, 200, 'the platform answered the held refresh')
      assert.match(observed?.setCookie ?? '', /orca_refresh=/i, 'the real refresh re-sends its Cookie')

      // Log out while the refresh is in flight, then log in as another account.
      await page.locator('#logoutBtn').click()
      await page.waitForSelector(VIEW_LOGIN, { state: 'visible', timeout: 15_000 })
      await page.fill('#username', 'zhangsan')
      await page.fill('#password', 'Passw0rd!')
      await page.click('#loginBtn')
      await page.waitForSelector(VIEW_APP, { state: 'visible', timeout: 20_000 })
      const newCookie = await refreshCookieOf(context)
      assert.ok(newCookie, 'the second login must set a Cookie')
      assert.notEqual(newCookie.value, cookieBeforeRefresh.value)

      releaseRefresh()
      await settled
      await page.unroute('**/v1/auth/refresh')
      await delay(300)

      const afterLate = await refreshCookieOf(context)
      assert.ok(afterLate, 'the stale refresh must not clear the new Cookie')
      assert.equal(afterLate.value, newCookie.value, 'the second session keeps its Cookie')

      // The new access token expires; the session must renew from the new Cookie
      // and keep serving, not fall back to the earlier account.
      await delay(1900)
      const replayed = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/v1/projects' && response.status() === 200,
        { timeout: 20_000 }
      )
      await page.locator('.nav-item[data-route="projects"]').click()
      await replayed
      await page.waitForFunction(() =>
        (document.querySelector('#content')?.textContent ?? '').includes('我的项目')
      )
      assert.equal(await isVisible(page, VIEW_APP), true)
      assert.equal(await isVisible(page, VIEW_LOGIN), false)
      assert.equal((await page.locator('#userName').textContent())?.trim(), '张伟')
    } finally {
      await context.close()
    }
  })

  test('U231 F3 Cookie 无 body 探测在途时登出：旧响应的 Set-Cookie 不复活会话', async () => {
    const { context, page } = await openConsole(shortAccess.url)
    try {
      await loginThroughUi(page)
      const cookieBeforeRefresh = await refreshCookieOf(context)
      assert.ok(cookieBeforeRefresh)
      // Let the access token lapse so a business click starts the Cookie probe.
      await delay(1900)

      let releaseRefresh = (): void => {}
      const refreshGate = new Promise<void>((resolve) => {
        releaseRefresh = resolve
      })
      let refreshHeld = (): void => {}
      const held = new Promise<void>((resolve) => {
        refreshHeld = resolve
      })
      let refreshSettled = (): void => {}
      const settled = new Promise<void>((resolve) => {
        refreshSettled = resolve
      })
      const bodies: (string | null)[] = []
      let exchange: { status: number; setCookie: string } | null = null

      await page.route('**/v1/auth/refresh', async (route) => {
        bodies.push(route.request().postData())
        const response = await route.fetch()
        exchange = {
          status: response.status(),
          setCookie: response.headers()['set-cookie'] ?? ''
        }
        // Undo the early jar write so the release models a late delivery.
        await restoreCookie(context, cookieBeforeRefresh)
        refreshHeld()
        await refreshGate
        await route.fulfill({ response }).catch(() => {})
        refreshSettled()
      })

      // The expired access token gets a 401; its no-body probe is held mid-flight.
      await page.locator('.nav-item[data-route="relays"]').click()
      await held
      assert.deepEqual(bodies, [null], 'the held refresh is the no-body Cookie probe')
      const observed = exchange as { status: number; setCookie: string } | null
      assert.equal(observed?.status, 200, 'the platform answered the held probe')
      assert.match(
        observed?.setCookie ?? '',
        /orca_refresh=/i,
        'the real probe re-sends its Cookie'
      )

      // Log out while the probe is in flight, then log in as another account.
      // The UI flips synchronously, but the server clears the Cookie in its response.
      const logoutAnswered = page.waitForResponse(
        (response) => new URL(response.url()).pathname === '/v1/auth/logout',
        { timeout: 20_000 }
      )
      await page.locator('#logoutBtn').click()
      assert.equal((await logoutAnswered).status(), 200, 'the platform answered the logout')
      await page.waitForSelector(VIEW_LOGIN, { state: 'visible', timeout: 15_000 })
      assert.equal(await refreshCookieOf(context), undefined, 'logout clears the Cookie')
      await page.fill('#username', 'zhangsan')
      await page.fill('#password', 'Passw0rd!')
      await page.click('#loginBtn')
      await page.waitForSelector(VIEW_APP, { state: 'visible', timeout: 20_000 })
      const newCookie = await refreshCookieOf(context)
      assert.ok(newCookie, 'the second login must set a Cookie')
      assert.notEqual(newCookie.value, cookieBeforeRefresh.value)

      releaseRefresh()
      await settled
      await page.unroute('**/v1/auth/refresh')
      await delay(300)

      const afterLate = await refreshCookieOf(context)
      assert.ok(afterLate, 'the stale probe must not clear the new Cookie')
      assert.equal(
        afterLate.value,
        newCookie.value,
        'the stale probe Set-Cookie must not resurrect the earlier session'
      )
      assert.equal(await isVisible(page, VIEW_APP), true)
      assert.equal(await isVisible(page, VIEW_LOGIN), false)

      // The new access token lapses; only the new Cookie may serve the next call.
      await delay(1900)
      const replayed = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/v1/projects' && response.status() === 200,
        { timeout: 20_000 }
      )
      await page.locator('.nav-item[data-route="projects"]').click()
      await replayed
      await page.waitForFunction(() =>
        (document.querySelector('#content')?.textContent ?? '').includes('我的项目')
      )
      assert.equal(await isVisible(page, VIEW_APP), true)
      assert.equal(await isVisible(page, VIEW_LOGIN), false)
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

  test('U222 N1 页内刷新传输失败：保留会话，恢复后重试成功', async () => {
    const { context, page } = await openConsole(shortAccess.url)
    try {
      await loginThroughUi(page)
      await delay(1900)
      const logoutCalls: string[] = []
      page.on('request', (request) => {
        if (new URL(request.url()).pathname === '/v1/auth/logout') {
          logoutCalls.push(request.url())
        }
      })
      let aborted = 0
      await page.route('**/v1/auth/refresh', (route) => {
        aborted += 1
        return route.abort()
      })

      await page.locator('.nav-item[data-route="relays"]').click()
      await delay(800)

      assert.ok(aborted >= 1, 'the in-page refresh must have been attempted')
      assert.equal(logoutCalls.length, 0, 'a transport failure must not revoke the session')
      assert.equal(await isVisible(page, VIEW_APP), true, 'the app shell stays visible')
      assert.equal(await isVisible(page, VIEW_LOGIN), false, 'the user stays signed in')
      assert.ok(await refreshCookieOf(context), 'the HttpOnly session must survive')

      // Network restored: the next request renews and replays normally.
      await page.unroute('**/v1/auth/refresh')
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
      assert.equal(await isVisible(page, VIEW_APP), true)
      assert.equal(await isVisible(page, VIEW_LOGIN), false)
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

  test('AC9c 清空 localStorage 后仅凭 Cookie 恢复：一次无 body 刷新进入应用', async () => {
    const { context, page } = await openConsole(cookieMode.url)
    try {
      await loginThroughUi(page)
      assert.ok(await refreshCookieOf(context), 'precondition: the Cookie session exists')

      // AC9c: no localStorage at all, not even the capability marker.
      await page.evaluate(() => window.localStorage.clear())

      const trace = traceRefresh(page)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForSelector(VIEW_APP, { state: 'visible', timeout: 20_000 })
      await delay(200)

      assert.equal(trace.bodies.length, 1, 'exactly one no-body Cookie probe')
      assert.equal(trace.bodies[0], null, 'the probe must not carry a body')
      assert.deepEqual(trace.statuses, [200], 'the Cookie alone restores the session')
      assert.equal((await readStoredAuth(page)).mode, 'cookie')
      assert.equal(await isVisible(page, VIEW_LOGIN), false)
    } finally {
      await context.close()
    }
  })

  test('AC9c 无标记 + 无旧键 + Cookie 缺失：一次失败后登录，无第二次刷新', async () => {
    const context = await browser.newContext()
    const page = await context.newPage()
    try {
      await page.goto(`${cookieMode.url}/`, { waitUntil: 'domcontentloaded' })
      await page.waitForSelector(VIEW_LOGIN, { state: 'visible', timeout: 15_000 })
      await page.evaluate(() => window.localStorage.clear())

      const trace = traceRefresh(page)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForSelector(VIEW_LOGIN, { state: 'visible', timeout: 15_000 })
      // Any retry loop would land another request inside this window.
      await delay(900)

      assert.equal(trace.bodies.length, 1, 'one probe only, never a loop')
      assert.equal(trace.bodies[0], null, 'no legacy key means no body fallback')
      assert.deepEqual(trace.statuses, [401], 'the missing Cookie is refused')
      assert.equal(await isVisible(page, VIEW_APP), false)
      assert.equal(await isVisible(page, VIEW_LOGIN), true)
    } finally {
      await context.close()
    }
  })

  test('U249 探测失败退避：60 秒内重载不再探测，结论出现后清除', async () => {
    const { context, page } = await openConsole(legacyMode.url)
    try {
      await loginThroughUi(page)
      const stored = await readStoredAuth(page)
      assert.ok(stored.access, 'precondition: the legacy access token is persisted')
      // Drop the capability marker so the next load must probe.
      await page.evaluate(() => window.localStorage.removeItem('orca.authMode'))

      // The probe fails at the transport boundary; the persistent access still resumes.
      await page.route('**/v1/auth/refresh', (route) => route.abort())
      const first = traceRefresh(page)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForSelector(VIEW_APP, { state: 'visible', timeout: 20_000 })
      await delay(200)

      assert.equal(first.bodies.length, 1, 'the first load probes once')
      const backoffAt = await page.evaluate(() =>
        window.sessionStorage.getItem('orca.authModeProbeFailedAt')
      )
      assert.ok(backoffAt, 'a failed probe records its timestamp in sessionStorage')
      assert.equal(
        await page.evaluate(() =>
          window.localStorage.getItem('orca.authModeProbeFailedAt')
        ),
        null,
        'the backoff must stay per tab, never localStorage'
      )

      // Inside the backoff window: the same tab must not probe again.
      const second = traceRefresh(page)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForSelector(VIEW_APP, { state: 'visible', timeout: 20_000 })
      await delay(800)

      assert.equal(second.bodies.length, 0, 'the backoff must suppress the repeat probe')
      assert.equal(await isVisible(page, VIEW_APP), true)
      assert.equal(await isVisible(page, VIEW_LOGIN), false)

      // Past the window the probe runs once more, and its 4xx conclusion clears
      // the backoff so the next load stops paying for it.
      await page.unroute('**/v1/auth/refresh')
      await page.evaluate(() =>
        window.sessionStorage.setItem('orca.authModeProbeFailedAt', String(Date.now() - 61_000))
      )
      const third = traceRefresh(page)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForSelector(VIEW_APP, { state: 'visible', timeout: 20_000 })
      await delay(300)

      assert.ok(third.bodies.length >= 1, 'an expired backoff must probe again')
      assert.equal(
        await page.evaluate(() =>
          window.sessionStorage.getItem('orca.authModeProbeFailedAt')
        ),
        null,
        'a 4xx probe conclusion clears the backoff'
      )
      assert.equal(await isVisible(page, VIEW_APP), true)
    } finally {
      await context.close()
    }
  })
})
