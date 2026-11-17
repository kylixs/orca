import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createNetServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { ROOT, spawnService, type Service } from './harness.ts'

/**
 * U198 (QA-032 P2): the pre-U197 localStorage contract must still recover a
 * page reload after the access token expired. Real API (`never`, no
 * PUBLIC_ORIGIN) + real console + real Chromium: the reload has to spend the
 * stored body refresh token exactly once, rotate both tokens, and never bounce
 * to the login view while a valid refresh exists.
 */

const HOST = '127.0.0.1'
const READY = /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/
const WEB_SOURCE = join(ROOT, 'apps/web')
const USERNAME = 'admin'
const PASSWORD = 'Adm1n!'
const VIEW_APP = '#view-app'
const VIEW_LOGIN = '#view-login'
/** Long enough for the login + first render, short enough to expire before reload. */
const ACCESS_TTL_MS = 1500

type StoredAuth = {
  access: string | null
  refresh: string | null
  mode: string | null
}

/** Page-emitted traffic for the two paths U198 judges, in response order. */
type NetEvent = {
  path: '/v1/auth/refresh' | '/v1/me'
  status: number
  body: string | null
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
  workDir = mkdtempSync(join(tmpdir(), 'u198-legacy-reload-'))
  const port = await reservePort()
  api = await spawnService(
    'apps/api/src/server.ts',
    {
      PORT: String(port),
      INTERNAL_TOKEN: 'u198-legacy-reload',
      ORCA_CLOUD_COOKIE_MODE: 'never',
      // Empty string pins the value even if the developer shell exports one:
      // never + no PUBLIC_ORIGIN is the pre-U197 deployment contract.
      ORCA_CLOUD_PUBLIC_ORIGIN: '',
      ORCA_CLOUD_WEB_ROOT: WEB_SOURCE,
      ORCA_CLOUD_ACCESS_TTL_MS: String(ACCESS_TTL_MS),
      AUDIT_LOG_PATH: join(workDir, 'audit-u198.log'),
      ORCA_PLATFORM_STORE_FILE: '',
      ORCA_CLOUD_LDAP_REQUIRED_GROUP: '',
      ORCA_CLOUD_LOGIN_LOCKOUT_URL: '',
      ORCA_CLOUD_AUDIT_WRITER_URL: '',
      ORCA_CLOUD_AUDIT_WRITER_URLS: ''
    },
    READY,
    'api-u198-legacy-reload'
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

function readStoredAuth(page: Page): Promise<StoredAuth> {
  return page.evaluate(() => ({
    access: window.localStorage.getItem('orca.access'),
    refresh: window.localStorage.getItem('orca.refresh'),
    mode: window.localStorage.getItem('orca.authMode')
  }))
}

function traceNetwork(page: Page): NetEvent[] {
  const events: NetEvent[] = []
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname
    if (path !== '/v1/auth/refresh' && path !== '/v1/me') {
      return
    }
    events.push({
      path,
      status: response.status(),
      body: path === '/v1/auth/refresh' ? response.request().postData() : null
    })
  })
  return events
}

/**
 * Why a probe instead of a fixed sleep: the assertion needs the token to be
 * genuinely rejected, not merely "old enough on this machine". A raw fetch
 * bypasses app.js, so the probe itself can never start a refresh.
 */
async function waitUntilAccessExpired(page: Page, access: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const status = await page.evaluate(async (token) => {
      const res = await fetch('/v1/me', { headers: { authorization: `Bearer ${token}` } })
      return res.status
    }, access)
    if (status === 401) {
      return
    }
    await delay(200)
  }
  assert.fail('the access token never expired within 10s')
}

function refreshTokenOf(event: NetEvent): string {
  const parsed: unknown = JSON.parse(event.body ?? '{}')
  const token =
    typeof parsed === 'object' && parsed !== null && 'refreshToken' in parsed
      ? parsed.refreshToken
      : undefined
  assert.ok(typeof token === 'string', 'the body must carry refreshToken')
  return token
}

