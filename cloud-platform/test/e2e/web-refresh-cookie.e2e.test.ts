import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp, type ApiHandle } from '../../apps/api/src/server.ts'
import { loadWebConsolePage, type WebConsolePage } from './web-console-page.ts'

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

function refreshStatuses(page: WebConsolePage): (number | undefined)[] {
  const calls = page.calls()
  return page.statuses().filter((_, index) => calls[index] === 'POST /v1/auth/refresh')
}

function storedAuth(page: WebConsolePage): {
  access: string | null
  refresh: string | null
  mode: string | null
} {
  return {
    access: page.window.localStorage.getItem('orca.access'),
    refresh: page.window.localStorage.getItem('orca.refresh'),
    mode: page.window.localStorage.getItem('orca.authMode')
  }
}

/** Contract header values for one call kind, aligned with `page.calls()`. */
function contractValues(page: WebConsolePage, call: string): (string | undefined)[] {
  const calls = page.calls()
  return page
    .headerValues('x-orca-web-contract')
    .filter((_, index) => calls[index] === call)
}

after(async () => {
  await Promise.all(apps.map((app) => app.close()))
})

describe('U197 S4 Web Cookie mode（happy-dom + 真实 createApp）', () => {
  test('无 refreshCookie 标记时保持 localStorage 契约', async () => {
    const base = await start()
    const page = loadWebConsolePage(base)
    await page.settle()
    // AC9c: an unknown capability probes the Cookie once before the login view.
    assert.equal(refreshCalls(page).length, 1, 'one unproven-capability probe')
    const probesBeforeLogin = refreshCalls(page).length
    await page.submitLogin('admin', 'Adm1n!')

    assert.equal(page.hidden('#view-app'), false)
    assert.ok(page.window.localStorage.getItem('orca.access'), 'access must stay persisted')
    assert.ok(page.window.localStorage.getItem('orca.refresh'), 'refresh must stay persisted')
    assert.equal(
      page.window.localStorage.getItem('orca.authMode'),
      'legacy',
      'a login without the marker confirms the localStorage contract'
    )
    assert.equal(refreshCalls(page).length, probesBeforeLogin, 'login must not probe refresh')
  })

  test('refreshCookie:true → access 仅内存、不写入新 refresh', async () => {
    const base = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const jar = new Map<string, string>()
    const page = loadWebConsolePage(base, {
      platformOrigin: ORIGIN,
      cookieJar: jar,
      // U229 F2: only an owner match may survive a login as a migration path.
      storage: { 'orca.refresh': 'legacy-refresh', 'orca.tokenOwner': 'admin' }
    })
    await page.settle()
    assert.equal(page.window.localStorage.getItem('orca.access'), null, 'precondition')
    // U221 F6: seed the persisted token after load but before login, so a
    // request that read localStorage per call would visibly send it. The login
    // response's token is the only legitimate Bearer from here on.
    page.window.localStorage.setItem('orca.access', 'legacy-access')
    await page.submitLogin('admin', 'Adm1n!')

    assert.equal(page.hidden('#view-app'), false)
    // The old key is evidence of an unfinished migration: keep it, but never
    // overwrite it with the server-issued Cookie token.
    assert.equal(page.window.localStorage.getItem('orca.refresh'), 'legacy-refresh')
    assert.equal(page.window.localStorage.getItem('orca.access'), 'legacy-access')
    assert.equal(page.window.localStorage.getItem('orca.authMode'), 'cookie')
    assert.ok(jar.get('orca_refresh'), 'login must set the HttpOnly cookie')

    const loginIndex = page.calls().indexOf('POST /v1/auth/login')
    const auths = page
      .authHeaders()
      .slice(loginIndex + 1)
      .filter((value) => value !== undefined)
    assert.ok(auths.length > 0, 'post-login requests must carry a Bearer')
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
      // U229 F2: AC9a migration requires the key's owner to match the cached user.
      storage: {
        'orca.refresh': legacy.refreshToken,
        'orca.authMode': 'cookie',
        'orca.tokenOwner': 'admin',
        'orca.user': JSON.stringify({ username: 'admin' })
      }
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
      // U229 F2: a trusted owner keeps the one-shot body fallback.
      storage: {
        'orca.refresh': 'expired-refresh',
        'orca.authMode': 'cookie',
        'orca.tokenOwner': 'admin',
        'orca.user': JSON.stringify({ username: 'admin' })
      }
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
      // U229 F2: only an owner match may survive a login as a migration path.
      storage: { 'orca.refresh': 'legacy-refresh', 'orca.tokenOwner': 'admin' }
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
    assert.equal(page.window.localStorage.getItem('orca.tokenOwner'), null)
    assert.equal(
      page.window.localStorage.getItem('orca.pendingLogout'),
      null,
      'a reached logout clears the pending marker'
    )
    assert.equal(jar.has('orca_refresh'), false, 'logout must clear the refresh Cookie')
  })

  test('U221 F2 Cookie 刷新传输失败 → 登录页，不出现空白页', async () => {
    const base = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const page = loadWebConsolePage(base, {
      platformOrigin: ORIGIN,
      cookieJar: new Map(),
      storage: { 'orca.authMode': 'cookie' },
      abortOnLoad: ['POST /v1/auth/refresh']
    })
    await page.settle()

    assert.equal(page.hidden('#view-login'), false, 'the login view must be visible')
    assert.equal(page.hidden('#view-app'), true)
    assert.equal(refreshCalls(page).length, 1, 'one failed probe, no loop')
  })

  test('U221 F2 旧模式 body 刷新传输失败 → 登录页，不出现空白页', async () => {
    const base = await start()
    const page = loadWebConsolePage(base, {
      storage: {
        'orca.authMode': 'legacy',
        'orca.access': 'stale-access',
        'orca.refresh': 'stale-refresh'
      },
      abortOnLoad: ['POST /v1/auth/refresh']
    })
    await page.settle()

    assert.equal(page.hidden('#view-login'), false, 'the login view must be visible')
    assert.equal(page.hidden('#view-app'), true)
    assert.equal(page.calls().filter((call) => call === 'GET /v1/me').length, 1)
    assert.equal(refreshCalls(page).length, 1, 'the body fallback failed exactly once')
  })

  test('U221 F3 其他账号留下的旧键在登录时清除', async () => {
    const base = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const page = loadWebConsolePage(base, {
      platformOrigin: ORIGIN,
      cookieJar: new Map(),
      storage: { 'orca.refresh': 'stale-a-refresh', 'orca.tokenOwner': 'zhangsan' }
    })
    await page.settle()
    await page.submitLogin('admin', 'Adm1n!')

    assert.equal(page.hidden('#view-app'), false)
    assert.equal(
      page.window.localStorage.getItem('orca.refresh'),
      null,
      'another account’s legacy key must not survive the login'
    )
    assert.equal(page.window.localStorage.getItem('orca.tokenOwner'), null)
  })

  test('U221 F3 同账号旧键保留以完成迁移', async () => {
    const base = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const page = loadWebConsolePage(base, {
      platformOrigin: ORIGIN,
      cookieJar: new Map(),
      storage: { 'orca.refresh': 'legacy-refresh', 'orca.tokenOwner': 'admin' }
    })
    await page.settle()
    await page.submitLogin('admin', 'Adm1n!')

    assert.equal(page.hidden('#view-app'), false)
    assert.equal(page.window.localStorage.getItem('orca.refresh'), 'legacy-refresh')
    assert.equal(page.window.localStorage.getItem('orca.tokenOwner'), 'admin')
  })

  test('U221 F3 旧模式登录把持久化令牌绑定到当前账号', async () => {
    const base = await start()
    const page = loadWebConsolePage(base)
    await page.settle()
    await page.submitLogin('admin', 'Adm1n!')

    assert.equal(page.hidden('#view-app'), false)
    assert.ok(page.window.localStorage.getItem('orca.refresh'))
    assert.equal(page.window.localStorage.getItem('orca.tokenOwner'), 'admin')
  })

  test('U221 F4 登出网络失败保留标记，下次加载重试一次并停在登录页', async () => {
    const base = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const jar = new Map<string, string>()
    const first = loadWebConsolePage(base, { platformOrigin: ORIGIN, cookieJar: jar })
    await first.settle()
    await first.submitLogin('admin', 'Adm1n!')
    assert.ok(jar.get('orca_refresh'))

    first.abort('POST', '/v1/auth/logout')
    first.window.document.querySelector<HTMLElement>('#logoutBtn')!.click()
    await first.settle()
    assert.equal(first.hidden('#view-login'), false)
    assert.equal(
      first.window.localStorage.getItem('orca.pendingLogout'),
      '1',
      'an unreachable logout must leave a marker'
    )

    // Next load: a still-valid Cookie must not auto-enter; the logout is retried.
    const second = loadWebConsolePage(base, {
      platformOrigin: ORIGIN,
      cookieJar: jar,
      storage: { 'orca.authMode': 'cookie', 'orca.pendingLogout': '1' },
      abortOnLoad: ['POST /v1/auth/logout']
    })
    await second.settle()
    assert.equal(second.hidden('#view-login'), false)
    assert.equal(second.hidden('#view-app'), true)
    assert.equal(refreshCalls(second).length, 0, 'a pending logout must not auto-login')
    assert.equal(second.calls().filter((call) => call === 'GET /v1/me').length, 0)
    assert.equal(
      second.window.localStorage.getItem('orca.pendingLogout'),
      '1',
      'a still-failing logout keeps the marker'
    )
    assert.ok(jar.get('orca_refresh'), 'precondition: the Cookie was still valid')

    const third = loadWebConsolePage(base, {
      platformOrigin: ORIGIN,
      cookieJar: jar,
      storage: { 'orca.authMode': 'cookie', 'orca.pendingLogout': '1' }
    })
    await third.settle()
    assert.equal(third.hidden('#view-login'), false)
    assert.equal(third.hidden('#view-app'), true)
    assert.equal(
      third.window.localStorage.getItem('orca.pendingLogout'),
      null,
      'a reached logout clears the marker'
    )
    assert.equal(jar.has('orca_refresh'), false, 'the retried logout cleared the Cookie')
  })

  test('U222 N1 页内刷新传输失败保留会话，恢复网络后重试成功', async () => {
    const base = await start({ accessTtlMs: 1200 })
    const page = loadWebConsolePage(base)
    await page.settle()
    await page.submitLogin('admin', 'Adm1n!')
    assert.equal(page.hidden('#view-app'), false)
    const accessBefore = page.window.localStorage.getItem('orca.access')
    const refreshBefore = page.window.localStorage.getItem('orca.refresh')
    assert.ok(accessBefore)
    assert.ok(refreshBefore)

    await new Promise((resolve) => setTimeout(resolve, 1500))
    const logoutCalls = (): number =>
      page.calls().filter((call) => call === 'POST /v1/auth/logout').length
    const logoutBefore = logoutCalls()

    page.abort('POST', '/v1/auth/refresh')
    await page.clickNav('relays')

    assert.equal(logoutCalls(), logoutBefore, 'a transport failure must not revoke the session')
    assert.equal(page.hidden('#view-app'), false, 'the app shell must stay visible')
    assert.equal(page.hidden('#view-login'), true)
    assert.equal(
      page.window.localStorage.getItem('orca.access'),
      accessBefore,
      'the persisted tokens must survive'
    )
    assert.equal(page.window.localStorage.getItem('orca.refresh'), refreshBefore)

    // Network restored: the next request renews and replays normally.
    await page.clickNav('relays')
    assert.equal(page.hidden('#view-app'), false)
    assert.equal(page.hidden('#view-login'), true)
    assert.match(page.text('#content'), /中继/, 'the retry after recovery must render')
    assert.notEqual(
      page.window.localStorage.getItem('orca.refresh'),
      refreshBefore,
      'the successful retry rotates the refresh token'
    )
  })

  test('U222 N2 pendingLogout 请求挂起时登录页立即可见', async () => {
    const base = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const page = loadWebConsolePage(base, {
      platformOrigin: ORIGIN,
      cookieJar: new Map(),
      storage: { 'orca.pendingLogout': '1' },
      holdOnLoad: ['POST /v1/auth/logout']
    })
    await page.settle()

    assert.equal(page.hidden('#view-login'), false, 'the login view must be visible')
    assert.equal(page.hidden('#view-app'), true, 'never a blank page')
    assert.equal(
      page.window.localStorage.getItem('orca.pendingLogout'),
      '1',
      'a hung retry keeps the marker'
    )

    await page.release()
    await page.settle()
    assert.equal(page.hidden('#view-login'), false)
  })

  test('U222 N3 旧模式启动 body 刷新成功后补写 tokenOwner', async () => {
    const base = await start()
    const legacy = await legacyTokens(base)
    const page = loadWebConsolePage(base, {
      storage: { 'orca.access': 'expired-access', 'orca.refresh': legacy.refreshToken }
    })
    await page.settle()

    assert.equal(page.hidden('#view-app'), false)
    assert.equal(
      page.window.localStorage.getItem('orca.tokenOwner'),
      'admin',
      'the startup body refresh must bind the persisted tokens to the account'
    )
  })

  test('U222 N3 Cookie 模式启动不写持久化 owner', async () => {
    const base = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const jar = new Map<string, string>()
    const first = loadWebConsolePage(base, { platformOrigin: ORIGIN, cookieJar: jar })
    await first.settle()
    await first.submitLogin('admin', 'Adm1n!')
    assert.ok(jar.get('orca_refresh'))

    const second = loadWebConsolePage(base, {
      platformOrigin: ORIGIN,
      cookieJar: jar,
      storage: { 'orca.authMode': 'cookie' }
    })
    await second.settle()

    assert.equal(second.hidden('#view-app'), false)
    assert.equal(
      second.window.localStorage.getItem('orca.tokenOwner'),
      null,
      'Cookie mode must never write a persisted token owner'
    )
  })

  test('U222 N4 旧模式 body 刷新声明 x-orca-web-contract', async () => {
    const base = await start({ accessTtlMs: 1200 })
    const page = loadWebConsolePage(base)
    await page.settle()
    await page.submitLogin('admin', 'Adm1n!')
    await new Promise((resolve) => setTimeout(resolve, 1500))
    await page.clickNav('relays')

    assert.equal(refreshBodies(page).length, 1, 'the legacy path must use a body refresh')
    const values = contractValues(page, 'POST /v1/auth/refresh')
    assert.ok(values.length > 0)
    assert.ok(
      values.every((value) => value === '1'),
      'the body refresh must declare x-orca-web-contract: 1'
    )
  })

  test('U222 N4 新登录清除 pendingLogout 标记', async () => {
    const base = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const page = loadWebConsolePage(base, {
      platformOrigin: ORIGIN,
      cookieJar: new Map(),
      storage: { 'orca.pendingLogout': '1' },
      abortOnLoad: ['POST /v1/auth/logout']
    })
    await page.settle()
    assert.equal(page.hidden('#view-login'), false)
    assert.equal(page.window.localStorage.getItem('orca.pendingLogout'), '1', 'precondition')

    await page.submitLogin('admin', 'Adm1n!')

    assert.equal(page.hidden('#view-app'), false)
    assert.equal(page.window.localStorage.getItem('orca.pendingLogout'), null)
  })

  test('U222 N4 登出收到 401 清除 pendingLogout 标记', async () => {
    const base = await start()
    const page = loadWebConsolePage(base)
    await page.settle()
    await page.submitLogin('admin', 'Adm1n!')
    page.fail('POST', '/v1/auth/logout', {
      status: 401,
      body: { error: { code: 'SESSION_EXPIRED', message: '会话已过期' } }
    })

    page.window.document.querySelector<HTMLElement>('#logoutBtn')!.click()
    await page.settle()

    assert.equal(page.hidden('#view-login'), false)
    assert.equal(
      page.window.localStorage.getItem('orca.pendingLogout'),
      null,
      'a reached 401 proves the credential is gone, so the retry marker must clear'
    )
  })

  test('U221 F5 /v1/auth/* 请求声明 x-orca-web-contract', async () => {
    const base = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const page = loadWebConsolePage(base, {
      platformOrigin: ORIGIN,
      cookieJar: new Map(),
      storage: { 'orca.authMode': 'cookie' }
    })
    await page.settle()
    await page.submitLogin('admin', 'Adm1n!')
    page.window.document.querySelector<HTMLElement>('#logoutBtn')!.click()
    await page.settle()

    for (const call of [
      'POST /v1/auth/refresh',
      'POST /v1/auth/login',
      'POST /v1/auth/logout'
    ]) {
      const values = contractValues(page, call)
      assert.ok(values.length > 0, `${call} must be sent`)
      assert.ok(
        values.every((value) => value === '1'),
        `${call} must declare x-orca-web-contract: 1`
      )
    }
  })

  test('AC9b 未知标记 + 旧键 + 旧服务端：1 次无 body + 1 次 body，保留旧键并记 legacy', async () => {
    const base = await start({ cookieMode: 'never', publicOrigin: '' })
    const legacy = await legacyTokens(base)
    const page = loadWebConsolePage(base, {
      storage: {
        'orca.refresh': legacy.refreshToken,
        'orca.tokenOwner': 'admin',
        'orca.user': JSON.stringify({ username: 'admin' })
      }
    })
    await page.settle()

    assert.equal(page.hidden('#view-app'), false, 'the body fallback restores the session')
    assert.equal(refreshCalls(page).length, 2, 'exactly one probe plus one body fallback')
    const bodies = refreshBodies(page)
    assert.equal(bodies.length, 1, 'only the fallback carries a body')
    assert.equal(
      (bodies[0]?.body as Record<string, unknown>).refreshToken,
      legacy.refreshToken,
      'the fallback sends the legacy key verbatim'
    )
    assert.deepEqual(
      refreshStatuses(page),
      [401, 200],
      'the no-body probe is refused, the body fallback succeeds'
    )
    // No marker in the body response ⇒ old server; the keys must survive.
    const stored = storedAuth(page)
    assert.ok(stored.refresh, 'the legacy refresh must be kept, not deleted')
    assert.ok(stored.access, 'the localStorage contract keeps persisting access')
    assert.equal(stored.mode, 'legacy', 'the old server is remembered to skip future probes')

    // A later load is already classified: no probe, no refresh.
    const reload = loadWebConsolePage(base, {
      storage: {
        'orca.authMode': 'legacy',
        'orca.access': stored.access ?? '',
        'orca.refresh': stored.refresh ?? '',
        'orca.tokenOwner': 'admin'
      }
    })
    await reload.settle()
    assert.equal(refreshCalls(reload).length, 0, 'a known legacy deployment is not probed again')
    assert.equal(reload.hidden('#view-app'), false)
    assert.equal(reload.hidden('#view-login'), true)
  })

  test('AC9b 未知标记 + 旧键 + 新服务端：一次无 body 成功即删旧键并进入 Cookie 模式', async () => {
    const base = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const jar = new Map<string, string>()
    const first = loadWebConsolePage(base, { platformOrigin: ORIGIN, cookieJar: jar })
    await first.settle()
    await first.submitLogin('admin', 'Adm1n!')
    assert.ok(jar.get('orca_refresh'), 'precondition: a real Cookie session exists')

    const page = loadWebConsolePage(base, {
      platformOrigin: ORIGIN,
      cookieJar: jar,
      storage: {
        'orca.access': 'legacy-access-u197-ac9b',
        'orca.refresh': 'legacy-refresh-u197-ac9b'
      }
    })
    await page.settle()

    assert.equal(page.hidden('#view-app'), false)
    assert.equal(refreshCalls(page).length, 1, 'the proven Cookie needs one no-body refresh')
    assert.equal(refreshBodies(page).length, 0, 'no body fallback is spent')
    assert.deepEqual(refreshStatuses(page), [200])
    const stored = storedAuth(page)
    assert.equal(stored.access, null, 'legacy access is deleted after the no-body success')
    assert.equal(stored.refresh, null, 'legacy refresh is deleted after the no-body success')
    assert.equal(stored.mode, 'cookie')
  })

  test('D17 未知标记 + 有效 access + 探测 503：进应用，不花 body 回退，不写 legacy', async () => {
    const base = await start({ cookieMode: 'never', publicOrigin: '' })
    const legacy = await legacyTokens(base)
    const page = loadWebConsolePage(base, {
      storage: {
        'orca.access': legacy.accessToken,
        'orca.refresh': legacy.refreshToken
      },
      // U197 D17: the no-body probe is an outage, not a session verdict.
      failOnLoad: [{ call: 'POST /v1/auth/refresh', status: 503 }]
    })
    await page.settle()

    assert.equal(page.hidden('#view-app'), false, 'the valid access token still restores the app')
    assert.equal(page.hidden('#view-login'), true)
    assert.equal(refreshCalls(page).length, 1, 'exactly one probe per load, never retried')
    assert.equal(refreshBodies(page).length, 0, 'an outage must not spend the body fallback')
    assert.deepEqual(refreshStatuses(page), [503])
    assert.ok(
      page.calls().includes('GET /v1/me'),
      'recovery must continue through the persistent access token'
    )
    const stored = storedAuth(page)
    assert.equal(stored.mode, null, 'an outage is not proof of a legacy deployment')
    assert.equal(stored.access, legacy.accessToken, 'the persistent access token is kept')
    assert.equal(stored.refresh, legacy.refreshToken, 'the legacy refresh key is kept')
  })

  test('未知标记 + 无 body 探测 200 但缺 refreshCookie：仍按一次探测进入 Cookie 模式', async () => {
    // D17 review F5: pin the existing fallback at app.js `refreshWithCookie`
    // → `if (migrating) setCookieMode(true)`. A 200 that renews the access token
    // is the migration gate even when an old/reduced server omits the marker.
    const base = await start({ cookieMode: 'never', publicOrigin: '' })
    const legacy = await legacyTokens(base)
    const page = loadWebConsolePage(base, {
      storage: {
        'orca.access': legacy.accessToken,
        'orca.refresh': legacy.refreshToken,
        'orca.tokenOwner': 'admin'
      },
      failOnLoad: [
        {
          call: 'POST /v1/auth/refresh',
          respond: { status: 200, body: { accessToken: legacy.accessToken } }
        }
      ]
    })
    await page.settle()

    assert.equal(page.hidden('#view-app'), false)
    assert.equal(refreshCalls(page).length, 1, 'the no-body success is the only probe')
    assert.equal(refreshBodies(page).length, 0, 'no body fallback is spent')
    const stored = storedAuth(page)
    assert.equal(stored.access, null, 'a no-body success deletes the legacy keys')
    assert.equal(stored.refresh, null)
    assert.equal(stored.mode, 'cookie', 'the success itself is the migration gate')
  })
})
