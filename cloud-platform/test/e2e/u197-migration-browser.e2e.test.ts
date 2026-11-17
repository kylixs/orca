import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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
 * final step swaps back to the current build on the same origin: with no
 * capability marker it probes the Cookie once, and that no-body success is the
 * single-reload migration that deletes the legacy keys.
 *
 * The legacy build is served from a temporary web root: the current build is
 * read from the working tree at `/` (no `git show`, so a shallow clone still
 * works), and the pre-S4 app.js comes from the checked-in snapshot
 * `test/fixtures/u197-legacy-app.js.snapshot`, so both builds share one origin,
 * one cookie jar and one localStorage.
 */

const HOST = '127.0.0.1'
const READY = /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/
/** Checked-in snapshot of `apps/web/app.js` at `15e5ea8ae6b^` (= `e97878fb55a`).
 * The `.snapshot` suffix keeps oxlint/oxfmt from rewriting an exact copy. */
const LEGACY_APP_FIXTURE = join(ROOT, 'test/fixtures/u197-legacy-app.js.snapshot')
/** U225 N1: this suite reads the working tree, so pin the exact console build the
 * assertions were written against. Update after an intentional `apps/web/app.js`
 * change: `sha256sum apps/web/app.js` (macOS/Linux) or
 * `Get-FileHash -Algorithm SHA256 apps/web/app.js` (Windows), then rerun.
 * U225 F1: compared LF-normalised (`sha256Lf`), so line endings never matter. */
const HEAD_APP_SHA256 = 'e1eb84ee5e1364f5365744bdb62316dfd208515abc27831c6ffa8ff3c9b1e7ab'
/** U225 P3: sha256 of the fixture body after its 13-line provenance header
 * (`tail -n +14 test/fixtures/u197-legacy-app.js.snapshot | sha256sum`). */
const LEGACY_FIXTURE_BODY_SHA256 =
  '55dedf7b6be2eb67f8d8002b06a9b8530d759bfa29717eb0c27c78c6bae23566'
/**
 * Long enough that the freshly minted legacy access survives the login
 * assertions on a slow runner (N3); tests that need a 401 still wait it out.
 */
const ACCESS_TTL_MS = 15_000
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
/** U225 N3R: a pre-U197 (`never`) deployment the browser may still reach after
 * a stale cookie marker is left behind. */
let apiNever: Service

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

function webAsset(name: string): string {
  return readFileSync(join(ROOT, 'apps/web', name), 'utf8')
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** U225 F1: pins are LF-normalised so a CRLF checkout (Windows autocrlf) can't
 * fake a mismatch — or tempt someone to pin the CRLF hash. */
function sha256Lf(text: string): string {
  return sha256(text.replace(/\r\n/g, '\n'))
}

function buildLegacyWebRoot(): void {
  webRoot = join(workDir, 'web')
  // Read the app assets from the working tree, not `git show HEAD:` — a shallow
  // clone has no usable history, and the test is meant to exercise the build
  // under test rather than a historical one. The hash pin makes that dependency
  // explicit: an uncommitted edit must be acknowledged here first (U225 N1).
  assert.equal(
    sha256Lf(webAsset('app.js')),
    HEAD_APP_SHA256,
    'apps/web/app.js differs from the build this migration suite pins; recompute ' +
      'HEAD_APP_SHA256 (see its comment) or revert the unexpected change'
  )
  for (const name of ['index.html', 'app.js', 'styles.css', 'router/routes.js']) {
    const target = join(webRoot, name)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, webAsset(name))
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
  legacyAppSource = readFileSync(LEGACY_APP_FIXTURE, 'utf8')
  assert.ok(legacyAppSource.length > 1000, 'the pre-S4 build must be readable')
  // U225 P3: the 13-line provenance header is expected; the body is the exact
  // pre-S4 console the assertions describe, so pin it too.
  assert.equal(
    sha256Lf(legacyAppSource.split('\n').slice(13).join('\n')),
    LEGACY_FIXTURE_BODY_SHA256,
    'the legacy fixture body drifted; regenerate it from git or update the pin'
  )
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
  const neverPort = await reservePort()
  apiNever = await spawnService(
    'apps/api/src/server.ts',
    {
      PORT: String(neverPort),
      INTERNAL_TOKEN: 'u197-migration-browser-never',
      ORCA_CLOUD_COOKIE_MODE: 'never',
      ORCA_CLOUD_PUBLIC_ORIGIN: '',
      ORCA_CLOUD_WEB_ROOT: webRoot,
      ORCA_CLOUD_ACCESS_TTL_MS: String(ACCESS_TTL_MS),
      AUDIT_LOG_PATH: join(workDir, 'audit-migration-never.log'),
      ORCA_PLATFORM_STORE_FILE: '',
      ORCA_CLOUD_LDAP_REQUIRED_GROUP: '',
      ORCA_CLOUD_LOGIN_LOCKOUT_URL: '',
      ORCA_CLOUD_AUDIT_WRITER_URL: '',
      ORCA_CLOUD_AUDIT_WRITER_URLS: ''
    },
    READY,
    'api-u197-migration-browser-never'
  )
  browser = await chromium.launch({ headless: true })
}, 180_000)

