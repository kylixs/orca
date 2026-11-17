import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer as createNetServer } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
 * U197 AC9d / AC15(g) with the real Web console in real Chromium.
 *
 * AC9d: a browser that carries the Cookie capability marker and stale legacy
 * keys, with no usable Cookie, must spend exactly one no-body refresh plus one
 * body fallback, keep the old keys and land on the login view.
 *
 * AC15(g): a pre-S4 console build logs in against the Cookie-mode server. Its
 * legacy `setTokens` persists the literal string "undefined"; the server treats
 * that body value as a fake body, so an in-page 401 gets a 200 without a new
 * refresh, without rotating the Cookie and without revoking the session. The
 * last step swaps back to the current build on the same origin.
 *
 * INVALID finding (AC15(g) single reload): the current build only probes the
 * Cookie when `orca.authMode === 'cookie'`. A pre-S4 browser has no marker, so
 * the first load of the new build either takes the valid-access path (zero
 * refresh) or the body fallback with the literal "undefined". It never issues
 * the design's one no-body probe, and the legacy keys survive until a later
 * load has learned `refreshCookie: true`. The assertions below pin that fact
 * instead of claiming the designed behaviour.
 *
 * The legacy build is served from a temporary web root: the current build is
 * pinned to HEAD at `/` (the release store snapshots it at startup), and the
 * pre-S4 app.js is fulfilled behind `/legacy.html`, so both builds share one
 * origin, one cookie jar and one localStorage.
 */

const HOST = '127.0.0.1'
const READY = /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/
/** Parent of the S4 commit: the console before any Cookie capability existed. */
const LEGACY_APP_REV = '15e5ea8ae6b^'
const ACCESS_TTL_MS = 6000
const USERNAME = 'admin'
const PASSWORD = 'Adm1n!'
const VIEW_APP = '#view-app'
const VIEW_LOGIN = '#view-login'

type StoredAuth = {
  access: string | null
  refresh: string | null
  mode: string | null
}

type RefreshTrace = {
  bodies: (string | null)[]
  statuses: number[]
}

type AuthCall = { path: string; contract: string | undefined }

let browser: Browser
let workDir = ''
let webRoot = ''
let legacyAppSource = ''
let api: Service

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

function headAsset(name: string): string {
  return execFileSync('git', ['-C', ROOT, 'show', `HEAD:cloud-platform/apps/web/${name}`], {
    encoding: 'utf8'
  })
}

function buildLegacyWebRoot(): void {
  webRoot = join(workDir, 'web')
  // Pin the current build to HEAD, so an uncommitted working-tree edit in
  // another lane cannot silently become the fixture under test.
  for (const name of ['index.html', 'app.js', 'styles.css', 'router/routes.js']) {
    const target = join(webRoot, name)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, headAsset(name))
  }
  const index = readFileSync(join(webRoot, 'index.html'), 'utf8')
  const legacyScript = '<script type="module" src="/legacy-app.js"></script>'
  assert.ok(
    index.includes('<script type="module" src="/app.js"></script>'),
    'the console entry must reference /app.js'
  )
  writeFileSync(
    join(webRoot, 'legacy.html'),
    index.replace('<script type="module" src="/app.js"></script>', legacyScript)
  )
  legacyAppSource = execFileSync(
    'git',
    ['-C', ROOT, 'show', `${LEGACY_APP_REV}:cloud-platform/apps/web/app.js`],
    { encoding: 'utf8' }
  )
  assert.ok(legacyAppSource.length > 1000, 'the pre-S4 build must be readable')
  assert.equal(
    legacyAppSource.includes('orca.authMode'),
    false,
    'the fixture must predate the marker'
  )
}

/** Disk fallthrough serves every unknown path as text/html, which a module
 * script refuses; fulfill the legacy bundle with a real JavaScript MIME type. */
