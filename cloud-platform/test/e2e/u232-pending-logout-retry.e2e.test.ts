import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp, type ApiHandle } from '../../apps/api/src/server.ts'
import { loadWebConsolePage, type WebConsolePage } from './web-console-page.ts'

/**
 * U232: `orca.pendingLogout` is a server-reachability marker, not a UI flag.
 * A failed login attempt must leave it in place so the next load still retries
 * the logout; only a successful login may drop it.
 */

const apps: ApiHandle[] = []

async function start(): Promise<string> {
  const app = createApp({
    port: 0,
    accessTtlMs: 60_000,
    refreshTtlMs: 60_000,
    internalToken: 'u232-token',
    // Empty string pins "unconfigured" so the legacy localStorage contract runs.
    publicOrigin: ''
  })
  apps.push(app)
  const port = await app.listen()
  return `http://127.0.0.1:${port}`
}

/** A valid old-mode session, so the retried logout has a real credential to send. */
async function legacyTokens(base: string): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await fetch(`${base}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'legacy' })
  })
  assert.equal(res.status, 200)
  const body = (await res.json()) as Record<string, unknown>
  return { accessToken: String(body.accessToken), refreshToken: String(body.refreshToken) }
}

function callStatuses(page: WebConsolePage, call: string): (number | undefined)[] {
  const calls = page.calls()
  return page.statuses().filter((_, index) => calls[index] === call)
}

function countCalls(page: WebConsolePage, call: string): number {
  return page.calls().filter((entry) => entry === call).length
}

/** Loads a page that owes a logout and answers that retry with 500. */
async function loadWithFailedLogoutRetry(base: string): Promise<WebConsolePage> {
  const legacy = await legacyTokens(base)
  const page = loadWebConsolePage(base, {
    storage: {
      'orca.pendingLogout': '1',
      'orca.access': legacy.accessToken,
      'orca.refresh': legacy.refreshToken
    },
    failOnLoad: [{ call: 'POST /v1/auth/logout', status: 500 }]
  })
  await page.settle()
  return page
}

after(async () => {
  await Promise.all(apps.map((app) => app.close()))
})

describe('U232 pendingLogout 重试与登录失败（happy-dom + 真实 createApp）', () => {
  test('启动先显示登录页，后台补发一次 logout；500 失败保留标记', async () => {
    const base = await start()
    const page = await loadWithFailedLogoutRetry(base)

    assert.equal(page.hidden('#view-login'), false, 'the login view must be visible')
    assert.equal(page.hidden('#view-app'), true, 'a pending logout must not auto-enter')
    assert.equal(countCalls(page, 'POST /v1/auth/logout'), 1, 'exactly one retried logout')
    assert.deepEqual(callStatuses(page, 'POST /v1/auth/logout'), [500])
    assert.equal(countCalls(page, 'POST /v1/auth/refresh'), 0, 'no session probe while pending')
    assert.equal(countCalls(page, 'GET /v1/me'), 0)
    assert.equal(
      page.window.localStorage.getItem('orca.pendingLogout'),
      '1',
      'an unanswered logout keeps the marker'
    )
  })

  test('错误密码登录失败不清除 pendingLogout，正确密码成功后清除', async () => {
    const base = await start()
    const page = await loadWithFailedLogoutRetry(base)
    assert.equal(page.window.localStorage.getItem('orca.pendingLogout'), '1', 'precondition')

    await page.submitLogin('admin', 'Wr0ng!')
    assert.equal(page.hidden('#view-login'), false, 'a failed login stays on the form')
    assert.equal(page.hidden('#view-app'), true)
    assert.equal(countCalls(page, 'POST /v1/auth/login'), 1)
    assert.deepEqual(callStatuses(page, 'POST /v1/auth/login'), [401])
    assert.equal(
      page.window.localStorage.getItem('orca.pendingLogout'),
      '1',
      'a failed attempt must leave the logout owed for the next load'
    )

    await page.submitLogin('admin', 'Adm1n!')
    assert.equal(page.hidden('#view-app'), false)
    assert.equal(page.hidden('#view-login'), true)
    assert.equal(countCalls(page, 'POST /v1/auth/login'), 2)
    assert.deepEqual(callStatuses(page, 'POST /v1/auth/login'), [401, 200])
    assert.equal(
      page.window.localStorage.getItem('orca.pendingLogout'),
      null,
      'a successful login supersedes the owed logout'
    )
    assert.equal(countCalls(page, 'POST /v1/auth/logout'), 1, 'the success adds no logout')
  })
})
