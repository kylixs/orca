import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createNetServer } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
 * U197 AC1 / AC2 / AC4 through a real browser: the refresh secret lives only in
 * the HttpOnly Cookie; no script-readable surface, response body, console line
 * or audit line carries it, and an expired access token recovers by reload.
 */

const HOST = '127.0.0.1'
const READY = /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/
const WEB_SOURCE = join(ROOT, 'apps/web')
const USERNAME = 'admin'
const PASSWORD = 'Adm1n!'
const VIEW_APP = '#view-app'
const VIEW_LOGIN = '#view-login'
/** Short enough for a reload test; ORCA_CLOUD_ACCESS_TTL_MS only shortens access. */
const ACCESS_TTL_MS = 1200
const AUDIT_FILE = 'audit-ac.log'

/** Every script-readable place the design names, captured in one round trip. */
type StorageSurface = {
  localKeys: string[]
  localEntries: [string, string][]
  localJson: string
  sessionKeys: string[]
  sessionEntries: [string, string][]
  sessionJson: string
  documentCookie: string
  href: string
  hash: string
}

type RefreshTrace = {
  bodies: (string | null)[]
  statuses: number[]
}

let browser: Browser
let workDir = ''
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

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'u197-ac-probes-'))
  const port = await reservePort()
  api = await spawnService(
    'apps/api/src/server.ts',
    {
      PORT: String(port),
      INTERNAL_TOKEN: 'u197-ac-probes',
      ORCA_CLOUD_COOKIE_MODE: 'always',
      // Empty string pins the value even if the developer shell exports one.
      ORCA_CLOUD_PUBLIC_ORIGIN: `http://${HOST}:${port}`,
      ORCA_CLOUD_WEB_ROOT: WEB_SOURCE,
      ORCA_CLOUD_ACCESS_TTL_MS: String(ACCESS_TTL_MS),
      AUDIT_LOG_PATH: join(workDir, AUDIT_FILE),
      ORCA_PLATFORM_STORE_FILE: '',
      ORCA_CLOUD_LDAP_REQUIRED_GROUP: '',
      ORCA_CLOUD_LOGIN_LOCKOUT_URL: '',
      ORCA_CLOUD_AUDIT_WRITER_URL: '',
      ORCA_CLOUD_AUDIT_WRITER_URLS: ''
    },
    READY,
    'api-u197-ac-probes'
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
  return (
    request.method() === 'POST' && new URL(request.url()).pathname === '/v1/auth/refresh'
  )
}

function traceRefresh(page: Page): RefreshTrace {
  const trace: RefreshTrace = { bodies: [], statuses: [] }
  page.on('request', (request) => {
    if (isRefreshRequest(request)) trace.bodies.push(request.postData())
  })
  page.on('response', (response) => {
    if (isRefreshRequest(response.request())) trace.statuses.push(response.status())
  })
  return trace
}

async function refreshCookieValue(context: BrowserContext): Promise<string | undefined> {
  // Secure cookies do not match an http URL in cookies(url), so read the jar.
  const cookies = await context.cookies()
  return cookies.find((cookie) => cookie.name === 'orca_refresh' && cookie.path === '/v1/auth')
    ?.value
}

