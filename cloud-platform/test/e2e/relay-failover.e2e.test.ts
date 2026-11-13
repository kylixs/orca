import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket, { WebSocketServer } from 'ws'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { startRelay, type RelayHandle } from '../../apps/relay/src/relay.ts'
import { makeTlsCerts, saveEvidence, spawnService, type Service } from './harness.ts'

/**
 * M83 (AC-23): two real relays, one killed mid-run. The platform must stop
 * handing out the dead node, and a client must still open new sessions through
 * the survivor — the AC's "5 backoff attempts, ≥99% success".
 */

const EVIDENCE = 'm83-relay-failover'
const INTERNAL_TOKEN = 'm83-relay-token'
// Relays announce on every 2s route sync, so the window must exceed one period
// plus slack; a shorter window would mark a live relay stale between beats.
const ALIVE_MS = 6_000
const SESSIONS = 40
const DEVICE_PUBKEY = Buffer.from('m83-device').toString('base64')

let api: Service
let adminToken = ''
let hostId = ''
let hostCredential = ''
let projectId = ''
let devToken = ''
let devDeviceId = ''
let relayA: RelayHandle
let relayB: RelayHandle
let upstream: HttpsServer
let upstreamWs: WebSocketServer
let upstreamPort = 0

type RelayEndpoint = { priority: number; url: string; routeKey: string; sni: string }
type ConnectBody = { endpoints: { relay: RelayEndpoint[] }; error?: { code: string } }

function portOf(url: string): number {
  return Number(new URL(url).port)
}

async function connectTicket(): Promise<ConnectBody> {
  const res = await fetch(`${api.url}/v1/projects/${projectId}/connect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${devToken}` },
    body: JSON.stringify({
      deviceId: devDeviceId,
      devicePubKey: DEVICE_PUBKEY,
      clientVersion: '1.5.0'
    })
  })
  const body = (await res.json()) as ConnectBody
  assert.equal(res.status, 200, JSON.stringify(body))
  assert.ok(body.endpoints, JSON.stringify(body))
  return body
}

/** One client-side connection attempt through one relay endpoint. */
function tryRelay(endpoint: RelayEndpoint): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(endpoint.url, {
      rejectUnauthorized: false,
      servername: endpoint.sni,
      handshakeTimeout: 2_000
    })
    const done = (ok: boolean): void => {
      ws.removeAllListeners()
      ws.terminate()
      resolve(ok)
    }
    ws.once('open', () => done(true))
    ws.once('error', () => done(false))
    ws.once('unexpected-response', () => done(false))
  })
}

/** Client failover: try endpoints in priority order, at most 5 attempts (AC-23). */
async function openWithBackoff(endpoints: RelayEndpoint[]): Promise<{
  ok: boolean
  attempts: number
  usedPort: number | null
}> {
  let attempts = 0
  for (const endpoint of [...endpoints].sort((a, b) => a.priority - b.priority).slice(0, 5)) {
    attempts += 1
    if (await tryRelay(endpoint)) {
      return { ok: true, attempts, usedPort: portOf(endpoint.url) }
    }
  }
  return { ok: false, attempts, usedPort: null }
}

