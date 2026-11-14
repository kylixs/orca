import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { startRelay, type RelayHandle } from '../../apps/relay/src/relay.ts'
import { saveEvidence, spawnService, type Service } from './harness.ts'

/**
 * M114a: a host that does not name its relay route gets `ip-<advertised IP>`,
 * because an intranet hostname resolves unreliably while the IP it advertises is
 * the thing clients can actually reach. That derived key must follow the host
 * when it moves networks, and an explicitly configured key must never move.
 */

const EVIDENCE = 'm114-relay-page'
const INTERNAL_TOKEN = 'm114-route-key-token'
const DEVICE_PUBKEY = Buffer.from('m114-route-key').toString('base64')

let api: Service
let relay: RelayHandle
let adminToken = ''
let devToken = ''
let devDeviceId = ''

type HostView = { id: string; name: string; relayRoute: string | null; directAddrs: string[] }
type RouteEntry = { routeKey: string; hostId: string; target: string }
type RelayEndpoint = { url: string; routeKey: string; sni: string }

function auth(token: string): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${token}` }
}

async function registerHost(body: Record<string, unknown>): Promise<{ hostId: string; credential: string }> {
  const tokenRes = await fetch(`${api.url}/v1/hosts/tokens`, { method: 'POST', headers: auth(adminToken) })
  assert.equal(tokenRes.status, 201)
  const { token } = (await tokenRes.json()) as { token: string }
  const res = await fetch(`${api.url}/v1/hosts/register`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({
      fingerprint: 'sha256:m114-route-key',
      e2eePublicKeyB64: 'test-e2ee-key',
      orcaVersion: '1.5.0',
      protocolVersion: 3,
      networkZone: 'intranet',
      runtimeCapabilities: ['pty'],
      ...body
    })
  })
  const registered = (await res.json()) as { hostId?: string; credential?: string }
  assert.equal(res.status, 201, JSON.stringify(registered))
  assert.ok(registered.hostId && registered.credential)
  return { hostId: registered.hostId, credential: registered.credential }
}

async function heartbeat(
  hostId: string,
  credential: string,
  directAddrs: string[]
): Promise<void> {
  const res = await fetch(`${api.url}/v1/hosts/${hostId}/heartbeat`, {
    method: 'POST',
    headers: auth(credential),
    body: JSON.stringify({ status: 'online', directAddrs })
  })
  assert.equal(res.status, 200)
}

async function hostView(name: string): Promise<HostView> {
  const res = await fetch(`${api.url}/v1/hosts`, { headers: auth(adminToken) })
  assert.equal(res.status, 200)
  const host = ((await res.json()) as { hosts: HostView[] }).hosts.find((h) => h.name === name)
  assert.ok(host, `host ${name} missing`)
  return host
}

async function routeTable(): Promise<RouteEntry[]> {
  const res = await fetch(`${api.url}/v1/internal/relay-routes`, {
    headers: { 'x-internal-token': INTERNAL_TOKEN }
  })
  assert.equal(res.status, 200)
  return ((await res.json()) as { routes: RouteEntry[] }).routes
}

async function projectConnect(hostId: string, key: string): Promise<RelayEndpoint[]> {
  const created = await fetch(`${api.url}/v1/projects`, {
    method: 'POST',
    headers: auth(adminToken),
    body: JSON.stringify({ key, name: key, hostId, path: `/srv/work/${key}` })
  })
  assert.equal(created.status, 201)
  const project = (await created.json()) as { id: string }
  await fetch(`${api.url}/v1/projects/${project.id}/grants`, {
    method: 'PUT',
    headers: auth(adminToken),
    body: JSON.stringify({ subjectType: 'group', subjectId: 'team-payment', permissions: ['open'] })
  })
  const res = await fetch(`${api.url}/v1/projects/${project.id}/connect`, {
    method: 'POST',
    headers: auth(devToken),
    body: JSON.stringify({ deviceId: devDeviceId, devicePubKey: DEVICE_PUBKEY, clientVersion: '1.5.0' })
  })
  const body = (await res.json()) as { endpoints?: { relay: RelayEndpoint[] }; error?: { code: string } }
  assert.equal(res.status, 200, JSON.stringify(body))
  return body.endpoints?.relay ?? []
}

before(async () => {
  api = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-route-key'
  )
  const admin = await fetch(`${api.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'm114-route-key' })
  })
  adminToken = ((await admin.json()) as { accessToken?: string }).accessToken ?? ''
  const dev = await fetch(`${api.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'zhangsan',
      password: 'Passw0rd!',
      devicePubKey: DEVICE_PUBKEY,
      deviceName: 'm114-route-key-dev'
    })
  })
  const devBody = (await dev.json()) as { accessToken?: string; device?: { id: string } }
  devToken = devBody.accessToken ?? ''
  devDeviceId = devBody.device?.id ?? ''
  assert.ok(devToken !== '' && devDeviceId !== '')

  relay = await startRelay({ port: 0, id: 'relay-follow', apiUrl: api.url, internalToken: INTERNAL_TOKEN })
}, 120_000)

after(async () => {
  await relay?.close()
  await api?.stop()
})

describe('M114a 默认路由键取上报 IP 并随心跳跟随', () => {
  test('未命名路由的宿主得到 ip-<IP>，connect 的 SNI 同步', async () => {
    const host = await registerHost({
      name: 'm114-auto',
      directAddrs: ['192.168.2.202:5210'],
      relayTarget: '127.0.0.1:9'
    })
    await heartbeat(host.hostId, host.credential, ['192.168.2.202:5210'])

    const view = await hostView('m114-auto')
    assert.equal(view.relayRoute, 'ip-192-168-2-202')

    const endpoints = await projectConnect(host.hostId, 'm114-auto-svc')
    assert.equal(endpoints[0]?.sni, 'ip-192-168-2-202.relay.local')
    assert.equal(endpoints[0]?.routeKey, 'ip-192-168-2-202')
    assert.equal(endpoints[0]?.url, `wss://127.0.0.1:${relay.port}/`)
    saveEvidence(EVIDENCE, 'route-key-derived.json', { view, endpoint: endpoints[0] })
  })

  test('显式路由键不随 IP 变化', async () => {
    const host = await registerHost({
      name: 'm114-explicit',
      directAddrs: ['10.0.0.8:5210'],
      relayTarget: '127.0.0.1:9',
      relayRoute: 'explicit-route'
    })
    await heartbeat(host.hostId, host.credential, ['10.0.0.9:5210'])

    const view = await hostView('m114-explicit')
    assert.equal(view.relayRoute, 'explicit-route')
    const routes = await routeTable()
    assert.ok(routes.some((route) => route.routeKey === 'explicit-route'))
    assert.equal(routes.some((route) => route.routeKey === 'ip-10-0-0-9'), false)
    saveEvidence(EVIDENCE, 'route-key-explicit.json', { view, routes })
  })

  test('派生路由键随新上报地址迁移，旧键不再解析，重复心跳不抖动', async () => {
    const host = await registerHost({
      name: 'm114-follow',
      directAddrs: ['192.168.2.202:5210'],
      relayTarget: '127.0.0.1:9'
    })
    const before = await routeTable()
    const original = before.find((route) => route.routeKey === 'ip-192-168-2-202')
    assert.ok(original, JSON.stringify(before))

    // Two beats on the moved address: the second must be a no-op, not a churn.
    for (let beat = 0; beat < 2; beat += 1) {
      await heartbeat(host.hostId, host.credential, ['192.168.2.77:5210'])
    }

    const view = await hostView('m114-follow')
    assert.equal(view.relayRoute, 'ip-192-168-2-77')
    const after = await routeTable()
    assert.equal(after.some((route) => route.routeKey === 'ip-192-168-2-202'), false, JSON.stringify(after))
    const moved = after.find((route) => route.routeKey === 'ip-192-168-2-77')
    assert.ok(moved, JSON.stringify(after))
    assert.equal(moved.target, '127.0.0.1:9', 'the upstream target must carry over')
    assert.equal(moved.hostId, host.hostId)
    assert.equal(after.filter((route) => route.hostId === host.hostId).length, 1)

    // The label a client dials is the new one, end to end.
    const endpoints = await projectConnect(host.hostId, 'm114-follow-svc')
    assert.equal(endpoints[0]?.sni, 'ip-192-168-2-77.relay.local')
    saveEvidence(EVIDENCE, 'route-key-follows.json', { before: original, view, moved, endpoint: endpoints[0] })
  })

  test('注册拍无地址的宿主由心跳补齐路由表项，晚同步的中继拉取即得', async () => {
    // The real enrolment order: a host registers before anything listens, so it
    // names a route key with no address behind it yet.
    const host = await registerHost({ name: 'm114-late-addr' })
    assert.equal(
      (await routeTable()).some((route) => route.routeKey === 'm114-late-addr'),
      false
    )

    await heartbeat(host.hostId, host.credential, ['10.0.0.7:5210'])

    const routes = await routeTable()
    const entry = routes.find((route) => route.routeKey === 'm114-late-addr')
    assert.ok(entry, JSON.stringify(routes))
    assert.equal(entry.hostId, host.hostId)
    assert.equal(entry.target, '10.0.0.7:5210')

    // A relay that joined later pulls the full table on its 2s tick; until the
    // entry exists it drops this host's traffic as unknown-route.
    await relay.refresh()
    assert.equal(relay.routes().get('m114-late-addr')?.target, '10.0.0.7:5210')
    assert.ok(relay.routes().size >= 1)
    saveEvidence(EVIDENCE, 'route-backfilled-by-heartbeat.json', {
      entry,
      relayRoutes: [...relay.routes().values()]
    })
  })
})