async function openConsole(): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto(`${api.url}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector(VIEW_LOGIN, { state: 'visible', timeout: 15_000 })
  return { context, page }
}

async function loginThroughUi(page: Page): Promise<void> {
  await page.fill('#username', USERNAME)
  await page.fill('#password', PASSWORD)
  await page.click('#loginBtn')
  await page.waitForSelector(VIEW_APP, { state: 'visible', timeout: 20_000 })
}

function readSurfaces(page: Page): Promise<StorageSurface> {
  return page.evaluate(() => {
    const dump = (storage: Storage): [string, string][] => {
      const pairs: [string, string][] = []
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index)
        if (key !== null) pairs.push([key, storage.getItem(key) ?? ''])
      }
      return pairs
    }
    const localEntries = dump(window.localStorage)
    const sessionEntries = dump(window.sessionStorage)
    return {
      localKeys: localEntries.map(([key]) => key),
      localEntries,
      localJson: JSON.stringify(window.localStorage),
      sessionKeys: sessionEntries.map(([key]) => key),
      sessionEntries,
      sessionJson: JSON.stringify(window.sessionStorage),
      documentCookie: document.cookie,
      href: window.location.href,
      hash: window.location.hash
    }
  })
}

/** The same string scan is used for the control value and the real secret. */
function containsSecret(surface: StorageSurface, secret: string): boolean {
  const strings: string[] = [
    surface.localJson,
    surface.sessionJson,
    surface.documentCookie,
    surface.href,
    surface.hash,
    ...surface.localKeys,
    ...surface.sessionKeys
  ]
  for (const [key, value] of [...surface.localEntries, ...surface.sessionEntries]) {
    strings.push(key, value)
  }
  return strings.some((text) => text.includes(secret))
}

async function assertNoScriptReadableToken(
  page: Page,
  label: string,
  refreshValue: string
): Promise<void> {
  const surface = await readSurfaces(page)
  assert.equal(
    surface.localKeys.includes('orca.access'),
    false,
    `${label}: localStorage must not keep orca.access`
  )
  assert.equal(
    surface.localKeys.includes('orca.refresh'),
    false,
    `${label}: localStorage must not keep orca.refresh`
  )
  assert.equal(
    surface.sessionKeys.includes('orca.access'),
    false,
    `${label}: sessionStorage must not keep orca.access`
  )
  assert.equal(
    surface.sessionKeys.includes('orca.refresh'),
    false,
    `${label}: sessionStorage must not keep orca.refresh`
  )
  assert.equal(
    containsSecret(surface, refreshValue),
    false,
    `${label}: the refresh value leaked into a script-readable surface`
  )
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await delay(50)
  }
  throw new Error(`timed out waiting for ${what}`)
}

describe('U197 AC1/AC2/AC4 真实浏览器探针', () => {
  test('AC1 登录 / 业务刷新 / 登出后存储无令牌键，也无 refresh 真值', async () => {
    const { context, page } = await openConsole()
    try {
      await loginThroughUi(page)
      const refreshValue = await refreshCookieValue(context)
      assert.ok(refreshValue !== undefined && refreshValue !== '', 'login must issue the Cookie')

      await assertNoScriptReadableToken(page, 'after login', refreshValue)
      assert.equal(
        await page.evaluate(() => window.localStorage.getItem('orca.authMode')),
        'cookie',
        'the capability marker proves Cookie mode is active'
      )

      // The access TTL is 1200ms, so this business request answers 401 and the
      // page performs exactly one Cookie refresh before replaying it.
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

      assert.equal(trace.bodies.length, 1, 'the business request must trigger one refresh')
      assert.equal(trace.bodies[0], null, 'the Cookie refresh carries no body')
      await assertNoScriptReadableToken(page, 'after business-request refresh', refreshValue)

      const loggedOut = page.waitForResponse(
        (response) => new URL(response.url()).pathname === '/v1/auth/logout',
        { timeout: 20_000 }
      )
      await page.locator('#logoutBtn').click()
      assert.equal((await loggedOut).status(), 200)
      await page.waitForSelector(VIEW_LOGIN, { state: 'visible', timeout: 15_000 })
      await delay(250)

      await assertNoScriptReadableToken(page, 'after logout', refreshValue)
      assert.equal(await refreshCookieValue(context), undefined, 'logout clears the Cookie')
    } finally {
      await context.close()
    }
  })

  test('AC2 access 过期后 reload 仍进工作台，恰好一次无 body 刷新', async () => {
    const { context, page } = await openConsole()
    try {
      await loginThroughUi(page)
      assert.ok(await refreshCookieValue(context), 'precondition: Cookie session exists')
      await delay(1900)

      const trace = traceRefresh(page)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForSelector(VIEW_APP, { state: 'visible', timeout: 20_000 })
      await delay(200)

      assert.equal(trace.bodies.length, 1, 'exactly one refresh during reload')
      assert.equal(trace.bodies[0], null, 'the recovery refresh carries no body')
      assert.deepEqual(trace.statuses, [200])
      assert.equal(
        await page.locator(VIEW_LOGIN).isVisible(),
        false,
        'the expired access token must not send the user back to login'
      )
    } finally {
      await context.close()
    }
  })

  test('AC4 注入探针：存储/cookie/URL/console/响应体/审计均无 refresh', async () => {
    const context = await browser.newContext()
    const page = await context.newPage()
    const consoleLines: string[] = []
    // Attach before navigation so no early line can escape the net.
    page.on('console', (message) => consoleLines.push(message.text()))
    page.on('pageerror', (error) => consoleLines.push(String(error)))

    try {
      await page.goto(`${api.url}/`, { waitUntil: 'domcontentloaded' })
      await page.waitForSelector(VIEW_LOGIN, { state: 'visible', timeout: 15_000 })
      await loginThroughUi(page)
      const refreshValue = await refreshCookieValue(context)
      assert.ok(refreshValue !== undefined && refreshValue !== '', 'login must issue the Cookie')

      // Discrimination self-check: a synthetic control value planted in both
      // storages is found by the same scanner, then removed and no longer found.
      const control = 'u197-scan-control-value-7f3c'
      await page.evaluate((value) => {
        window.localStorage.setItem('__u197_control_local__', value)
        window.sessionStorage.setItem('__u197_control_session__', value)
      }, control)
      const planted = await readSurfaces(page)
      assert.equal(containsSecret(planted, control), true, 'the scanner must detect a planted value')
      await page.evaluate(() => {
        window.localStorage.removeItem('__u197_control_local__')
        window.sessionStorage.removeItem('__u197_control_session__')
      })
      const cleaned = await readSurfaces(page)
      assert.equal(containsSecret(cleaned, control), false, 'removing the control clears the hit')

      // The real surface scan.
      assert.equal(containsSecret(cleaned, refreshValue), false, 'storage/URL/cookie leak')
      assert.equal(cleaned.documentCookie.includes('orca_refresh'), false, 'HttpOnly stays hidden')
      assert.equal(cleaned.localKeys.includes('orca.access'), false)
      assert.equal(cleaned.localKeys.includes('orca.refresh'), false)

      // Console discrimination self-check, then the real scan.
      await page.evaluate((value) => console.log('u197-console-control', value), control)
      await delay(100)
      assert.equal(
        consoleLines.some((line) => line.includes(control)),
        true,
        'the console sink must capture messages'
      )
      assert.equal(
        consoleLines.some((line) => line.includes(refreshValue)),
        false,
        'the refresh value must not reach the console'
      )

      // A page-injected XSS probe calls the refresh endpoint directly.
      const probe = await page.evaluate(async () => {
        const res = await fetch('/v1/auth/refresh', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' }
        })
        const text = await res.text()
        let keys: string[] = []
        try {
          const candidate: unknown = JSON.parse(text)
          if (candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)) {
            keys = Object.keys(candidate)
          }
        } catch {
          // A non-JSON body is still scanned as text below.
        }
        return { status: res.status, keys, text }
      })
      assert.equal(probe.status, 200, 'the Cookie-authenticated probe must succeed')
      assert.equal(
        probe.keys.includes('refreshToken'),
        false,
        'a Cookie-source refresh must never return refreshToken'
      )
      assert.equal(probe.text.includes(refreshValue), false, 'the body must not echo the Cookie value')

      // Audit: the file must really contain events, and none may carry the value.
      const auditPath = join(workDir, AUDIT_FILE)
      await waitFor(() => existsSync(auditPath), 'the audit log')
      const auditText = readFileSync(auditPath, 'utf8')
      assert.ok(auditText.includes('"eventType":"login"'), 'the audit log must carry real events')
      assert.equal(auditText.includes(refreshValue), false, 'audit metadata must not carry it')
    } finally {
      await context.close()
    }
  })
})
