import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp, type ApiHandle } from '../../apps/api/src/server.ts'
import { login, registerHost, saveEvidence } from './harness.ts'
import { loadWebConsolePage } from './web-console-page.ts'

/**
 * U79: /v1/hosts exposes the host↔relay binding wire-additively (relayTarget +
 * relayOnline), and the console host table renders it — pulling the relay marks
 * every bound host, so the blast radius of a dead relay is visible.
 *
 * The relay is real: it announces over the internal endpoint and is then left
 * silent past the alive window (the runtime-sim form of killing the process).
 */

const EVIDENCE = 'u79-relay-binding'
const RELAY_TARGET = '127.0.0.1:28444'
const T0 = 1_800_000_000_000

let clock = T0
let app: ApiHandle
let url = ''
let adminToken = ''
let boundHost = { hostId: '', credential: '' }

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
}

async function hosts(admin = true): Promise<Record<string, unknown>[]> {
  const res = await fetch(`${url}/v1/hosts`, { headers: auth(admin ? adminToken : 'wrong') })
  assert.equal(res.status, admin ? 200 : 403)
  return ((await res.json()) as { hosts: Record<string, unknown>[] }).hosts
}

before(async () => {
  clock = T0
  app = createApp({ port: 0, now: () => clock })
  const port = await app.listen()
  url = `http://127.0.0.1:${port}`
  adminToken = await login(url, 'admin', 'Adm1n!')
  assert.notEqual(adminToken, '')

  // The relay registers for real, then the bound host enrols through it.
  const announce = await fetch(`${url}/v1/internal/relay-endpoint`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-token': 'internal-test-token' },
    body: JSON.stringify({ id: 'relay:28444', host: '127.0.0.1', port: 28444 })
  })
  assert.equal(announce.status, 200)
  boundHost = await registerHost({
    apiUrl: url,
    adminToken,
    name: 'j79-dev-002',
    directAddr: '127.0.0.1:16999',
    relayTarget: RELAY_TARGET
  })
  assert.notEqual(boundHost.hostId, '')
}, { timeout: 30_000 })

after(async () => {
  await app?.close()
})

test('U79-1 /v1/hosts 载荷 wire-additive：relayTarget/relayOnline 呈现绑定', async () => {
  const list = await hosts()
  const bound = list.find((host) => host.name === 'j79-dev-002')
  assert.ok(bound, 'the registered host must be listed')
  assert.equal(bound.relayTarget, RELAY_TARGET, 'the binding must carry the route target')
  assert.equal(bound.relayRoute, 'j79-dev-002')
  assert.equal(bound.relayOnline, true, 'the announced relay is inside its alive window')

  // Wire-additive: every legacy field is untouched, so old clients keep working.
  for (const legacy of ['id', 'name', 'directAddrs', 'relayRoute', 'online', 'status']) {
    assert.ok(legacy in bound, `legacy field ${legacy} must stay on the payload`)
  }
  // The seeded host shows its own binding (first direct addr) — additive, not
  // registration-only.
  const seeded = list.find((host) => host.name === 'dev-001')
  assert.equal(seeded?.relayTarget, '127.0.0.1:16768')

  saveEvidence(EVIDENCE, 'payload.json', {
    bound: { name: 'j79-dev-002', relayTarget: bound.relayTarget, relayOnline: bound.relayOnline },
    seededTarget: seeded?.relayTarget,
    legacyKeysPresent: true
  })
})

test('U79-2 管理台宿主表「中继」列呈现绑定；中继静默后标记受影响宿主', { timeout: 60_000 }, async () => {
  // The relay goes silent: no further announce, the alive window lapses.
  clock = T0 + 31_000

  const list = await hosts()
  const bound = list.find((host) => host.name === 'j79-dev-002')
  assert.equal(bound?.relayOnline, false, 'no live relay serves routes any more')
  assert.equal(
    bound?.relayTarget,
    RELAY_TARGET,
    'the binding stays visible while the relay is dead'
  )

  const page = loadWebConsolePage(url)
  await page.settle()
  await page.submitLogin('admin', 'Adm1n!')
  await page.clickNav('hosts')
  const row = [...page.window.document.querySelectorAll<HTMLElement>('#content tbody tr')].find(
    (candidate) => candidate.textContent?.includes('j79-dev-002')
  )
  assert.ok(row, 'the host row must render')
  assert.ok(row.textContent?.includes(RELAY_TARGET), 'the row must show the relay binding')
  assert.match(row.textContent ?? '', /中继离线/, 'the dead relay must flag the bound host')
  assert.match(row.textContent ?? '', /直连不受阻/, 'a direct-reachable host notes it is unblocked')

  // The drawer carries the same binding verdict.
  row!.querySelector<HTMLButtonElement>('[data-host]')!.click()
  await page.settle()
  const drawer = page.window.document.body.textContent ?? ''
  assert.match(drawer, /中继绑定/)
  assert.match(drawer, /中继离线/)

  saveEvidence(EVIDENCE, 'console.json', {
    relaySilentAfterMs: 31_000,
    rowShows: ['relayTarget', '中继离线', '直连不受阻'],
    drawerShows: ['中继绑定', '中继离线']
  })
})
