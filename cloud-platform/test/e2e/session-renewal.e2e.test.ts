import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp, type ApiHandle } from '../../apps/api/src/server.ts'
import { loadWebConsolePage } from './web-console-page.ts'

/**
 * The refresh contract clients depend on: a short access token becomes 401
 * SESSION_EXPIRED, the refresh endpoint rotates both tokens, reusing an already
 * rotated token kills the session, and an expired refresh token is refused.
 */

const ACCESS_TTL_MS = 1200
const REFRESH_TTL_MS = 60_000
const apps: ApiHandle[] = []

async function start(accessTtlMs: number, refreshTtlMs: number): Promise<string> {
  const app = createApp({ port: 0, accessTtlMs, refreshTtlMs, internalToken: 'renewal-token' })
  apps.push(app)
  const port = await app.listen()
  return `http://127.0.0.1:${port}`
}

async function login(base: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'zhangsan', password: 'Passw0rd!', deviceName: 'renewal' })
  })
  assert.equal(res.status, 200)
  return res.json()
}

async function refresh(base: string, refreshToken: string): Promise<Response> {
  return fetch(`${base}/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken })
  })
}

async function projects(base: string, accessToken: string): Promise<Response> {
  return fetch(`${base}/v1/projects`, { headers: { authorization: `Bearer ${accessToken}` } })
}

function stringField(body: Record<string, unknown>, name: string): string {
  const value = body[name]
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${name} missing from response`)
  }
  return value
}

function accessOf(body: Record<string, unknown>): string {
  return stringField(body, 'accessToken')
}

function refreshOf(body: Record<string, unknown>): string {
  return stringField(body, 'refreshToken')
}

after(async () => {
  await Promise.all(apps.map((app) => app.close()))
})

describe('平台会话续期（真实 createApp + HTTP）', () => {
  test('短 TTL 过期 → 刷新旋转 → 旧 token 复用作废会话', async () => {
    const base = await start(ACCESS_TTL_MS, REFRESH_TTL_MS)
    const first = await login(base)
    const access1 = accessOf(first)
    const refresh1 = refreshOf(first)
    assert.ok(Number.isInteger(first.expiresIn))
    assert.ok(Number(first.expiresIn) >= 1)

    assert.equal((await projects(base, access1)).status, 200)

    await new Promise((resolve) => setTimeout(resolve, ACCESS_TTL_MS + 300))
    const expired = await projects(base, access1)
    assert.equal(expired.status, 401)
    assert.equal((await expired.json()).error.code, 'SESSION_EXPIRED')

    const renewedRes = await refresh(base, refresh1)
    assert.equal(renewedRes.status, 200)
    const renewed = await renewedRes.json()
    const access2 = accessOf(renewed)
    const refresh2 = refreshOf(renewed)
    assert.notEqual(access2, access1)
    assert.notEqual(refresh2, refresh1)
    assert.ok(Number.isInteger(renewed.expiresIn))
    assert.equal((await projects(base, access2)).status, 200)

    // Rotation: the old refresh token no longer maps to a session.
    const reused = await refresh(base, refresh1)
    assert.equal(reused.status, 401)
    assert.equal((await reused.json()).error.code, 'SESSION_EXPIRED')

    // The mismatch revoked the session, so the freshly minted pair is dead too.
    const revokedAccess = await projects(base, access2)
    assert.equal(revokedAccess.status, 401)
    assert.equal((await revokedAccess.json()).error.code, 'SESSION_EXPIRED')
    assert.equal((await refresh(base, refresh2)).status, 401)
  })

  test('refresh token 过期（短 refresh TTL）后刷新被拒', async () => {
    const base = await start(60_000, 250)
    const first = await login(base)
    await new Promise((resolve) => setTimeout(resolve, 350))
    const refused = await refresh(base, refreshOf(first))
    assert.equal(refused.status, 401)
    assert.equal((await refused.json()).error.code, 'SESSION_EXPIRED')
  })

  test('浏览器 401 → refresh → 原请求重放一次（AC-M1-04）', async () => {
    // Why an expiry longer than the page's own settle: the login itself must
    // finish on the first token, so the 401 under test belongs to the click.
    // Why the relays route: it makes exactly one request, so this pins the
    // replay path itself. Parallel-load routes race the refresh (registered as
    // a separate gap) and are not a replay assertion.
    const base = await start(2000, 60_000)
    const page = loadWebConsolePage(base)
    await page.settle()
    await page.submitLogin('admin', 'Adm1n!')
    assert.equal(page.hidden('#view-app'), false)
    const refreshBefore = page.window.localStorage.getItem('orca.refresh')
    assert.ok(refreshBefore, 'login must persist a refresh token')

    await new Promise((resolve) => setTimeout(resolve, 2200))
    const before = page.calls().filter((call) => call === 'GET /v1/relays').length
    await page.clickNav('relays')
    const after = page.calls().filter((call) => call === 'GET /v1/relays').length

    assert.equal(after - before, 2, 'the expired request must be replayed exactly once')
    assert.equal(
      page.calls().filter((call) => call === 'POST /v1/auth/refresh').length,
      1,
      'one expiry renews once'
    )
    assert.equal(page.hidden('#view-app'), false, 'the user stays signed in')
    assert.notEqual(
      page.window.localStorage.getItem('orca.refresh'),
      refreshBefore,
      'renewing must rotate the refresh token'
    )
    assert.match(page.text('#content'), /中继/, 'the replay must render the page')
  })
})
