import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { createServer as createNetServer, type AddressInfo } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Cookie,
  type Page,
  type Response as BrowserResponse
} from 'playwright'
import { spawnService, type Service } from './harness.ts'

/**
 * U197 S5: the Cookie transport is verified through a real browser cookie jar,
 * against the real API process — not createApp in-process and not happy-dom.
 * A same-origin page is served from ORCA_CLOUD_PUBLIC_ORIGIN itself, so every
 * fetch is judged by Chromium's actual Origin/SameSite/Cookie rules.
 */

const HOST = '127.0.0.1'
const REFRESH_TTL_MS = 120_000
const REFRESH_MAX_AGE = 120
const READY = /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/

type ServiceKey = 'always' | 'never' | 'unconfigured'
type AuthEvaluation = { status: number; body: Record<string, unknown>; documentCookie: string }

let browser: Browser
let workDir = ''
let webRoot = ''
let always: Service
let never: Service
let unconfigured: Service
let otherOriginServer: HttpServer | undefined
let otherOrigin = ''
const observed: Record<ServiceKey, string[]> = { always: [], never: [], unconfigured: [] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function errorCode(body: Record<string, unknown>): string | undefined {
  const error = body.error
  if (!isRecord(error)) {
    return undefined
  }
  return typeof error.code === 'string' ? error.code : undefined
}

async function reservePort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, HOST, () => resolve())
  })
  const address = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

function startApi(
  key: ServiceKey,
  mode: string,
  publicOrigin: string,
  port: number
): Promise<Service> {
  return spawnService(
    'apps/api/src/server.ts',
    {
      PORT: String(port),
      INTERNAL_TOKEN: `u197-cookie-browser-${key}`,
      ORCA_CLOUD_COOKIE_MODE: mode,
      // Empty string pins "unconfigured" even if the developer shell exports one.
      ORCA_CLOUD_PUBLIC_ORIGIN: publicOrigin,
      ORCA_CLOUD_WEB_ROOT: webRoot,
      ORCA_CLOUD_REFRESH_TTL_MS: String(REFRESH_TTL_MS),
      AUDIT_LOG_PATH: join(workDir, `audit-${key}.log`),
      ORCA_PLATFORM_STORE_FILE: '',
      ORCA_CLOUD_LDAP_REQUIRED_GROUP: '',
      ORCA_CLOUD_LOGIN_LOCKOUT_URL: '',
      ORCA_CLOUD_AUDIT_WRITER_URL: '',
      ORCA_CLOUD_AUDIT_WRITER_URLS: ''
    },
    READY,
    `api-u197-${key}`
  )
}

function listenHttp(server: HttpServer, port: number): Promise<void> {
  return new Promise((resolve) => server.listen(port, HOST, () => resolve()))
}

function closeHttp(server: HttpServer | undefined): Promise<void> {
  if (!server) {
    return Promise.resolve()
  }
  return new Promise((resolve) => server.close(() => resolve()))
}

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'u197-cookie-browser-'))
  webRoot = join(workDir, 'web')
  mkdirSync(webRoot, { recursive: true })
  writeFileSync(
    join(webRoot, 'index.html'),
    '<!doctype html><html><body><div id="ready">ready</div></body></html>'
  )
  // Sequential: a reserved port is only safe until the next listener takes it.
  const alwaysPort = await reservePort()
  const neverPort = await reservePort()
  const unconfiguredPort = await reservePort()
  const otherPort = await reservePort()
  const alwaysOrigin = `http://${HOST}:${alwaysPort}`
  always = await startApi('always', 'always', alwaysOrigin, alwaysPort)
  never = await startApi('never', 'never', `http://${HOST}:${neverPort}`, neverPort)
  unconfigured = await startApi('unconfigured', 'auto', '', unconfiguredPort)
  otherOriginServer = createHttpServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end('<!doctype html><html><body><div id="other-origin">other</div></body></html>')
  })
  await listenHttp(otherOriginServer, otherPort)
  otherOrigin = `http://${HOST}:${otherPort}`
  browser = await chromium.launch({ headless: true })
}, 180_000)

