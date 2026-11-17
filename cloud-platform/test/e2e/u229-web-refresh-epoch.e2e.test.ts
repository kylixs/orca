import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp, type ApiHandle } from '../../apps/api/src/server.ts'
import { loadWebConsolePage, type WebConsolePage } from './web-console-page.ts'

/**
 * U229 F1/F2: a refresh result belongs to the auth epoch that started it, and an
 * ownerless legacy refresh key is never a body-fallback credential.
 */

const ORIGIN = 'https://web.u229.local'
const apps: ApiHandle[] = []

async function start(
  options: { cookieMode?: string; publicOrigin?: string; accessTtlMs?: number } = {}
): Promise<string> {
  const app = createApp({
    port: 0,
    accessTtlMs: options.accessTtlMs ?? 60_000,
    refreshTtlMs: 60_000,
    internalToken: 'u229-web-token',
    cookieMode: options.cookieMode ?? 'auto',
    publicOrigin: options.publicOrigin ?? ''
  })
  apps.push(app)
  const port = await app.listen()
  return `http://127.0.0.1:${port}`
}

async function legacyTokens(
  base: string,
  username = 'zhangsan',
  password = 'Passw0rd!'
): Promise<{ refreshToken: string }> {
  const res = await fetch(`${base}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, deviceName: 'legacy' })
  })
  assert.equal(res.status, 200)
  const body = (await res.json()) as Record<string, unknown>
  return { refreshToken: String(body.refreshToken) }
}

function refreshCalls(page: WebConsolePage): string[] {
  return page.calls().filter((call) => call === 'POST /v1/auth/refresh')
}

function refreshBodies(page: WebConsolePage) {
  return page.bodies().filter((entry) => entry.call === 'POST /v1/auth/refresh')
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function meUsername(base: string, accessToken: string): Promise<string> {
  const res = await fetch(`${base}/v1/me`, {
    headers: { authorization: `Bearer ${accessToken}` }
  })
  assert.equal(res.status, 200)
  const body = (await res.json()) as { user: { username: string } }
  return body.user.username
}

after(async () => {
  await Promise.all(apps.map((app) => app.close()))
})

describe('U229 F1 刷新代际', () => {
  test('F1a 刷新在途时登出：旧结果被丢弃，重载停在登录页', async () => {
    const base = await start({ cookieMode: 'never', accessTtlMs: 1000 })
    const page = loadWebConsolePage(base)
    await page.settle()
    await page.submitLogin('admin', 'Adm1n!')
    assert.equal(page.hidden('#view-app'), false)

    await delay(1300)
    page.hold('POST', '/v1/auth/refresh')
    await page.clickNav('relays')
    assert.equal(refreshCalls(page).length, 1, 'the 401 started one held refresh')

    page.window.document.querySelector<HTMLElement>('#logoutBtn')!.click()
    await page.settle()
    assert.equal(page.hidden('#view-login'), false)

    await page.release()
    await page.settle()

    assert.equal(page.window.localStorage.getItem('orca.access'), null, 'logout must stay final')
    assert.equal(page.window.localStorage.getItem('orca.refresh'), null)
    assert.equal(page.window.localStorage.getItem('orca.tokenOwner'), null)

    // The next load must not auto-enter with tokens written by the stale refresh.
    const reload = loadWebConsolePage(base)
    await reload.settle()
    assert.equal(reload.hidden('#view-login'), false)
    assert.equal(reload.hidden('#view-app'), true)
  })

  test('F1b 刷新在途时登出并登录另一账号：旧结果不得覆盖新会话', async () => {
    // U231 P3: ≥5000ms leaves room for login + held refresh + a second login on
    // a slow runner; the previous 2500ms could lapse mid-assertion (false red).
    const base = await start({ cookieMode: 'never', accessTtlMs: 6000 })
    const page = loadWebConsolePage(base)
    await page.settle()
    await page.submitLogin('admin', 'Adm1n!')
    assert.equal(page.hidden('#view-app'), false)

    await delay(6300)
    page.hold('POST', '/v1/auth/refresh')
    await page.clickNav('relays')
    assert.equal(refreshCalls(page).length, 1)

    page.window.document.querySelector<HTMLElement>('#logoutBtn')!.click()
    await page.settle()
    await page.submitLogin('zhangsan', 'Passw0rd!')
    assert.equal(page.hidden('#view-app'), false)

    const accessAfterLogin = page.window.localStorage.getItem('orca.access')
    const refreshAfterLogin = page.window.localStorage.getItem('orca.refresh')
    assert.ok(accessAfterLogin)
    assert.ok(refreshAfterLogin)
    assert.equal(page.window.localStorage.getItem('orca.tokenOwner'), 'zhangsan')

    await page.release()
    await page.settle()

    assert.equal(
      page.window.localStorage.getItem('orca.access'),
      accessAfterLogin,
      'the stale refresh must not overwrite the new access token'
    )
    assert.equal(
      page.window.localStorage.getItem('orca.refresh'),
      refreshAfterLogin,
      'the stale refresh must not overwrite the new refresh token'
    )
    assert.equal(page.window.localStorage.getItem('orca.tokenOwner'), 'zhangsan')
    assert.equal(
      await meUsername(base, accessAfterLogin),
      'zhangsan',
      'the stored access token must belong to the latest login'
    )
  })

  test('E1 并发 401 仍共享一次刷新', async () => {
    const base = await start({ accessTtlMs: 1000 })
    const page = loadWebConsolePage(base)
    await page.settle()
    await page.submitLogin('admin', 'Adm1n!')
    await delay(1300)

    const before = refreshCalls(page).length
    await Promise.all([page.clickNav('relays'), page.clickNav('projects')])
    assert.equal(refreshCalls(page).length - before, 1, 'parallel 401s share one refresh')
    assert.equal(page.hidden('#view-app'), false)
  })
})

describe('U229 F2 无 owner 旧键不得跨账号回退', () => {
  test('F2 登录新账号时清除无 owner 旧键，Cookie 丢失后不进入旧账号', async () => {
    const base = await start({
      cookieMode: 'auto',
      publicOrigin: ORIGIN,
      accessTtlMs: 1000
    })
    const other = await legacyTokens(base)
    const jar = new Map<string, string>()
    const page = loadWebConsolePage(base, {
      platformOrigin: ORIGIN,
      cookieJar: jar,
      storage: { 'orca.refresh': other.refreshToken }
    })
    await page.settle()
    await page.submitLogin('admin', 'Adm1n!')
    assert.equal(page.hidden('#view-app'), false)
    assert.equal(
      page.window.localStorage.getItem('orca.refresh'),
      null,
      'an ownerless key from another account must not survive the login'
    )
    assert.equal(page.window.localStorage.getItem('orca.tokenOwner'), null)

    // Cookie lost (blocked/cleared). The old account's key must not revive it.
    jar.delete('orca_refresh')
    await delay(1300)
    await page.clickNav('relays')
    await page.settle()

    assert.equal(
      refreshBodies(page).length,
      0,
      'there is no trusted body credential to fall back to'
    )
    const userName = page.window.document.querySelector('#userName')?.textContent ?? ''
    assert.notEqual(userName, '张伟', 'the previous account must never be resumed')

    const reload = loadWebConsolePage(base, {
      platformOrigin: ORIGIN,
      cookieJar: jar,
      storage: { 'orca.authMode': 'cookie' }
    })
    await reload.settle()
    assert.equal(reload.hidden('#view-login'), false, 'reload must land on login')
    assert.equal(reload.hidden('#view-app'), true)
    assert.equal(reload.window.localStorage.getItem('orca.refresh'), null)
  })

  test('F2 Cookie 模式启动且无 owner：删除旧键，不做 body 回退', async () => {
    const base = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const other = await legacyTokens(base)
    const page = loadWebConsolePage(base, {
      platformOrigin: ORIGIN,
      cookieJar: new Map(),
      storage: { 'orca.authMode': 'cookie', 'orca.refresh': other.refreshToken }
    })
    await page.settle()

    assert.equal(page.hidden('#view-login'), false)
    assert.equal(page.hidden('#view-app'), true)
    assert.equal(refreshCalls(page).length, 1, 'only the no-body Cookie probe runs')
    assert.equal(refreshBodies(page).length, 0, 'no body fallback for an ownerless key')
    assert.equal(page.window.localStorage.getItem('orca.refresh'), null)
    assert.equal(page.window.localStorage.getItem('orca.tokenOwner'), null)
  })

  test('AC9a owner 与缓存用户一致时仍允许 body 回退并保留旧键', async () => {
    const base = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const legacy = await legacyTokens(base, 'admin', 'Adm1n!')
    const page = loadWebConsolePage(base, {
      platformOrigin: ORIGIN,
      cookieJar: new Map(),
      storage: {
        'orca.authMode': 'cookie',
        'orca.refresh': legacy.refreshToken,
        'orca.tokenOwner': 'admin',
        'orca.user': JSON.stringify({ username: 'admin' })
      }
    })
    await page.settle()

    assert.equal(page.hidden('#view-app'), false)
    assert.equal(refreshCalls(page).length, 2, 'one Cookie probe plus one body fallback')
    assert.equal(refreshBodies(page).length, 1)
    assert.equal(page.window.localStorage.getItem('orca.refresh'), legacy.refreshToken)
  })

  test('U231 AC9b owner 有值但 user 缓存缺失：仍允许 body 回退并保留旧键', async () => {
    const base = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const legacy = await legacyTokens(base, 'admin', 'Adm1n!')
    const page = loadWebConsolePage(base, {
      platformOrigin: ORIGIN,
      cookieJar: new Map(),
      storage: {
        'orca.authMode': 'cookie',
        'orca.refresh': legacy.refreshToken,
        // Owner is the static binding; a startup transport failure may have
        // dropped the `orca.user` cache without invalidating these keys.
        'orca.tokenOwner': 'admin'
      }
    })
    await page.settle()

    assert.equal(page.hidden('#view-app'), false)
    assert.equal(refreshCalls(page).length, 2, 'one Cookie probe plus one body fallback')
    assert.equal(refreshBodies(page).length, 1)
    assert.equal(
      page.window.localStorage.getItem('orca.refresh'),
      legacy.refreshToken,
      'an owner-bound key must not be cleared just because the user cache is gone'
    )
  })
})
