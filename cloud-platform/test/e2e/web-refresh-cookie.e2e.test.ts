import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp, type ApiHandle } from '../../apps/api/src/server.ts'
import { loadWebConsolePage } from './web-console-page.ts'

/**
 * U197 S4: the Web client switches to the HttpOnly Cookie transport only when a
 * response actually proves it (`refreshCookie: true`). The default path (old
 * server / never mode) must stay byte-for-byte on localStorage.
 */

const ORIGIN = 'https://web.console.local'
const apps: ApiHandle[] = []

async function start(
  options: {
    cookieMode?: string
    publicOrigin?: string
    accessTtlMs?: number
  } = {}
): Promise<string> {
  const app = createApp({
    port: 0,
    accessTtlMs: options.accessTtlMs ?? 60_000,
    refreshTtlMs: 60_000,
    internalToken: 'u197-s4-token',
    cookieMode: options.cookieMode ?? 'auto',
    // Empty string pins "unconfigured" even if the developer shell exports one.
    publicOrigin: options.publicOrigin ?? ''
  })
  apps.push(app)
  const port = await app.listen()
  return `http://127.0.0.1:${port}`
}

/** A legacy browser has no Origin, so the server keeps the body-token contract. */
async function legacyTokens(base: string): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await fetch(`${base}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'legacy' })
  })
  assert.equal(res.status, 200)
  const body = (await res.json()) as Record<string, unknown>
  assert.equal('refreshCookie' in body, false)
  return {
    accessToken: String(body.accessToken),
    refreshToken: String(body.refreshToken)
  }
}

function refreshCalls(page: ReturnType<typeof loadWebConsolePage>): string[] {
  return page.calls().filter((call) => call === 'POST /v1/auth/refresh')
}

function refreshBodies(page: ReturnType<typeof loadWebConsolePage>) {
  return page.bodies().filter((entry) => entry.call === 'POST /v1/auth/refresh')
}

after(async () => {
  await Promise.all(apps.map((app) => app.close()))
})

describe('U197 S4 Web Cookie mode（happy-dom + 真实 createApp）', () => {
  test('无 refreshCookie 标记时保持 localStorage 契约', async () => {
    const base = await start()
    const page = loadWebConsolePage(base)
    await page.settle()
    await page.submitLogin('admin', 'Adm1n!')

    assert.equal(page.hidden('#view-app'), false)
    assert.ok(page.window.localStorage.getItem('orca.access'), 'access must stay persisted')
    assert.ok(page.window.localStorage.getItem('orca.refresh'), 'refresh must stay persisted')
    assert.equal(page.window.localStorage.getItem('orca.authMode'), null)
    assert.equal(refreshCalls(page).length, 0, 'login must not probe refresh')
  })

  test('refreshCookie:true → access 仅内存、不写入新 refresh', async () => {
    const base = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const jar = new Map<string, string>()
    const page = loadWebConsolePage(base, {
      platformOrigin: ORIGIN,
      cookieJar: jar,
      storage: { 'orca.refresh': 'legacy-refresh' }
    })
    await page.settle()
    await page.submitLogin('admin', 'Adm1n!')

    assert.equal(page.hidden('#view-app'), false)
    // The old key is evidence of an unfinished migration: keep it, but never
    // overwrite it with the server-issued Cookie token.
    assert.equal(page.window.localStorage.getItem('orca.refresh'), 'legacy-refresh')
    assert.equal(page.window.localStorage.getItem('orca.access'), null)
    assert.equal(page.window.localStorage.getItem('orca.authMode'), 'cookie')
    assert.ok(jar.get('orca_refresh'), 'login must set the HttpOnly cookie')

    const auths = page.authHeaders().filter((value) => value !== undefined)
    assert.ok(auths.length > 0)
    assert.ok(
      auths.every((value) => !value.includes('legacy-access')),
      'requests must use the in-memory access, not a persisted one'
    )
  })

  test('页面重载：一次无 body Cookie 刷新恢复，之后才删除旧键', async () => {
    const base = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const jar = new Map<string, string>()
    const first = loadWebConsolePage(base, { platformOrigin: ORIGIN, cookieJar: jar })
    await first.settle()
    await first.submitLogin('admin', 'Adm1n!')
    assert.ok(jar.get('orca_refresh'))

    const second = loadWebConsolePage(base, {
      platformOrigin: ORIGIN,
      cookieJar: jar,
      storage: { 'orca.refresh': 'legacy-refresh', 'orca.authMode': 'cookie' }
    })
    await second.settle()

    assert.equal(second.hidden('#view-app'), false)
    assert.equal(second.window.localStorage.getItem('orca.refresh'), null, 'old key removed')
    assert.equal(second.window.localStorage.getItem('orca.access'), null)
    assert.equal(second.window.localStorage.getItem('orca.authMode'), 'cookie')
    assert.equal(refreshCalls(second).length, 1, 'one no-body refresh only')
    assert.equal(refreshBodies(second).length, 0, 'the recovery refresh carries no body')
  })

  test('无旧键：仅 Cookie 恢复；Cookie 缺失时一次失败后回登录', async () => {
    const base = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const jar = new Map<string, string>()
    const first = loadWebConsolePage(base, { platformOrigin: ORIGIN, cookieJar: jar })
    await first.settle()
    await first.submitLogin('admin', 'Adm1n!')
    assert.ok(jar.get('orca_refresh'))

    const recovered = loadWebConsolePage(base, {
      platformOrigin: ORIGIN,
      cookieJar: jar,
      storage: { 'orca.authMode': 'cookie' }
    })
    await recovered.settle()
    assert.equal(recovered.hidden('#view-app'), false, 'the Cookie alone restores the session')
    assert.equal(refreshCalls(recovered).length, 1)
    assert.equal(refreshBodies(recovered).length, 0)

    const missing = loadWebConsolePage(base, {
      platformOrigin: ORIGIN,
      cookieJar: new Map(),
      storage: { 'orca.authMode': 'cookie' }
    })
    await missing.settle()
    assert.equal(missing.hidden('#view-login'), false)
    assert.equal(refreshCalls(missing).length, 1, 'no body token means no second attempt')
    assert.equal(refreshBodies(missing).length, 0)
  })

  test('Cookie 刷新失败 → 用旧键 body 回退一次，成功时保留旧键', async () => {
    const base = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const legacy = await legacyTokens(base)
    const page = loadWebConsolePage(base, {
      platformOrigin: ORIGIN,
      cookieJar: new Map(),
      storage: { 'orca.refresh': legacy.refreshToken, 'orca.authMode': 'cookie' }
    })
    await page.settle()

    assert.equal(page.hidden('#view-app'), false)
    assert.equal(refreshCalls(page).length, 2, 'one cookie attempt then one body fallback')
    const bodies = refreshBodies(page)
    assert.equal(bodies.length, 1)
    assert.equal((bodies[0]?.body as Record<string, unknown>).refreshToken, legacy.refreshToken)
    // No no-body success yet, so the legacy key must survive.
    assert.equal(page.window.localStorage.getItem('orca.refresh'), legacy.refreshToken)
    assert.equal(page.window.localStorage.getItem('orca.access'), null)
  })

  test('Cookie 与 body 回退均失败 → 登录页、保留旧键、不循环', async () => {
    const base = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const page = loadWebConsolePage(base, {
      platformOrigin: ORIGIN,
      cookieJar: new Map(),
      storage: { 'orca.refresh': 'expired-refresh', 'orca.authMode': 'cookie' }
    })
    await page.settle()

    assert.equal(page.hidden('#view-login'), false)
    assert.equal(page.hidden('#view-app'), true)
    assert.equal(page.window.localStorage.getItem('orca.refresh'), 'expired-refresh')
    assert.equal(refreshCalls(page).length, 2, 'exactly one cookie + one body attempt')
    assert.equal(refreshBodies(page).length, 1)
  })

  test('Cookie 模式页内 401 在没有 refreshToken 时也触发一次 Cookie 刷新', async () => {
    const base = await start({
      cookieMode: 'auto',
      publicOrigin: ORIGIN,
      accessTtlMs: 1200
    })
    const jar = new Map<string, string>()
    const page = loadWebConsolePage(base, { platformOrigin: ORIGIN, cookieJar: jar })
    await page.settle()
    await page.submitLogin('admin', 'Adm1n!')
    assert.equal(page.hidden('#view-app'), false)
    assert.equal(page.window.localStorage.getItem('orca.refresh'), null, 'no body token available')

    await new Promise((resolve) => setTimeout(resolve, 1500))
    const before = refreshCalls(page).length
    await page.clickNav('relays')

    assert.equal(refreshCalls(page).length - before, 1, 'one Cookie refresh for the 401')
    assert.equal(
      refreshBodies(page).length,
      0,
      'Cookie mode never falls back to a body refresh without a legacy key'
    )
    assert.equal(page.hidden('#view-app'), false, 'the user stays signed in')
    assert.match(page.text('#content'), /中继/, 'the original request is replayed')
  })

  test('登出清理内存、旧键与 Cookie 模式标记', async () => {
    const base = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const jar = new Map<string, string>()
    const page = loadWebConsolePage(base, {
      platformOrigin: ORIGIN,
      cookieJar: jar,
      storage: { 'orca.refresh': 'legacy-refresh' }
    })
    await page.settle()
    await page.submitLogin('admin', 'Adm1n!')
    assert.equal(page.window.localStorage.getItem('orca.authMode'), 'cookie')

    page.window.document.querySelector<HTMLElement>('#logoutBtn')!.click()
    await page.settle()

    assert.equal(page.hidden('#view-login'), false)
    assert.equal(page.window.localStorage.getItem('orca.access'), null)
    assert.equal(page.window.localStorage.getItem('orca.refresh'), null)
    assert.equal(page.window.localStorage.getItem('orca.authMode'), null)
    assert.equal(jar.has('orca_refresh'), false, 'logout must clear the refresh Cookie')
  })
})