after(async () => {
  await browser?.close()
  await Promise.all([always?.stop(), never?.stop(), unconfigured?.stop()])
  await closeHttp(otherOriginServer)
  if (workDir !== '') {
    rmSync(workDir, { recursive: true, force: true })
  }
})

async function openPage(base: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#ready')
  return { context, page }
}

async function login(
  page: Page,
  base: string,
  deviceName: string
): Promise<{ response: BrowserResponse; result: AuthEvaluation }> {
  const url = `${base}/v1/auth/login`
  const [response, result] = await Promise.all([
    page.waitForResponse((res) => res.url() === url && res.request().method() === 'POST'),
    page.evaluate(
      async (input: { base: string; deviceName: string }): Promise<AuthEvaluation> => {
        const res = await fetch(`${input.base}/v1/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            username: 'admin',
            password: 'Adm1n!',
            deviceName: input.deviceName
          })
        })
        const body: Record<string, unknown> = await res.json()
        return { status: res.status, body, documentCookie: document.cookie }
      },
      { base, deviceName }
    )
  ])
  return { response, result }
}

async function refresh(
  page: Page,
  base: string,
  input: { contentType: string; body?: string }
): Promise<{ response: BrowserResponse; result: AuthEvaluation }> {
  const url = `${base}/v1/auth/refresh`
  const [response, result] = await Promise.all([
    page.waitForResponse((res) => res.url() === url && res.request().method() === 'POST'),
    page.evaluate(
      async (arg: {
        base: string
        contentType: string
        body?: string
      }): Promise<AuthEvaluation> => {
        const res = await fetch(`${arg.base}/v1/auth/refresh`, {
          method: 'POST',
          headers: { 'content-type': arg.contentType },
          ...(arg.body === undefined ? {} : { body: arg.body })
        })
        const body: Record<string, unknown> = await res.json()
        return { status: res.status, body, documentCookie: document.cookie }
      },
      {
        base,
        contentType: input.contentType,
        ...(input.body === undefined ? {} : { body: input.body })
      }
    )
  ])
  return { response, result }
}

async function setCookieHeaders(response: BrowserResponse): Promise<string[]> {
  const headers = await response.headersArray()
  return headers
    .filter((header) => header.name.toLowerCase() === 'set-cookie')
    .map((header) => header.value)
}

async function singleSetCookie(response: BrowserResponse): Promise<string> {
  const headers = await setCookieHeaders(response)
  assert.equal(headers.length, 1, `expected exactly one Set-Cookie, got ${JSON.stringify(headers)}`)
  return headers[0] ?? ''
}

function cookieValueOf(header: string): string {
  const match = /^orca_refresh=([A-Za-z0-9_-]*);/.exec(header)
  assert.ok(match, `expected a refresh cookie header, got: ${header}`)
  return match[1] ?? ''
}

function assertCookieAttributes(header: string, maxAge: number): void {
  assert.match(header, /^orca_refresh=[A-Za-z0-9_-]+;/)
  assert.match(header, /Path=\/v1\/auth/)
  assert.match(header, new RegExp(`Max-Age=${maxAge}(;|$)`))
  assert.match(header, /HttpOnly/)
  assert.match(header, /SameSite=Lax/)
  assert.match(header, /Secure/)
}

function refreshCookieOf(cookies: Cookie[]): Cookie | undefined {
  // Secure cookies do not match an http URL for context.cookies(url), so read
  // the whole jar. The refresh cookie is the one scoped to the auth path.
  return cookies.find((cookie) => cookie.name === 'orca_refresh' && cookie.path === '/v1/auth')
}

async function storedCookie(context: BrowserContext): Promise<Cookie | undefined> {
  return refreshCookieOf(await context.cookies())
}

async function signIn(
  page: Page,
  base: string,
  deviceName: string
): Promise<{ value: string; expires: number }> {
  const { result } = await login(page, base, deviceName)
  assert.equal(result.status, 200)
  const cookie = await storedCookie(page.context())
  assert.ok(cookie, 'login must store the refresh cookie in the browser jar')
  observed.always.push(cookie.value)
  return { value: cookie.value, expires: cookie.expires }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('U197 S5 真实 Chromium：Cookie 刷新 / CSRF / 重复 Cookie', () => {
  test('1. always + PUBLIC_ORIGIN：登录只下发 HttpOnly Cookie，body 无 refresh', async () => {
    const { context, page } = await openPage(always.url)
    try {
      const { response, result } = await login(page, always.url, 'u197-login')
      assert.equal(result.status, 200)
      assert.equal('refreshToken' in result.body, false)
      assert.equal(result.body.refreshCookie, true)
      assert.equal(typeof result.body.accessToken, 'string')
      assert.equal(typeof result.body.user, 'object')

      const header = await singleSetCookie(response)
      assertCookieAttributes(header, REFRESH_MAX_AGE)
      const value = cookieValueOf(header)
      observed.always.push(value)

      // HttpOnly: page script cannot even see the name.
      assert.equal(result.documentCookie.includes('orca_refresh'), false)

      const cookie = await storedCookie(context)
      assert.ok(cookie)
      assert.equal(cookie.value, value)
      assert.equal(cookie.httpOnly, true)
      assert.equal(cookie.path, '/v1/auth')
      assert.equal(cookie.sameSite, 'Lax')
      assert.equal(cookie.secure, true)
      const remaining = cookie.expires - Date.now() / 1000
      assert.ok(
        remaining > REFRESH_MAX_AGE - 30 && remaining <= REFRESH_MAX_AGE,
        `cookie TTL should be near ${REFRESH_MAX_AGE}s, got ${remaining.toFixed(1)}s`
      )
    } finally {
      await context.close()
    }
  })

  test('2. 空 body 同源刷新：200、仅 access、同值重发、TTL 滑动', async () => {
    const { context, page } = await openPage(always.url)
    try {
      const before = await signIn(page, always.url, 'u197-empty-body')
      await delay(1200)

      const { response, result } = await refresh(page, always.url, {
        contentType: 'application/json'
      })
      assert.equal(result.status, 200)
      assert.equal(typeof result.body.accessToken, 'string')
      assert.equal('refreshToken' in result.body, false)
      assert.equal(result.body.refreshCookie, true)

      const header = await singleSetCookie(response)
      assertCookieAttributes(header, REFRESH_MAX_AGE)
      assert.equal(cookieValueOf(header), before.value, 'the server must resend the same value')

      const after = await storedCookie(context)
      assert.ok(after)
      assert.equal(after.value, before.value)
      assert.ok(
        after.expires > before.expires + 0.5,
        `Set-Cookie must slide the expiry (before ${before.expires}, after ${after.expires})`
      )
      assert.equal(result.documentCookie.includes('orca_refresh'), false)
    } finally {
      await context.close()
    }
  })

  test('3a. 跨 Origin 页面刷新：服务端 403，session 与 Cookie 不变', async () => {
    const { context, page } = await openPage(always.url)
    try {
      const before = await signIn(page, always.url, 'u197-csrf-origin')
      const crossPage = await context.newPage()
      await crossPage.goto(`${otherOrigin}/`, { waitUntil: 'domcontentloaded' })
      await crossPage.waitForSelector('#other-origin')

      const refreshUrl = `${always.url}/v1/auth/refresh`
      const [response, cross] = await Promise.all([
        crossPage.waitForResponse(
          (res) => res.url() === refreshUrl && res.request().method() === 'POST'
        ),
        crossPage.evaluate(async (base: string): Promise<{ status: number; type: string }> => {
          // no-cors keeps this a simple POST: no preflight, real Origin header,
          // and the response is opaque because the API's CORS allowlist only
          // covers host-served pages, not PUBLIC_ORIGIN clients.
          const res = await fetch(`${base}/v1/auth/refresh`, {
            method: 'POST',
            mode: 'no-cors',
            credentials: 'include',
            headers: { 'content-type': 'text/plain' },
            body: '{}'
          })
          return { status: res.status, type: res.type }
        }, always.url)
      ])
      assert.equal(response.status(), 403)
      assert.equal(cross.status, 0)
      assert.equal(cross.type, 'opaque')

      // The remote store is unreachable from this process; a same-value refresh
      // proves both refreshHash and previousRefreshHash stayed intact.
      const stillThere = await storedCookie(context)
      assert.ok(stillThere)
      assert.equal(stillThere.value, before.value)
      const recheck = await refresh(page, always.url, { contentType: 'application/json' })
      assert.equal(recheck.result.status, 200)
      assert.equal(recheck.result.body.refreshCookie, true)
    } finally {
      await context.close()
    }
  })

  test('3b. 同源但非 JSON content-type：403 且不产生任何副作用', async () => {
    const { context, page } = await openPage(always.url)
    try {
      const before = await signIn(page, always.url, 'u197-csrf-type')
      const { response, result } = await refresh(page, always.url, {
        contentType: 'text/plain',
        body: '{}'
      })
      assert.equal(result.status, 403)
      assert.equal(errorCode(result.body), 'CSRF_REJECTED')
      assert.equal(
        (await setCookieHeaders(response)).length,
        0,
        'CSRF rejection must not clear the cookie'
      )

      const stillThere = await storedCookie(context)
      assert.ok(stillThere)
      assert.equal(stillThere.value, before.value)
      const recheck = await refresh(page, always.url, { contentType: 'application/json' })
      assert.equal(recheck.result.status, 200)
    } finally {
      await context.close()
    }
  })

  test('4. 重复 Cookie 硬 401：不回退 body、不撤销 session', async () => {
    const { context, page } = await openPage(always.url)
    try {
      const before = await signIn(page, always.url, 'u197-duplicate')
      // addCookies is the only way to make a second HttpOnly cookie; page script
      // cannot write it and fetch cannot set a forbidden Cookie header.
      await context.addCookies([
        {
          name: 'orca_refresh',
          value: 'u197decoyvalue',
          domain: HOST,
          path: '/',
          httpOnly: true,
          secure: true,
          sameSite: 'Lax'
        }
      ])
      const both = await context.cookies()
      assert.deepEqual(
        both
          .filter((cookie) => cookie.name === 'orca_refresh')
          .map((cookie) => cookie.path)
          .sort(),
        ['/', '/v1/auth']
      )

      const duplicate = await refresh(page, always.url, { contentType: 'application/json' })
      assert.equal(duplicate.result.status, 401)
      assert.equal(errorCode(duplicate.result.body), 'SESSION_EXPIRED')
      assert.equal(
        (await setCookieHeaders(duplicate.response)).length,
        0,
        'a duplicate is a hard 401, not a clear'
      )

      // A valid body token must not rescue the request: no body fallback.
      const bodyFallback = await refresh(page, always.url, {
        contentType: 'application/json',
        body: JSON.stringify({ refreshToken: before.value })
      })
      assert.equal(bodyFallback.result.status, 401)
      assert.equal(errorCode(bodyFallback.result.body), 'SESSION_EXPIRED')

      // Drop only the decoy; the session must still be alive on the real cookie.
      await context.clearCookies({ name: 'orca_refresh', path: '/' })
      const remaining = await storedCookie(context)
      assert.ok(remaining)
      assert.equal(remaining.value, before.value)
      const recovered = await refresh(page, always.url, { contentType: 'application/json' })
      assert.equal(recovered.result.status, 200)
      assert.equal(recovered.result.body.refreshCookie, true)
      const after = await storedCookie(context)
      assert.ok(after)
      assert.equal(after.value, before.value)
    } finally {
      await context.close()
    }
  })

  test('5. 同一 context 多标签刷新：都 200、同值、session 不撤销', async () => {
    const { context, page } = await openPage(always.url)
    try {
      const before = await signIn(page, always.url, 'u197-multi-tab')
      const second = await context.newPage()
      await second.goto(`${always.url}/`, { waitUntil: 'domcontentloaded' })
      await second.waitForSelector('#ready')

      const [first, other] = await Promise.all([
        refresh(page, always.url, { contentType: 'application/json' }),
        refresh(second, always.url, { contentType: 'application/json' })
      ])
      for (const outcome of [first, other]) {
        assert.equal(outcome.result.status, 200)
        assert.equal(outcome.result.body.refreshCookie, true)
        assert.equal('refreshToken' in outcome.result.body, false)
      }
      const after = await storedCookie(context)
      assert.ok(after)
      assert.equal(after.value, before.value)
      const live = await refresh(page, always.url, { contentType: 'application/json' })
      assert.equal(live.result.status, 200)
    } finally {
      await context.close()
    }
  })

  test('6. never / auto 无 PUBLIC_ORIGIN：body refresh、无 Cookie、单次告警', async () => {
    const neverPage = await openPage(never.url)
    try {
      const { response, result } = await login(neverPage.page, never.url, 'u197-never')
      assert.equal(result.status, 200)
      assert.equal(typeof result.body.refreshToken, 'string')
      assert.equal('refreshCookie' in result.body, false)
      assert.equal((await setCookieHeaders(response)).length, 0)
      assert.equal(result.documentCookie.includes('orca_refresh'), false)
      assert.equal((await neverPage.context.cookies()).length, 0)
      if (typeof result.body.refreshToken === 'string') {
        observed.never.push(result.body.refreshToken)
      }
    } finally {
      await neverPage.context.close()
    }

    const autoPage = await openPage(unconfigured.url)
    try {
      const { response, result } = await login(autoPage.page, unconfigured.url, 'u197-auto')
      assert.equal(result.status, 200)
      assert.equal(typeof result.body.refreshToken, 'string')
      assert.equal('refreshCookie' in result.body, false)
      assert.equal((await setCookieHeaders(response)).length, 0)
      assert.equal((await autoPage.context.cookies()).length, 0)
      if (typeof result.body.refreshToken === 'string') {
        observed.unconfigured.push(result.body.refreshToken)
      }

      const logs = unconfigured.logs.join('')
      assert.equal(
        (logs.match(/degraded to never/g) ?? []).length,
        1,
        'auto without PUBLIC_ORIGIN must warn exactly once'
      )
      assert.equal(
        (never.logs.join('').match(/degraded to never/g) ?? []).length,
        0,
        'explicit never must not warn'
      )
    } finally {
      await autoPage.context.close()
    }
  })

  test('7. 全程审计 / 进程日志不含明文 refresh（含前缀）', async () => {
    // One more live pair so the assertion covers the freshest writes too.
    const { context, page } = await openPage(always.url)
    try {
      await signIn(page, always.url, 'u197-log-hygiene')
      const live = await refresh(page, always.url, { contentType: 'application/json' })
      assert.equal(live.result.status, 200)
    } finally {
      await context.close()
    }

    const services: [ServiceKey, Service][] = [
      ['always', always],
      ['never', never],
      ['unconfigured', unconfigured]
    ]
    for (const [key, service] of services) {
      const tokens = observed[key]
      assert.ok(tokens.length > 0, `${key}: expected at least one observed token`)
      const logs = service.logs.join('')
      const auditPath = join(workDir, `audit-${key}.log`)
      const audit = existsSync(auditPath) ? readFileSync(auditPath, 'utf8') : ''
      for (const token of tokens) {
        assert.equal(logs.includes(token), false, `${key}: full refresh token leaked to logs`)
        assert.equal(
          logs.includes(token.slice(0, 16)),
          false,
          `${key}: refresh token prefix leaked to logs`
        )
        assert.equal(audit.includes(token), false, `${key}: full refresh token leaked to audit`)
        assert.equal(
          audit.includes(token.slice(0, 16)),
          false,
          `${key}: refresh token prefix leaked to audit`
        )
      }
    }
    const alwaysAudit = readFileSync(join(workDir, 'audit-always.log'), 'utf8')
    assert.match(alwaysAudit, /"eventType":"login"/, 'the audit chain must still record logins')
  })
})