async function gotoLegacy(page: Page): Promise<void> {
  await page.route('**/legacy-app.js', (route) =>
    route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: legacyAppSource })
  )
  await page.goto(`${api.url}/legacy.html`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector(VIEW_LOGIN, { state: 'visible', timeout: 15_000 })
}

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'u197-migration-browser-'))
  buildLegacyWebRoot()
  const port = await reservePort()
  api = await spawnService(
    'apps/api/src/server.ts',
    {
      PORT: String(port),
      INTERNAL_TOKEN: 'u197-migration-browser',
      ORCA_CLOUD_COOKIE_MODE: 'always',
      // Empty string pins the value even if the developer shell exports one.
      ORCA_CLOUD_PUBLIC_ORIGIN: `http://${HOST}:${port}`,
      ORCA_CLOUD_WEB_ROOT: webRoot,
      ORCA_CLOUD_ACCESS_TTL_MS: String(ACCESS_TTL_MS),
      AUDIT_LOG_PATH: join(workDir, 'audit-migration.log'),
      ORCA_PLATFORM_STORE_FILE: '',
      ORCA_CLOUD_LDAP_REQUIRED_GROUP: '',
      ORCA_CLOUD_LOGIN_LOCKOUT_URL: '',
      ORCA_CLOUD_AUDIT_WRITER_URL: '',
      ORCA_CLOUD_AUDIT_WRITER_URLS: ''
    },
    READY,
    'api-u197-migration-browser'
  )
  browser = await chromium.launch({ headless: true })
}, 180_000)

after(async () => {
  await browser?.close()
  await api?.stop()
  if (workDir !== '') {
    rmSync(workDir, { recursive: true, force: true })
  }
})

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRefreshRequest(request: Request): boolean {
  return request.method() === 'POST' && new URL(request.url()).pathname === '/v1/auth/refresh'
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

function traceAuthCalls(page: Page): AuthCall[] {
  const calls: AuthCall[] = []
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (path.startsWith('/v1/auth/')) {
      calls.push({ path, contract: request.headers()['x-orca-web-contract'] })
    }
  })
  return calls
}

function readStoredAuth(page: Page): Promise<StoredAuth> {
  return page.evaluate(() => ({
    access: window.localStorage.getItem('orca.access'),
    refresh: window.localStorage.getItem('orca.refresh'),
    mode: window.localStorage.getItem('orca.authMode')
  }))
}

async function refreshCookie(context: BrowserContext): Promise<Cookie | undefined> {
  // Secure cookies do not match an http URL for cookies(url), so read the jar.
  const cookies = await context.cookies()
  return cookies.find((cookie) => cookie.name === 'orca_refresh' && cookie.path === '/v1/auth')
}

async function loginThroughUi(page: Page): Promise<void> {
  await page.fill('#username', USERNAME)
  await page.fill('#password', PASSWORD)
  await page.click('#loginBtn')
  await page.waitForSelector(VIEW_APP, { state: 'visible', timeout: 20_000 })
}

