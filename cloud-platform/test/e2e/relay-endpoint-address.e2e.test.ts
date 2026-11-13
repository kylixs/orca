import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { startRelay, type RelayHandle } from '../../apps/relay/src/relay.ts'
import {
  registerHost,
  saveEvidence,
  spawnService,
  type Service
} from './harness.ts'

/**
 * M114b: the address a client dials for the relay must be the address the relay
 * is actually reachable on — the announced `RELAY_PUBLIC_HOST` when it has one,
 * otherwise the address the registration came from — and the admin「中继」page
 * must read the same list while a developer is refused (and recorded).
 */

const EVIDENCE = 'm114-relay-page'
const INTERNAL_TOKEN = 'm114-relay-token'
const ROUTE_KEY = 'm114-route'
const DEVICE_PUBKEY = Buffer.from('m114-device').toString('base64')
const EXPLICIT_HOST = 'relay.example.test'

type RelayRow = { id: string; host: string; port: number; online: boolean; lastSeenAt: number }
type RelayEndpoint = { priority: number; url: string; routeKey: string; sni: string }
type ConnectBody = { endpoints: { relay: RelayEndpoint[] }; error?: { code: string } }

let api: Service
let explicitHostRelay: Service
let sourceRelay: RelayHandle
let adminToken = ''
let devToken = ''
let devDeviceId = ''
let projectId = ''

function auth(token: string): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${token}` }
}

async function relayList(token: string): Promise<{ status: number; relays: RelayRow[] }> {
  const res = await fetch(`${api.url}/v1/relays`, { headers: auth(token) })
  const body = (await res.json()) as { relays?: RelayRow[]; error?: { code: string } }
  return { status: res.status, relays: body.relays ?? [] }
}

async function connectTicket(): Promise<ConnectBody> {
  const res = await fetch(`${api.url}/v1/projects/${projectId}/connect`, {
    method: 'POST',
    headers: auth(devToken),
    body: JSON.stringify({ deviceId: devDeviceId, devicePubKey: DEVICE_PUBKEY, clientVersion: '1.5.0' })
  })
  const body = (await res.json()) as ConnectBody
  assert.equal(res.status, 200, JSON.stringify(body))
  return body
}

/** The relay beats every 2s, so a missing node is a timing miss, not an absence. */
async function waitForRelay(
  wanted: (relay: RelayRow) => boolean,
  deadlineMs = 10_000
): Promise<RelayRow> {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    const { relays } = await relayList(adminToken)
    const found = relays.find(wanted)
    if (found) return found
    if (Date.now() > deadline) {
      assert.fail(`wanted relay never registered; saw ${JSON.stringify(relays)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

before(async () => {
  api = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-relay-address'
  )

  const admin = await fetch(`${api.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'm114-admin' })
  })
  adminToken = ((await admin.json()) as { accessToken?: string }).accessToken ?? ''
  assert.notEqual(adminToken, '')

  const dev = await fetch(`${api.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'zhangsan',
      password: 'Passw0rd!',
      devicePubKey: DEVICE_PUBKEY,
      deviceName: 'm114-dev'
    })
  })
  const devBody = (await dev.json()) as { accessToken?: string; device?: { id: string } }
  devToken = devBody.accessToken ?? ''
  devDeviceId = devBody.device?.id ?? ''
  assert.ok(devToken !== '' && devDeviceId !== '')

  const host = await registerHost({
    apiUrl: api.url,
    adminToken,
    name: 'm114-host',
    directAddr: '127.0.0.1:9',
    relayTarget: '127.0.0.1:9',
    relayRoute: ROUTE_KEY
  })
  // `/connect` refuses an offline host, so the ticket below needs a live beat.
  await fetch(`${api.url}/v1/hosts/${host.hostId}/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${host.credential}` },
    body: JSON.stringify({ status: 'online' })
  })

  const created = await fetch(`${api.url}/v1/projects`, {
    method: 'POST',
    headers: auth(adminToken),
    body: JSON.stringify({
      key: 'm114-relay-svc',
      name: 'm114-relay-svc',
      hostId: host.hostId,
      path: '/srv/work/m114-relay-svc'
    })
  })
  assert.equal(created.status, 201)
  projectId = ((await created.json()) as { id: string }).id
  await fetch(`${api.url}/v1/projects/${projectId}/grants`, {
    method: 'PUT',
    headers: auth(adminToken),
    body: JSON.stringify({ subjectType: 'group', subjectId: 'team-payment', permissions: ['open'] })
  })

  // No publicHost: the platform must fall back to the registration's source address.
  sourceRelay = await startRelay({
    port: 0,
    id: 'relay-source',
    apiUrl: api.url,
    internalToken: INTERNAL_TOKEN
  })
}, 120_000)

