import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp, type ApiHandle } from '../../apps/api/src/server.ts'
import { loadWebConsolePage, type WebConsolePage } from './web-console-page.ts'

/**
 * U229 F5/F6/F7/F11: a hung platform must fail closed to the login view, a
 * 200 login without the contract must not poison storage, and a refresh 5xx is
 * an outage (keep the session), not a session verdict.
 */

const ORIGIN = 'https://web.u229-startup.local'
const apps: ApiHandle[] = []

async function start(
  options: { accessTtlMs?: number; cookieMode?: string; publicOrigin?: string } = {}
): Promise<string> {
  const app = createApp({
    port: 0,
    accessTtlMs: options.accessTtlMs ?? 60_000,
    refreshTtlMs: 60_000,
    internalToken: 'u229-startup-resilience',
    cookieMode: options.cookieMode ?? 'auto',
    publicOrigin: options.publicOrigin ?? ''
  })
  apps.push(app)
  const port = await app.listen()
  return `http://127.0.0.1:${port}`
}

async function legacyRefreshToken(base: string): Promise<string> {
  const res = await fetch(`${base}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'legacy' })
  })
  assert.equal(res.status, 200)
  const body = (await res.json()) as Record<string, unknown>
  assert.equal(typeof body.refreshToken, 'string')
  return String(body.refreshToken)
}

function refreshCalls(page: WebConsolePage): string[] {
  return page.calls().filter((call) => call === 'POST /v1/auth/refresh')
}

function logoutCalls(page: WebConsolePage): string[] {
  return page.calls().filter((call) => call === 'POST /v1/auth/logout')
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

after(async () => {
  await Promise.all(apps.map((app) => app.close()))
})

describe('U229 F5 启动挂起必须落到登录页', () => {
  test('F5a Cookie 刷新挂起：超时后登录页可见，绝不留双隐藏空白页', async () => {
    const base = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const page = loadWebConsolePage(base, {
      // The timeout is a real 10s constant; scaling keeps the test fast.
      timerScale: 0.01,
      platformOrigin: ORIGIN,
      cookieJar: new Map(),
      storage: { 'orca.authMode': 'cookie' },
      holdOnLoad: ['POST /v1/auth/refresh']
    })
    await page.settle()

    assert.equal(page.hidden('#view-login'), false, 'the login view must be visible')
    assert.equal(page.hidden('#view-app'), true, 'the app shell must stay closed')

    await page.release()
    await page.settle()
  })

  test('F5b 旧模式 /v1/me 的刷新挂起：同样超时回到登录页', async () => {
    const base = await start({ cookieMode: 'never' })
    const refreshToken = await legacyRefreshToken(base)
    const page = loadWebConsolePage(base, {
      timerScale: 0.01,
      storage: { 'orca.access': 'expired-access', 'orca.refresh': refreshToken },
      holdOnLoad: ['POST /v1/auth/refresh']
    })
    await page.settle()

    assert.equal(page.hidden('#view-login'), false, 'the login view must be visible')
    assert.equal(page.hidden('#view-app'), true, 'the app shell must stay closed')

    await page.release()
  })
})

describe('U229 F6 登录 200 毒化响应', () => {
  test('空 body 的 200：中文平台错误，storage 不写 "undefined"，无状态残留', async () => {
    const base = await start()
    const page = loadWebConsolePage(base)
    await page.settle()

    page.fail('POST', '/v1/auth/login', { status: 200, body: {} })
    await page.submitLogin('admin', 'Adm1n!')

    assert.equal(
      page.text('#loginError'),
      '平台响应异常，请稍后重试',
      'a non-contract 200 must read as a platform error, not a TypeError'
    )
    assert.equal(page.hidden('#view-login'), false)
    assert.equal(page.hidden('#view-app'), true)
    for (const key of ['orca.access', 'orca.refresh', 'orca.user']) {
      assert.notEqual(
        page.window.localStorage.getItem(key),
        'undefined',
        `${key} must never be poisoned with the literal "undefined"`
      )
      assert.equal(page.window.localStorage.getItem(key), null, `${key} must stay absent`)
    }
    // The device identity is minted before the login request and is not a credential.
    assert.notEqual(page.window.localStorage.getItem('orca.device'), 'undefined')
  })
})

describe('U229 F7 刷新错误分类', () => {
  test('F7a 刷新 503：不发 logout、应用壳保留', async () => {
    const base = await start({ accessTtlMs: 1000 })
    const page = loadWebConsolePage(base)
    await page.settle()
    await page.submitLogin('admin', 'Adm1n!')
    assert.equal(page.hidden('#view-app'), false)
    await delay(1300)

    const logoutsBefore = logoutCalls(page).length
    page.fail('POST', '/v1/auth/refresh', {
      status: 503,
      body: { error: { code: 'PLATFORM_UNAVAILABLE', message: '模拟平台故障' } }
    })
    await page.clickNav('relays')

    assert.equal(refreshCalls(page).length, 1, 'the 401 must attempt one refresh')
    assert.equal(logoutCalls(page).length, logoutsBefore, 'an outage is not a session verdict')
    assert.equal(page.hidden('#view-app'), false, 'the app shell must stay visible')
    assert.equal(page.hidden('#view-login'), true)
  })

  test('F7b 并发 401 + 刷新 401：登出且只发一次 logout 请求', async () => {
    const base = await start({ accessTtlMs: 1000 })
    const page = loadWebConsolePage(base)
    await page.settle()
    await page.submitLogin('admin', 'Adm1n!')
    await delay(1300)

    const logoutsBefore = logoutCalls(page).length
    page.fail('POST', '/v1/auth/refresh', {
      status: 401,
      body: { error: { code: 'SESSION_EXPIRED', message: '会话已失效' } }
    })
    await Promise.all([page.clickNav('relays'), page.clickNav('projects')])

    assert.equal(page.hidden('#view-login'), false, 'a session verdict signs out')
    assert.equal(page.hidden('#view-app'), true)
    assert.equal(
      logoutCalls(page).length - logoutsBefore,
      1,
      'concurrent rejected 401s must not amplify logout'
    )
  })
})

describe('U229 F11 未处理拒绝', () => {
  test('添加中继失败：toast 提示，且没有 unhandled rejection', async () => {
    const base = await start()
    const page = loadWebConsolePage(base)
    await page.settle()
    await page.submitLogin('admin', 'Adm1n!')
    await page.clickNav('relays')

    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', onRejection)
    try {
      page.fail('POST', '/v1/relays/install-tokens', {
        status: 503,
        body: { error: { code: 'PLATFORM_UNAVAILABLE', message: '模拟平台故障' } }
      })
      page.window.document.querySelector<HTMLButtonElement>('#addRelayBtn')!.click()
      await page.settle()
      await delay(50)

      const toast = page.window.document.querySelector<HTMLElement>('.toast')
      assert.match(toast?.textContent ?? '', /添加中继失败/, 'the failure must surface as a toast')
      assert.deepEqual(rejections, [], 'the click handler must not leak an unhandled rejection')
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })
})