describe('U197 AC9d / AC15(g) 真实 Chromium 迁移与旧构建夹具', () => {
  test('AC9d 标记真 + 无有效 Cookie + 失效旧键：1 次无 body + 1 次 body，均 401，保留旧键', async () => {
    const context = await browser.newContext()
    const page = await context.newPage()
    try {
      await page.goto(`${api.url}/`, { waitUntil: 'domcontentloaded' })
      await page.waitForSelector(VIEW_LOGIN, { state: 'visible', timeout: 15_000 })

      await page.evaluate(() => {
        window.localStorage.setItem('orca.authMode', 'cookie')
        window.localStorage.setItem('orca.access', 'stale-access-u197-ac9d')
        window.localStorage.setItem('orca.refresh', 'stale-refresh-u197-ac9d')
      })

      const trace = traceRefresh(page)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForSelector(VIEW_LOGIN, { state: 'visible', timeout: 20_000 })
      // Any retry loop would land another request inside this window.
      await delay(900)

      assert.equal(trace.bodies.length, 2, 'exactly one no-body probe plus one body fallback')
      assert.equal(trace.bodies[0], null, 'the first attempt must carry no body')
      const fallback = JSON.parse(trace.bodies[1] ?? '{}') as Record<string, unknown>
      assert.equal(
        fallback.refreshToken,
        'stale-refresh-u197-ac9d',
        'the fallback must send the stale legacy key verbatim'
      )
      assert.deepEqual(trace.statuses, [401, 401], 'both attempts must fail')

      const stored = await readStoredAuth(page)
      assert.equal(stored.access, 'stale-access-u197-ac9d', 'a failed probe never deletes keys')
      assert.equal(stored.refresh, 'stale-refresh-u197-ac9d', 'the stale key must survive')
      assert.equal(stored.mode, 'cookie', 'the marker is not a credential and stays put')

      assert.equal(await page.locator(VIEW_APP).isVisible(), false, 'must not enter the app')
      assert.equal(await page.locator(VIEW_LOGIN).isVisible(), true, 'must land on login')
    } finally {
      await context.close()
    }
  })

  test('AC15(g) 旧构建：登录无 body refresh、写入字面量 undefined、假 body 刷新 200 不轮换', async () => {
    const context = await browser.newContext()
    const page = await context.newPage()
    try {
      const calls = traceAuthCalls(page)
      await gotoLegacy(page)

      const loginResponse = page.waitForResponse(
        (response) => new URL(response.url()).pathname === '/v1/auth/login',
        { timeout: 20_000 }
      )
      await loginThroughUi(page)
      const loginBody = (await (await loginResponse).json()) as Record<string, unknown>

      assert.equal(
        'refreshToken' in loginBody,
        false,
        'a same-origin login must not return a body refresh'
      )
      assert.equal(loginBody.refreshCookie, true, 'the Cookie capability must be advertised')
      const loginCall = calls.find((call) => call.path === '/v1/auth/login')
      assert.ok(loginCall, 'the legacy page must have logged in')
      assert.equal(loginCall.contract, undefined, 'the pre-S4 build knows no web contract')
      assert.equal(
        calls.every((call) => call.contract === undefined),
        true,
        'no request may come from the current build'
      )

      const afterLogin = await readStoredAuth(page)
      assert.ok(
        afterLogin.access !== null && afterLogin.access !== '',
        'legacy access is persisted'
      )
      assert.equal(
        afterLogin.refresh,
        'undefined',
        'legacy setTokens persisted the literal string "undefined"'
      )
      assert.equal(afterLogin.mode, null, 'the pre-S4 build cannot set the capability marker')

      const cookieBefore = await refreshCookie(context)
      assert.ok(cookieBefore, 'login must set the HttpOnly Cookie')
      assert.equal(cookieBefore.httpOnly, true)

      // The literal is `undefined` in memory right after login; only a reload
      // reads the stored string back into state.refreshToken (design §3).
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForSelector(VIEW_APP, { state: 'visible', timeout: 20_000 })

      // Short access TTL: a business click produces a 401 inside the old page.
      await delay(ACCESS_TTL_MS + 500)
      const trace = traceRefresh(page)
      const refreshResponse = page.waitForResponse(
        (response) => isRefreshRequest(response.request()),
        { timeout: 20_000 }
      )
      const replayed = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/v1/relays' && response.status() === 200,
        { timeout: 20_000 }
      )
      await page.locator('.nav-item[data-route="relays"]').click()
      const refreshBody = (await (await refreshResponse).json()) as Record<string, unknown>
      await replayed
      await delay(200)

      assert.equal(trace.bodies.length, 1, 'one body refresh for the in-page 401')
      const sent = JSON.parse(trace.bodies[0] ?? '{}') as Record<string, unknown>
      assert.equal(
        sent.refreshToken,
        'undefined',
        'the old build sends the literal as a body value'
      )
      assert.deepEqual(trace.statuses, [200], 'Cookie + fake body must answer 200')
      assert.equal(
        'refreshToken' in refreshBody,
        false,
        'a fake body must never become a refresh in the response'
      )
      assert.equal(refreshBody.refreshCookie, true, 'the Cookie is the proven credential')

      const cookieAfter = await refreshCookie(context)
      assert.ok(cookieAfter, 'the Cookie must survive the refresh')
      assert.equal(cookieAfter.value, cookieBefore.value, 'Cookie-source refresh never rotates')

      const afterRefresh = await readStoredAuth(page)
      assert.equal(
        afterRefresh.refresh,
        'undefined',
        'the old build rewrites the same literal after the 200'
      )
      assert.equal(afterRefresh.mode, null, 'the old build still cannot set the marker')
    } finally {
      await context.close()
    }
  })

  test('AC15(g) 换回新构建：单次重载不是无 body 刷新（INVALID），后续加载才清理旧键', async () => {
    const context = await browser.newContext()
    const page = await context.newPage()
    try {
      // Build the exact pre-S4 end state: Cookie set, access persisted,
      // orca.refresh === "undefined", no capability marker.
      await gotoLegacy(page)
      await loginThroughUi(page)
      assert.equal((await readStoredAuth(page)).refresh, 'undefined')
      assert.ok(await refreshCookie(context))

      // First load of the current build while the access token is still valid.
      const immediate = traceRefresh(page)
      await page.goto(`${api.url}/`, { waitUntil: 'domcontentloaded' })
      await page.waitForSelector(VIEW_APP, { state: 'visible', timeout: 20_000 })
      await delay(300)

      // FACT (INVALID vs AC15(g)): the marker is unknown, so the current build
      // takes the plain localStorage path. It does not probe the Cookie.
      assert.equal(
        immediate.bodies.length,
        0,
        'INVALID: the new build does not issue the AC15(g) no-body probe on this load'
      )
      const afterImmediate = await readStoredAuth(page)
      assert.equal(afterImmediate.refresh, 'undefined', 'the legacy key is still there')
      assert.equal(afterImmediate.mode, null, 'nothing taught the marker')
      assert.equal(await page.locator(VIEW_LOGIN).isVisible(), false)

      // The access token expires; the current build still falls back to the
      // legacy body contract (with the literal), which the Cookie rescues.
      await delay(ACCESS_TTL_MS + 700)
      const fallback = traceRefresh(page)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForSelector(VIEW_APP, { state: 'visible', timeout: 20_000 })
      await delay(300)

      assert.equal(fallback.bodies.length, 1, 'the expired load refreshes once')
      assert.equal(
        fallback.bodies[0] !== null,
        true,
        'INVALID: the refresh is a body fallback, not the AC15(g) no-body probe'
      )
      assert.equal(
        (JSON.parse(fallback.bodies[0] ?? '{}') as Record<string, unknown>).refreshToken,
        'undefined'
      )
      assert.deepEqual(fallback.statuses, [200], 'the Cookie keeps the fake body benign')
      const afterFallback = await readStoredAuth(page)
      assert.equal(afterFallback.refresh, 'undefined', 'keys are kept until a no-body success')
      assert.equal(afterFallback.mode, 'cookie', 'refreshCookie:true finally proves the capability')

      // With the marker learned, the next reload performs the one no-body
      // Cookie refresh and only then deletes the legacy keys (session still live).
      const noBody = traceRefresh(page)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForSelector(VIEW_APP, { state: 'visible', timeout: 20_000 })
      await delay(300)

      assert.equal(noBody.bodies.length, 1, 'exactly one no-body refresh')
      assert.equal(noBody.bodies[0], null, 'the refreshed request carries no body')
      assert.deepEqual(noBody.statuses, [200], 'the session survived the fake-body refresh')
      const afterNoBody = await readStoredAuth(page)
      assert.equal(afterNoBody.access, null, 'legacy access is deleted')
      assert.equal(afterNoBody.refresh, null, 'legacy refresh is deleted')
      assert.equal(afterNoBody.mode, 'cookie')
      assert.equal(await page.locator(VIEW_APP).isVisible(), true)
      assert.equal(await page.locator(VIEW_LOGIN).isVisible(), false)
    } finally {
      await context.close()
    }
  })

  test('判别力：伪造 orca_refresh + 假 body 必须 401 SESSION_EXPIRED', async () => {
    const context = await browser.newContext()
    await context.addCookies([
      {
        name: 'orca_refresh',
        value: 'u197-not-a-session-token',
        domain: HOST,
        path: '/v1/auth',
        httpOnly: true,
        sameSite: 'Lax'
      }
    ])
    const page = await context.newPage()
    try {
      await page.goto(`${api.url}/`, { waitUntil: 'domcontentloaded' })
      await page.waitForSelector(VIEW_LOGIN, { state: 'visible', timeout: 15_000 })
      const result = await page.evaluate(async () => {
        const res = await fetch('/v1/auth/refresh', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken: 'undefined' })
        })
        return { status: res.status, text: await res.text() }
      })
      assert.equal(result.status, 401, 'an unknown Cookie must never resolve a session')
      assert.match(result.text, /SESSION_EXPIRED/)
    } finally {
      await context.close()
    }
  })
})
