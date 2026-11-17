import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp, type ApiHandle } from '../../apps/api/src/server.ts'
import { loadWebConsolePage, type WebConsolePage } from './web-console-page.ts'

/**
 * U228: a 401 that survives one refresh + one replay is a dead session. The
 * client signs out instead of leaving a shell whose requests all fail. The
 * startup path must land on the login view too, without a second refresh loop.
 */

const ORIGIN = 'https://web.u228.local'
const apps: ApiHandle[] = []

async function start(): Promise<string> {
  const app = createApp({
    port: 0,
    accessTtlMs: 60_000,
    refreshTtlMs: 60_000,
    internalToken: 'u228-web-token',
    cookieMode: 'auto',
    publicOrigin: ORIGIN
  })
  apps.push(app)
  const port = await app.listen()
  return `http://127.0.0.1:${port}`
}

function refreshCalls(page: WebConsolePage): string[] {
  return page.calls().filter((call) => call === 'POST /v1/auth/refresh')
}

function unauthorized(): { status: number; body: unknown } {
  return {
    status: 401,
    body: { error: { code: 'SESSION_EXPIRED', message: '会话已失效，请重新登录。' } }
  }
}

after(async () => {
  await Promise.all(apps.map((app) => app.close()))
})

describe('U228 Web 客户端对死会话登出（happy-dom + 真实 createApp）', () => {
  test('刷新 200 但重放仍 401 → 登出、登录页可见、不二次刷新', async () => {
    const base = await start()
    const page = loadWebConsolePage(base)
    await page.settle()
    await page.submitLogin('admin', 'Adm1n!')
    assert.equal(page.hidden('#view-app'), false)

    // The renewal itself succeeds, but the replayed request is still 401 —
    // exactly the disabled-account window this fix closes.
    page.fail('GET', '/v1/projects', unauthorized())
    page.fail('POST', '/v1/auth/refresh', {
      status: 200,
      body: { accessToken: 'fresh-access' }
    })
    const before = refreshCalls(page).length

    await page.clickNav('projects')

    assert.equal(page.hidden('#view-login'), false, 'the login view must be back')
    assert.equal(page.hidden('#view-app'), true)
    assert.equal(
      refreshCalls(page).length - before,
      1,
      'one refresh, then the replay 401 signs out'
    )
    assert.equal(page.window.localStorage.getItem('orca.access'), null, 'credentials are cleared')
  })

  test('启动重放仍 401 → 登录页，仅一次刷新', async () => {
    const base = await start()
    const page = loadWebConsolePage(base, {
      platformOrigin: ORIGIN,
      cookieJar: new Map(),
      storage: { 'orca.authMode': 'cookie' },
      failOnLoad: [
        {
          call: 'POST /v1/auth/refresh',
          respond: { status: 200, body: { accessToken: 'fresh-access' } }
        },
        { call: 'GET /v1/me', respond: unauthorized() }
      ]
    })

    await page.settle()

    assert.equal(page.hidden('#view-login'), false, 'the startup path must land on login')
    assert.equal(page.hidden('#view-app'), true)
    assert.equal(refreshCalls(page).length, 1, 'one refresh attempt, no loop')
  })
})