after(async () => {
  await sourceRelay?.close()
  await explicitHostRelay?.stop()
  await api?.stop()
})

describe('M114b 中继地址与中继管理页门禁', () => {
  test('管理员 /v1/relays 列出来源地址注册的节点且在线', async () => {
    const { status, relays } = await relayList(adminToken)
    assert.equal(status, 200)
    const node = relays.find((relay) => relay.id === 'relay-source')
    assert.ok(node, `relay-source missing: ${JSON.stringify(relays)}`)
    assert.equal(node.host, '127.0.0.1', 'the source address is the fallback')
    assert.equal(node.port, sourceRelay.port)
    assert.equal(node.online, true)
    assert.ok(node.lastSeenAt > 0)
    saveEvidence(EVIDENCE, 'relay-list-source-host.json', { status, node, relays })
  })

  test('/connect 下发的中继端点 = wss://<来源地址>:<port>/ 且 SNI 为路由键', async () => {
    const body = await connectTicket()
    assert.equal(body.endpoints.relay.length, 1, JSON.stringify(body.endpoints))
    const endpoint = body.endpoints.relay[0]!
    assert.equal(endpoint.url, `wss://127.0.0.1:${sourceRelay.port}/`)
    assert.equal(endpoint.sni, `${ROUTE_KEY}.relay.local`)
    assert.equal(endpoint.routeKey, ROUTE_KEY)
    saveEvidence(EVIDENCE, 'connect-endpoint-source-host.json', { endpoint })
  })

  test('显式 RELAY_PUBLIC_HOST 优先于来源 IP', async () => {
    // Spawned, not in-process, so the real CLI path `RELAY_PUBLIC_HOST` → publicHost is exercised.
    explicitHostRelay = await spawnService(
      'apps/relay/src/relay.ts',
      {
        PORT: '0',
        API_URL: api.url,
        INTERNAL_TOKEN,
        RELAY_PUBLIC_HOST: EXPLICIT_HOST
      },
      /\[relay\] listening on :(\d+)/,
      'relay-explicit-host'
    )
    // A PORT=0 relay derives its id from the bound port, so the port is the key.
    const node = await waitForRelay((relay) => relay.port === explicitHostRelay.port)
    assert.equal(node.host, EXPLICIT_HOST)
    assert.equal(node.port, explicitHostRelay.port)
    assert.equal(node.online, true)

    const body = await connectTicket()
    const endpoint = body.endpoints.relay.find((entry) => entry.url.includes(EXPLICIT_HOST))
    assert.ok(endpoint, `explicit-host endpoint missing: ${JSON.stringify(body.endpoints)}`)
    assert.equal(endpoint.url, `wss://${EXPLICIT_HOST}:${explicitHostRelay.port}/`)
    assert.equal(endpoint.sni, `${ROUTE_KEY}.relay.local`)
    saveEvidence(EVIDENCE, 'relay-endpoint-address.json', {
      explicitEnv: `RELAY_PUBLIC_HOST=${EXPLICIT_HOST}`,
      node,
      endpoint,
      allEndpoints: body.endpoints.relay
    })
  })

  test('开发者访问 /v1/relays 403，且拒绝写入 relay_list 审计', async () => {
    const refused = await relayList(devToken)
    assert.equal(refused.status, 403)
    const body = await fetch(`${api.url}/v1/relays`, { headers: auth(devToken) }).then((res) =>
      res.json()
    )
    assert.equal((body as { error?: { code: string } }).error?.code, 'PERMISSION_DENIED')

    const audit = await fetch(`${api.url}/v1/audit/events?eventType=relay_list&result=denied&limit=50`, {
      headers: auth(adminToken)
    })
    assert.equal(audit.status, 200)
    const { events } = (await audit.json()) as {
      events: { actor: string | null; result: string; eventType: string }[]
    }
    assert.ok(
      events.some(
        (event) =>
          event.actor === 'zhangsan' && event.result === 'denied' && event.eventType === 'relay_list'
      ),
      JSON.stringify(events.slice(0, 5))
    )
    saveEvidence(EVIDENCE, 'relay-list-denied-audit.json', {
      status: refused.status,
      errorCode: 'PERMISSION_DENIED',
      deniedEvents: events.slice(0, 5)
    })
  })
})
