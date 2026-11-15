import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer as createTlsServer, connect as tlsConnect } from 'node:tls'
import type { Socket } from 'node:net'
import { createApp, type ApiHandle } from '../../apps/api/src/server.ts'
import { startRelay, type RelayHandle } from '../../apps/relay/src/relay.ts'
import { makeTlsCerts, saveEvidence } from './harness.ts'

/**
 * U64: a host restart moves its listen port. The heartbeat reports the new
 * directAddrs, but ensureHostRoute used to leave an existing named-route entry
 * alone, so the relay kept dialing the dead port until some other path corrected
 * it — the window in which /h/dev-local-02/cloud-admin.html failed to connect.
 * The beat is now authoritative for a named key's target; the same address is
 * still a no-write no-op. Derived `ip-` keys keep syncHostRoute's carry-over.
 */

const EVIDENCE = 'u64-drift'
const INTERNAL_TOKEN = 'u64-internal-token'
const DEVICE_PUB_KEY = Buffer.from('u64-device-key').toString('base64')

type RouteEntry = { routeKey: string; hostId: string; target: string; version: number }
type ApiHost = { id: string; name: string; relayRoute: string | null }

let app: ApiHandle
let url = ''
let adminToken = ''
let relay: RelayHandle
let certs: { key: string; cert: string; dir: string }