describe('U198 旧 localStorage 模式：access 过期后 reload 仍用 refresh 恢复', () => {
  test('reload 恰一次 body 刷新进入工作台，access/refresh 轮换，tokenOwner 回填', async () => {
    const { context, page } = await openConsole()
    try {
      await loginThroughUi(page)
      const before = await readStoredAuth(page)
      assert.equal(before.mode, null, 'never mode must not write the Cookie marker')
      assert.ok(before.access, 'legacy login must persist access')
      assert.ok(before.refresh, 'legacy login must persist refresh')

      await waitUntilAccessExpired(page, before.access)

      const events = traceNetwork(page)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForSelector(VIEW_APP, { state: 'visible', timeout: 20_000 })
      // Any second refresh chain or bounce would land inside this window.
      await delay(300)

      const refreshes = events.filter((event) => event.path === '/v1/auth/refresh')
      assert.equal(refreshes.length, 1, 'the reload must refresh exactly once')
      assert.equal(refreshes[0].status, 200, 'the stored body token must still be valid')
      assert.equal(
        refreshTokenOf(refreshes[0]),
        before.refresh,
        'the refresh request must carry the stored refreshToken'
      )

      const meCalls = events.filter((event) => event.path === '/v1/me')
      assert.deepEqual(
        meCalls.map((event) => event.status),
        [401, 200],
        'the expired probe is rejected once and the replay succeeds'
      )
      assert.deepEqual(
        events.map((event) => `${event.path}:${event.status}`),
        ['/v1/me:401', '/v1/auth/refresh:200', '/v1/me:200'],
        'order: expired /v1/me → body refresh → successful replay'
      )

      assert.equal(await page.locator(VIEW_LOGIN).isVisible(), false, 'no bounce to login')

      const after = await readStoredAuth(page)
      assert.ok(after.access, 'the refreshed access token is persisted')
      assert.notEqual(after.access, before.access, 'the access token must rotate')
      assert.ok(after.refresh, 'the rotated refresh token is persisted')
      assert.notEqual(after.refresh, before.refresh, 'the refresh token must rotate')
      assert.equal(after.mode, null, 'a never server must not teach the Cookie marker')
      assert.equal(
        await page.evaluate(() => window.localStorage.getItem('orca.tokenOwner')),
        USERNAME,
        'U225 N3: the startup body refresh binds the restored keys to the account'
      )
    } finally {
      await context.close()
    }
  })

  test('负例：失效 refresh + 过期 access，reload 恰一次 401 刷新后回登录，无循环', async () => {
    const { context, page } = await openConsole()
    try {
      await loginThroughUi(page)
      const before = await readStoredAuth(page)
      assert.ok(before.access)
      assert.ok(before.refresh)
      const invalidRefresh = 'u198-invalid-refresh-token'
      await page.evaluate((value) => {
        window.localStorage.setItem('orca.refresh', value)
      }, invalidRefresh)

      await waitUntilAccessExpired(page, before.access)

      const events = traceNetwork(page)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForSelector(VIEW_LOGIN, { state: 'visible', timeout: 20_000 })
      // A refresh loop would emit another request inside this window.
      await delay(900)

      const refreshes = events.filter((event) => event.path === '/v1/auth/refresh')
      assert.equal(refreshes.length, 1, 'a failed recovery must not loop')
      assert.equal(
        refreshTokenOf(refreshes[0]),
        invalidRefresh,
        'the reload must spend the stored (invalid) body token once'
      )
      assert.deepEqual(
        refreshes.map((event) => event.status),
        [401],
        'the server must reject the invalid refresh token'
      )

      assert.equal(await page.locator(VIEW_APP).isVisible(), false)
      assert.equal(await page.locator(VIEW_LOGIN).isVisible(), true, 'the user lands on login')

      const after = await readStoredAuth(page)
      assert.equal(after.access, null, 'a rejected refresh clears the dead access token')
      assert.equal(after.refresh, null, 'a rejected refresh clears the dead refresh token')
    } finally {
      await context.close()
    }
  })
})