before(async () => {
  api = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN, ORCA_CLOUD_RELAY_ALIVE_MS: String(ALIVE_MS) },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-relay-failover'
  )
  const admin = await fetch(`${api.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'm83-admin' })
  })
  adminToken = ((await admin.json()) as { accessToken?: string }).accessToken ?? ''
  assert.notEqual(adminToken, '')

  // A real TLS target both relays forward to, so "open" means a real TLS handshake
  // completed through the relay, not just that a TCP connect succeeded.
  const certs = makeTlsCerts()
  // HTTPS (not raw TLS): the WebSocket upgrade needs an HTTP layer to answer 101.
  upstream = createHttpsServer({
    key: readFileSync(certs.key),
    cert: readFileSync(certs.cert)
  })
  // A real WSS endpoint: the relay only forwards bytes, so the upgrade must be
  // answered by the target — that is what makes "open" mean a working session.
  upstreamWs = new WebSocketServer({ server: upstream })
  upstreamWs.on('connection', (socket) => socket.send('upstream-ok'))
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()))
  const address = upstream.address()
  upstreamPort = typeof address === 'object' && address ? address.port : 0
  const target = `127.0.0.1:${upstreamPort}`

  const tokenRes = await fetch(`${api.url}/v1/hosts/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}` }
  })
  const hostToken = ((await tokenRes.json()) as { token?: string }).token ?? ''
  const registered = await fetch(`${api.url}/v1/hosts/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${hostToken}` },
    body: JSON.stringify({
      name: 'm83-host',
      fingerprint: 'sha256:m83',
      e2eePublicKeyB64: 'test-e2ee-key',
      orcaVersion: '1.5.0',
      protocolVersion: 3,
      networkZone: 'intranet',
      directAddrs: [],
      relayTarget: target,
      relayRoute: 'm83-route',
      runtimeCapabilities: ['pty', 'files']
    })
  })
  const host = (await registered.json()) as { hostId: string; credential: string }
  hostId = host.hostId
  hostCredential = host.credential

  const created = await fetch(`${api.url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      key: 'm83-relay-svc',
      name: 'm83-relay-svc',
      hostId,
      path: '/srv/work/m83-relay-svc'
    })
  })
  assert.equal(created.status, 201)
  projectId = ((await created.json()) as { id: string }).id
  await fetch(`${api.url}/v1/projects/${projectId}/grants`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      subjectType: 'group',
      subjectId: 'team-payment',
      permissions: ['open', 'terminal', 'file:read']
    })
  })

  const login = await fetch(`${api.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'zhangsan',
      password: 'Passw0rd!',
      devicePubKey: DEVICE_PUBKEY,
      deviceName: 'm83-dev'
    })
  })
  const dev = (await login.json()) as { accessToken?: string; device?: { id: string } }
  devToken = dev.accessToken ?? ''
  devDeviceId = dev.device?.id ?? ''
  assert.ok(devToken !== '' && devDeviceId !== '')

  relayA = await startRelay({
    port: 0,
    id: 'relay-a',
    apiUrl: api.url,
    internalToken: INTERNAL_TOKEN
  })
  relayB = await startRelay({
    port: 0,
    id: 'relay-b',
    apiUrl: api.url,
    internalToken: INTERNAL_TOKEN
  })
}, 180_000)

after(async () => {
  await relayA?.close()
  await relayB?.close()
  // Why force: relayed sockets stay open, and close() would wait for them forever.
  upstreamWs?.close()
  if (typeof upstream?.closeAllConnections === 'function') {
    upstream.closeAllConnections()
  }
  await new Promise<void>((resolve) => upstream?.close(() => resolve()))
  await api?.stop()
})

async function heartbeat(): Promise<void> {
  const beat = await fetch(`${api.url}/v1/hosts/${hostId}/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${hostCredential}` },
    body: JSON.stringify({ status: 'online' })
  })
  assert.equal(beat.status, 200)
}

test('AC-23 双中继注册；杀一个后平台不再下发，客户端 5 次内切到存活节点且新会话成功率 ≥99%', async () => {
  await heartbeat()

  const before = await connectTicket()
  const portsBefore = before.endpoints.relay.map((endpoint) => portOf(endpoint.url)).sort()
  assert.equal(portsBefore.length, 2, JSON.stringify(before))
  assert.deepEqual(portsBefore, [relayA.port, relayB.port].sort())

  // ---- kill relay A ----
  await relayA.close()

  // The platform learns within the liveness window; poll the internal view.
  const deadline = Date.now() + ALIVE_MS + 5_000
  let relaysOnline: number[] = []
  while (Date.now() < deadline) {
    const view = await fetch(`${api.url}/v1/internal/relays`, {
      headers: { 'x-internal-token': INTERNAL_TOKEN }
    })
    const body = (await view.json()) as { relays: { id: string; online: boolean }[] }
    relaysOnline = body.relays.map((relay) => (relay.online ? 1 : 0))
    if (body.relays.find((relay) => relay.id === 'relay-a')?.online === false) {
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  assert.equal(relaysOnline.length, 2)

  const afterKill = await connectTicket()
  const portsAfter = afterKill.endpoints.relay.map((endpoint) => portOf(endpoint.url))
  assert.deepEqual(portsAfter, [relayB.port], 'the dead relay must not be handed out')

  // ---- 40 new sessions through the surviving relay: ≥99% success, ≤5 attempts ----
  let successes = 0
  const attemptsUsed: number[] = []
  for (let index = 0; index < SESSIONS; index += 1) {
    // The platform drops a host that stops beating after 60s; the loop must not
    // outrun the heartbeat just because failed attempts are slow.
    if (index > 0 && index % 5 === 0) {
      await heartbeat()
    }
    const ticket = await connectTicket()
    const opened = await openWithBackoff(ticket.endpoints.relay)
    attemptsUsed.push(opened.attempts)
    if (opened.ok) {
      successes += 1
      assert.equal(opened.usedPort, relayB.port)
    }
  }
  const successRate = successes / SESSIONS
  assert.ok(successRate >= 0.99, `success rate ${successRate}`)
  assert.ok(Math.max(...attemptsUsed) <= 5)

  // ---- failover path: an endpoint list that still names the dead relay first ----
  const staleList: RelayEndpoint[] = [
    { priority: 99, url: `wss://127.0.0.1:${relayA.port}/`, routeKey: 'm83-route', sni: 'm83-route.relay.local' },
    { priority: 100, url: `wss://127.0.0.1:${relayB.port}/`, routeKey: 'm83-route', sni: 'm83-route.relay.local' }
  ]
  const failedOver = await openWithBackoff(staleList)
  assert.equal(failedOver.ok, true)
  assert.equal(failedOver.attempts, 2, 'the dead endpoint fails once, the survivor succeeds on attempt 2')
  assert.equal(failedOver.usedPort, relayB.port)

  saveEvidence(EVIDENCE, 'relay-failover.json', {
    relaysBefore: portsBefore,
    relaysAfterKill: portsAfter,
    sessions: SESSIONS,
    successes,
    successRate,
    maxAttempts: Math.max(...attemptsUsed),
    staleListFailover: failedOver,
    relayBStats: relayB.stats()
  })
}, 240_000)