function auth(token: string): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${token}` }
}

async function registerHost(input: {
  name: string
  directAddrs: string[]
  relayTarget?: string
  relayRoute?: string
}): Promise<{ hostId: string; credential: string }> {
  const tokenRes = await fetch(`${url}/v1/hosts/tokens`, {
    method: 'POST',
    headers: auth(adminToken)
  })
  assert.equal(tokenRes.status, 201)
  const { token } = (await tokenRes.json()) as { token: string }
  const res = await fetch(`${url}/v1/hosts/register`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({
      name: input.name,
      fingerprint: `sha256:${input.name}`,
      e2eePublicKeyB64: 'test-e2ee-key',
      orcaVersion: '1.5.0',
      protocolVersion: 3,
      networkZone: 'intranet',
      directAddrs: input.directAddrs,
      runtimeCapabilities: ['pty', 'files'],
      ...(input.relayTarget ? { relayTarget: input.relayTarget } : {}),
      ...(input.relayRoute ? { relayRoute: input.relayRoute } : {})
    })
  })
  const body = (await res.json()) as { hostId?: string; credential?: string }
  assert.equal(res.status, 201, JSON.stringify(body))
  assert.ok(body.hostId && body.credential)
  return { hostId: body.hostId, credential: body.credential }
}

async function heartbeat(
  hostId: string,
  credential: string,
  directAddrs: string[]
): Promise<void> {
  const res = await fetch(`${url}/v1/hosts/${hostId}/heartbeat`, {
    method: 'POST',
    headers: auth(credential),
    body: JSON.stringify({ status: 'online', directAddrs })
  })
  assert.equal(res.status, 200, await res.text())
}

async function routes(): Promise<RouteEntry[]> {
  const res = await fetch(`${url}/v1/internal/relay-routes`, {
    headers: { 'x-internal-token': INTERNAL_TOKEN }
  })
  assert.equal(res.status, 200)
  return ((await res.json()) as { routes: RouteEntry[] }).routes
}

function routeFor(entries: RouteEntry[], key: string): RouteEntry | undefined {
  return entries.find((route) => route.routeKey === key)
}

/** A TLS listener standing in for the host's data plane; names its own port. */
function startHostListener(): Promise<{ port: number; close: () => Promise<void> }> {
  const active = new Set<Socket>()
  let port = 0
  const server = createTlsServer(
    { key: readFileSync(certs.key), cert: readFileSync(certs.cert) },
    (socket) => {
      active.add(socket)
      socket.on('close', () => active.delete(socket))
      socket.on('error', () => undefined)
      socket.on('data', () => socket.end(`host-port:${port}`))
    }
  )
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of active) socket.destroy()
            server.close(() => done())
          })
      })
    })
  })
}

/** One SNI-routed TLS round trip through the relay edge. */
function throughRelay(routeKey: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect(
      {
        host: '127.0.0.1',
        port: relay.port,
        servername: `${routeKey}.relay.local`,
        rejectUnauthorized: false
      },
      () => socket.write('ping')
    )
    const chunks: Buffer[] = []
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      socket.end()
    })
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    socket.on('error', reject)
    socket.setTimeout(5000, () => {
      socket.destroy()
      reject(new Error('relay tunnel timeout'))
    })
  })
}

before(async () => {
  app = createApp({ port: 0, internalToken: INTERNAL_TOKEN, hostOfflineMs: 120_000 })
  url = `http://127.0.0.1:${await app.listen()}`
  const admin = await fetch(`${url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'admin',
      password: 'Adm1n!',
      devicePubKey: DEVICE_PUB_KEY,
      deviceName: 'u64-admin'
    })
  })
  adminToken = ((await admin.json()) as { accessToken?: string }).accessToken ?? ''
  assert.ok(adminToken !== '')
  certs = makeTlsCerts()
  relay = await startRelay({
    port: 0,
    id: 'relay-u64',
    apiUrl: url,
    internalToken: INTERNAL_TOKEN
  })
})

after(async () => {
  await relay?.close()
  await app?.close()
})

describe('U64 宿主端口漂移传播窗口', () => {
  test('宿主重启换端口：下一拍心跳后 named 路由 target=新端口，中继边缘跟随', async () => {
    const host = await registerHost({ name: 'dev-local-02', directAddrs: [] })
    const view = (await (
      await fetch(`${url}/v1/hosts`, { headers: auth(adminToken) })
    ).json()) as { hosts: ApiHost[] }
    assert.equal(view.hosts.find((h) => h.id === host.hostId)?.relayRoute, 'dev-local-02')

    const first = await startHostListener()
    await heartbeat(host.hostId, host.credential, [`127.0.0.1:${first.port}`])
    const before = routeFor(await routes(), 'dev-local-02')
    assert.ok(before, 'the first beat must backfill the named route')
    assert.equal(before.target, `127.0.0.1:${first.port}`)
    await relay.refresh()
    assert.equal(await throughRelay('dev-local-02'), `host-port:${first.port}`)

    // The runtime comes back on a new port before the old listener is gone.
    const second = await startHostListener()
    assert.notEqual(second.port, first.port)
    await first.close()

    const startedAt = Date.now()
    await heartbeat(host.hostId, host.credential, [`127.0.0.1:${second.port}`])
    const convergedAt = Date.now()
    const after = routeFor(await routes(), 'dev-local-02')
    assert.ok(after, 'the named route must still exist')
    assert.equal(after.target, `127.0.0.1:${second.port}`, 'the beat must move the target')
    assert.equal(after.hostId, host.hostId)
    assert.equal(after.version, before.version, 'a target follow is not a policy change')

    await relay.refresh()
    const served = await throughRelay('dev-local-02')
    assert.equal(served, `host-port:${second.port}`, 'the relay edge must dial the new port')

    saveEvidence(EVIDENCE, 'named-route-port-drift.json', {
      routeKey: 'dev-local-02',
      oldPort: first.port,
      newPort: second.port,
      targetBefore: before.target,
      targetAfter: after.target,
      relayTargetAfter: relay.routes().get('dev-local-02')?.target,
      convergenceMs: convergedAt - startedAt,
      relayEdgeServed: served
    })
    await second.close()
  })

  test('target 相同：重复心跳零写入、无抖动', async () => {
    const host = await registerHost({
      name: 'u64-steady',
      directAddrs: ['127.0.0.1:19101'],
      relayTarget: '127.0.0.1:19101',
      relayRoute: 'u64-steady'
    })
    await heartbeat(host.hostId, host.credential, ['127.0.0.1:19101'])
    const steady = routeFor(await routes(), 'u64-steady')
    assert.equal(steady?.target, '127.0.0.1:19101')

    for (let beat = 0; beat < 3; beat += 1) {
      await heartbeat(host.hostId, host.credential, ['127.0.0.1:19101'])
    }
    const after = routeFor(await routes(), 'u64-steady')
    assert.deepEqual(after, steady, 'the same address must not rewrite the entry')

    saveEvidence(EVIDENCE, 'steady-target-no-write.json', { steady, afterBeats: after })
  })

  test('注册拍显式 relayTarget vs 心跳漂移：最新心跳为准', async () => {
    const host = await registerHost({
      name: 'u64-explicit',
      directAddrs: ['127.0.0.1:19101'],
      relayTarget: '127.0.0.1:9',
      relayRoute: 'u64-explicit'
    })
    const registered = routeFor(await routes(), 'u64-explicit')
    assert.equal(registered?.target, '127.0.0.1:9', 'registration keeps its explicit target')

    // The beat proves the host moved, so its enrolment snapshot is stale.
    await heartbeat(host.hostId, host.credential, ['127.0.0.1:19102'])
    const drifted = routeFor(await routes(), 'u64-explicit')
    assert.equal(drifted?.target, '127.0.0.1:19102')
    assert.equal(drifted?.routeKey, 'u64-explicit', 'an explicit key never renames')

    saveEvidence(EVIDENCE, 'explicit-target-vs-heartbeat.json', {
      registered,
      drifted,
      resolution: 'latest heartbeat wins once directAddrs drifts'
    })
  })

  test('派生 ip- 键不回退：迁移仍携带显式上游（U39/M114a 语义）', async () => {
    const host = await registerHost({
      name: 'u64-derived',
      directAddrs: ['192.168.2.10:5210'],
      relayTarget: '127.0.0.1:9'
    })
    await heartbeat(host.hostId, host.credential, ['192.168.2.11:5210'])

    const table = await routes()
    assert.equal(routeFor(table, 'ip-192-168-2-10'), undefined, 'the old label must be gone')
    const moved = routeFor(table, 'ip-192-168-2-11')
    assert.equal(moved?.target, '127.0.0.1:9', 'syncHostRoute still carries the upstream')
    assert.equal(table.filter((route) => route.hostId === host.hostId).length, 1)

    saveEvidence(EVIDENCE, 'ip-key-carry-over-unchanged.json', { moved })
  })
})