after(async () => {
  await browser?.close()
  await Promise.all([api?.stop(), apiNever?.stop()])
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
        // U229 F2: an ownerless key no longer qualifies for the body fallback.
        window.localStorage.setItem('orca.tokenOwner', 'admin')
        window.localStorage.setItem('orca.user', JSON.stringify({ username: 'admin' }))
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

      // The in-page refresh (and the replayed business call) still belong to the
      // pre-S4 build: no `/v1/auth/*` request may carry the new web contract.
      assert.equal(
        calls.every((call) => call.contract === undefined),
        true,
        'the legacy page never sends the web contract header, even after the in-page refresh'
      )

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

  test('AC15(g) 换回新构建：首次加载即一次无 body 成功并删除旧键', async () => {
    const context = await browser.newContext()
    const page = await context.newPage()
    try {
      // Build the exact pre-S4 end state: Cookie set, access persisted,
      // orca.refresh === "undefined", no capability marker.
      await gotoLegacy(page)
      await loginThroughUi(page)
      const loginCompletedAt = Date.now()
      assert.equal((await readStoredAuth(page)).refresh, 'undefined')
      assert.ok(await refreshCookie(context))

      // The legacy access token is still valid here: the unknown marker must
      // still trigger the one no-body probe, proving the probe is not merely a
      // late-401 path.
      assert.ok(
        Date.now() - loginCompletedAt < ACCESS_TTL_MS - 5000,
        'the first current-build load must happen while legacy access is still valid'
      )

      const immediate = traceRefresh(page)
      await page.goto(`${api.url}/`, { waitUntil: 'domcontentloaded' })
      await page.waitForSelector(VIEW_APP, { state: 'visible', timeout: 20_000 })
      await delay(300)

      assert.equal(immediate.bodies.length, 1, 'exactly one migration refresh on the first load')
      assert.equal(immediate.bodies[0], null, 'the migration probe carries no body')
      assert.deepEqual(immediate.statuses, [200], 'the Cookie alone proves the session')

      const migrated = await readStoredAuth(page)
      assert.equal(migrated.access, null, 'legacy access is deleted by the no-body success')
      assert.equal(migrated.refresh, null, 'the literal "undefined" key is deleted too')
      assert.equal(migrated.mode, 'cookie', 'a no-body success proves Cookie-only mode')
      assert.equal(await page.locator(VIEW_APP).isVisible(), true)
      assert.equal(await page.locator(VIEW_LOGIN).isVisible(), false)

      // The migration is final: the next load refreshes via the Cookie again and
      // never re-creates a localStorage token.
      const next = traceRefresh(page)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForSelector(VIEW_APP, { state: 'visible', timeout: 20_000 })
      await delay(200)

      assert.equal(next.bodies.length, 1, 'one Cookie refresh per load')
      assert.equal(next.bodies[0], null)
      assert.equal((await readStoredAuth(page)).refresh, null, 'no key comes back')
    } finally {
      await context.close()
    }
  })

  // U229 F2 supersedes the U225 N3R ownerless branch: a cookie marker can
  // outlive the deployment that set it, but an ownerless pre-U221 key cannot
  // prove which account it belongs to, so it must not drive a body fallback.
  test('U229 F2 Cookie 标记 + never 服务端：无 owner 旧键不回退、清键并回登录', async () => {
    const context = await browser.newContext()
    const page = await context.newPage()
    try {
      await page.goto(`${apiNever.url}/`, { waitUntil: 'domcontentloaded' })
      await page.waitForSelector(VIEW_LOGIN, { state: 'visible', timeout: 15_000 })
      await loginThroughUi(page)

      const stored = await readStoredAuth(page)
      assert.equal(
        stored.mode,
        'legacy',
        'a login without refreshCookie classifies the deployment as legacy'
      )
      assert.ok(stored.refresh, 'the legacy contract persists a body refresh')
      // Model pre-U221 data plus a marker left by an earlier cookie deployment.
      await page.evaluate(() => {
        window.localStorage.removeItem('orca.tokenOwner')
        window.localStorage.setItem('orca.authMode', 'cookie')
      })

      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForSelector(VIEW_LOGIN, { state: 'visible', timeout: 20_000 })
      const after = await page.evaluate(() => ({
        owner: window.localStorage.getItem('orca.tokenOwner'),
        mode: window.localStorage.getItem('orca.authMode'),
        access: window.localStorage.getItem('orca.access'),
        refresh: window.localStorage.getItem('orca.refresh')
      }))

      assert.equal(after.owner, null)
      assert.equal(after.access, null, 'the untrusted legacy access is deleted')
      assert.equal(after.refresh, null, 'the untrusted legacy refresh is deleted')
      assert.equal(after.mode, 'cookie', 'the marker is not a credential and stays put')
      assert.equal(await page.locator(VIEW_APP).isVisible(), false)
      assert.equal(await page.locator(VIEW_LOGIN).isVisible(), true)
    } finally {
      await context.close()
    }
  })

  test('U225 N3R 纯 Cookie 模式成功刷新不写 tokenOwner', async () => {
    const context = await browser.newContext()
    const page = await context.newPage()
    try {
      await page.goto(`${api.url}/`, { waitUntil: 'domcontentloaded' })
      await page.waitForSelector(VIEW_LOGIN, { state: 'visible', timeout: 15_000 })
      await loginThroughUi(page)
      assert.equal(
        await page.evaluate(() => window.localStorage.getItem('orca.tokenOwner')),
        null,
        'cookie login persists no local token, so it owns no localStorage account'
      )

      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForSelector(VIEW_APP, { state: 'visible', timeout: 20_000 })
      assert.equal(
        await page.evaluate(() => window.localStorage.getItem('orca.tokenOwner')),
        null,
        'the Cookie startup success must not write a localStorage owner'
      )
      assert.equal((await readStoredAuth(page)).mode, 'cookie')
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
