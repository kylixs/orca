import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp, type ApiHandle } from '../../apps/api/src/server.ts'
import { loadWebConsolePage } from './web-console-page.ts'

/**
 * U229 F4/F10 + U230③: the Web client must not read a grace echo as an old
 * server, must hand the server a logout locator in legacy mode, and must only
 * sign out on a session verdict (not on every replayed 401).
 */

const apps: ApiHandle[] = []

async function start(
  options: {
    accessTtlMs?: number
    refreshGraceMs?: number
    cookieMode?: string
    publicOrigin?: string
  } = {}
): Promise<string> {
  const app = createApp({
    port: 0,
    accessTtlMs: options.accessTtlMs ?? 60_000,
    refreshTtlMs: 60_000,
    refreshGraceMs: options.refreshGraceMs ?? 0,
    internalToken: 'u229-web-logout-grace',
    cookieMode: options.cookieMode ?? 'never',
    publicOrigin: options.publicOrigin ?? ''
  })
  apps.push(app)
  const port = await app.listen()
  return `http://127.0.0.1:${port}`
}

async function login(base: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'u229-grace' })
  })
  assert.equal(res.status, 200)
  return (await res.json()) as Record<string, unknown>
}

function refresh(base: string, refreshToken: string): Promise<Response> {
  return fetch(`${base}/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken })
  })
}

function stringField(body: Record<string, unknown>, name: string): string {
  const value = body[name]
  if (typeof value !== 'string' || value === '') throw new Error(`${name} missing`)
  return value
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

after(async () => {
  await Promise.all(apps.map((app) => app.close()))
})

describe('U229 F4 grace 回显不得抹标记/持久化 previous', () => {
  test('body 回退命中 grace 回显：保留 cookie 标记与旧键，仅内存更新 access', async () => {
    const base = await start({
      cookieMode: 'auto',
      accessTtlMs: 300,
      refreshGraceMs: 10_000
    })
    const first = await login(base)
    const previous = stringField(first, 'refreshToken')
    // Rotate once: `previous` is now the grace token and no longer current.
    const rotated = await refresh(base, previous)
    assert.equal(rotated.status, 200)
    await delay(400)

    const page = loadWebConsolePage(base, {
      storage: {
        'orca.authMode': 'cookie',
        'orca.refresh': previous,
        'orca.tokenOwner': 'admin',
        'orca.user': JSON.stringify({ username: 'admin' })
      }
    })
    await page.settle()

    assert.equal(page.hidden('#view-app'), false, 'the grace echo still renews the access')
    assert.equal(
      page.window.localStorage.getItem('orca.authMode'),
      'cookie',
      'a grace echo is not proof of an old server'
    )
    assert.equal(
      page.window.localStorage.getItem('orca.access'),
      null,
      'Cookie mode must never persist the access token'
    )
    assert.equal(
      page.window.localStorage.getItem('orca.refresh'),
      previous,
      'the stored key must not be rewritten by a grace echo'
    )
    assert.equal(page.window.localStorage.getItem('orca.tokenOwner'), 'admin')
  })
})

describe('U229 F10 legacy 登出携带 refreshToken', () => {
  test('access 过期后登出：请求 body 携带 refresh，服务端撤销（随后刷新 401）', async () => {
    const base = await start({ accessTtlMs: 800 })
    const page = loadWebConsolePage(base)
    await page.settle()
    await page.submitLogin('admin', 'Adm1n!')
    assert.equal(page.hidden('#view-app'), false)
    // Let the access token lapse so only the body locator can identify the session.
    await delay(1000)

    const refreshBefore = page.window.localStorage.getItem('orca.refresh')
    assert.ok(refreshBefore)

    page.window.document.querySelector<HTMLElement>('#logoutBtn')!.click()
    await page.settle()

    const calls = page.calls()
    const index = calls.indexOf('POST /v1/auth/logout')
    assert.notEqual(index, -1, 'logout must reach the server')
    assert.equal(page.statuses()[index], 200)
    assert.equal(
      page.headerValues('content-type')[index],
      'application/json',
      'a body logout must declare JSON'
    )
    const logoutBody = page.bodies().find((entry) => entry.call === 'POST /v1/auth/logout')
    assert.ok(logoutBody, 'the legacy logout must carry a body')
    assert.deepEqual(logoutBody.body, { refreshToken: refreshBefore })

    assert.equal(
      (await refresh(base, refreshBefore)).status,
      401,
      'the body token must have revoked the session'
    )
  })
})

describe('U230③ 重放 401 只在 SESSION_EXPIRED 时登出', () => {
  test('非 SESSION_EXPIRED 的重放 401 交给调用方，不清理会话', async () => {
    const base = await start({ accessTtlMs: 1000 })
    const page = loadWebConsolePage(base)
    await page.settle()
    await page.submitLogin('admin', 'Adm1n!')
    await delay(1300)

    page.hold('POST', '/v1/auth/refresh')
    await page.clickNav('relays')
    assert.equal(
      page.calls().filter((call) => call === 'POST /v1/auth/refresh').length,
      1,
      'the 401 started one held refresh'
    )

    // The replay is answered with a non-session verdict on the same path.
    page.fail('GET', '/v1/relays', {
      status: 401,
      body: { error: { code: 'TENANT_MISMATCH', message: '租户不匹配' } }
    })
    await page.release()
    await page.settle()

    assert.equal(page.hidden('#view-login'), true, 'a tenant 401 must not sign out')
    assert.equal(page.hidden('#view-app'), false)
    assert.ok(page.window.localStorage.getItem('orca.access'), 'the refreshed session must survive')
    assert.match(page.text('#content'), /租户不匹配/)

    // The session still serves later calls.
    page.clearFails()
    await page.clickNav('projects')
    assert.equal(page.hidden('#view-app'), false)
    assert.equal(page.hidden('#view-login'), true)
  })
})
