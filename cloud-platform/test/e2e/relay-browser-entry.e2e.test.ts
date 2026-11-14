import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { startRelay, type RelayHandle } from '../../apps/relay/src/relay.ts'
import { makeTlsCerts, saveEvidence, spawnService, type Service } from './harness.ts'

/**
 * W6b: a relay that runs browser mode may announce where browsers reach it
 * (RELAY_BROWSER_PUBLIC_HOST), and the platform then splices that into a
 * per-host `browserEntryUrl`. Everything that cannot form a URL the relay's
 * `/h/<routeKey>/` edge would actually serve — no announcing relay, a dotted
 * route key — must stay an empty string, never a dead link.
 */

const EVIDENCE = 'w6b-browser-entry'
const INTERNAL_TOKEN = 'w6b-browser-entry-token'
const BROWSER_PUBLIC_HOST = 'relay-browser.example.test'
const ROUTE_KEY = 'w6b-entry-host'
const DOTTED_ROUTE_KEY = 'w6b.bad.key'
const DEVICE_PUBKEY = Buffer.from('w6b-browser-entry').toString('base64')

let api: Service
let quietApi: Service
let lapseApi: Service | null = null
let announcingRelay: Service
let silentRelay: Service
let lapseRelay: Service | null = null
let bareRelay: RelayHandle | null = null
let quietRelay: RelayHandle | null = null
let adminToken = ''
let devToken = ''
let devDeviceId = ''
/** Runner's own RELAY_BROWSER_PUBLIC_HOST, put back in after(). */
let exportedPublicHost: string | undefined

type RelayRow = {
  id: string
  browserHost: string
  host: string
  port: number
  online: boolean
}
type HostRow = { id: string; name: string; browserEntryUrl: string }
type ProjectRow = { id: string; key: string; browserEntryUrl: string }
type ConnectBody = { host?: { browserEntryUrl?: string }; error?: { code: string } }

function auth(token: string): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${token}` }
}

async function relayList(base = api.url, token = adminToken): Promise<RelayRow[]> {
  const res = await fetch(`${base}/v1/relays`, { headers: auth(token) })
  assert.equal(res.status, 200)
  return ((await res.json()) as { relays: RelayRow[] }).relays
}

/** The relay beats on a timer, so a just-started node is a timing miss. */
async function waitForRelay(
  wanted: (relay: RelayRow) => boolean,
  label: string,
  base = api.url,
  token = adminToken
): Promise<RelayRow> {
  const deadline = Date.now() + 15_000
  for (;;) {
    const res = await fetch(`${base}/v1/relays`, { headers: auth(token) })
    const relays = ((await res.json()) as { relays?: RelayRow[] }).relays ?? []
    const found = relays.find(wanted)
    if (found) return found
    if (Date.now() > deadline) {
      assert.fail(`relay ${label} never registered: ${JSON.stringify(relays)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

async function hostRows(base = api.url, token = adminToken): Promise<HostRow[]> {
  const res = await fetch(`${base}/v1/hosts`, { headers: auth(token) })
  assert.equal(res.status, 200)
  return ((await res.json()) as { hosts: HostRow[] }).hosts
}

async function projectRows(base = api.url): Promise<ProjectRow[]> {
  const res = await fetch(`${base}/v1/projects`, { headers: auth(adminToken) })
  assert.equal(res.status, 200)
  return ((await res.json()) as { projects: ProjectRow[] }).projects
}

async function registerHost(
  name: string,
  relayRoute: string,
  base = api.url,
  token = adminToken
): Promise<HostRow> {
  const tokenRes = await fetch(`${base}/v1/hosts/tokens`, {
    method: 'POST',
    headers: auth(token)
  })
  const { token: hostToken } = (await tokenRes.json()) as { token: string }
  const res = await fetch(`${base}/v1/hosts/register`, {
    method: 'POST',
    headers: auth(hostToken),
    body: JSON.stringify({
      name,
      fingerprint: `sha256:${name}`,
      e2eePublicKeyB64: 'test-e2ee-key',
      orcaVersion: '1.5.0',
      protocolVersion: 3,
      networkZone: 'intranet',
      runtimeCapabilities: ['pty'],
      directAddrs: [],
      relayTarget: '127.0.0.1:9',
      relayRoute
    })
  })
  assert.equal(res.status, 201, await res.text())
  const view = (await hostRows(base, token)).find((h) => h.name === name)
  assert.ok(view, `host ${name} missing`)
  return view
}

before(async () => {
  // spawnService forwards process.env and in-process relays read this var at
  // announce time, so a developer's exported RELAY_BROWSER_PUBLIC_HOST would
  // leak into the "silent" relays below and fake a failure. Restored in after().
  exportedPublicHost = process.env.RELAY_BROWSER_PUBLIC_HOST
  delete process.env.RELAY_BROWSER_PUBLIC_HOST
  api = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-w6b'
  )
  const admin = await fetch(`${api.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'w6b-admin' })
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
      deviceName: 'w6b-dev'
    })
  })
  const devBody = (await dev.json()) as { accessToken?: string; device?: { id: string } }
  devToken = devBody.accessToken ?? ''
  devDeviceId = devBody.device?.id ?? ''
  assert.ok(devToken !== '' && devDeviceId !== '')

  const browserCerts = makeTlsCerts()
  const browserEnv = {
    RELAY_BROWSER_TLS_CERT: browserCerts.cert,
    RELAY_BROWSER_TLS_KEY: browserCerts.key,
    RELAY_BROWSER_PORT: '0'
  }
  // Browser mode on, public host announced: the only relay the platform may name.
  announcingRelay = await spawnService(
    'apps/relay/src/relay.ts',
    {
      PORT: '0',
      API_URL: api.url,
      INTERNAL_TOKEN,
      ...browserEnv,
      RELAY_BROWSER_PUBLIC_HOST: BROWSER_PUBLIC_HOST
    },
    /\[relay\] listening on :(\d+)/,
    'relay-w6b-announcing'
  )
  // Browser mode on, nothing announced: an edge no URL can name.
  silentRelay = await spawnService(
    'apps/relay/src/relay.ts',
    { PORT: '0', API_URL: api.url, INTERNAL_TOKEN, ...browserEnv },
    /\[relay\] listening on :(\d+)/,
    'relay-w6b-silent'
  )
  // Browser mode entirely off: the pre-W6b body, which must stay wire compatible.
  // It never reads the public-host env — the absent options.browser short-circuits
  // the announce branch — so the sanitization above is belt-and-braces here.
  bareRelay = await startRelay({
    port: 0,
    id: 'relay-w6b-bare',
    apiUrl: api.url,
    internalToken: INTERNAL_TOKEN
  })
}, 120_000)

after(async () => {
  if (exportedPublicHost !== undefined) process.env.RELAY_BROWSER_PUBLIC_HOST = exportedPublicHost
  await bareRelay?.close()
  await quietRelay?.close()
  await lapseRelay?.stop()
  await announcingRelay?.stop()
  await silentRelay?.stop()
  await api?.stop()
  await quietApi?.stop()
  await lapseApi?.stop()
})

describe('W6b 平台浏览器入口字段', () => {
  test('/v1/relays：宣告了 PUBLIC_HOST 的中继带 browserHost，其余为空串', async () => {
    // Spawned relays register as relay:<port> (no id env), so match by port.
    const announced = await waitForRelay(
      (relay) => relay.port === announcingRelay.port,
      'announcing'
    )
    assert.equal(announced.browserHost, BROWSER_PUBLIC_HOST)
    const silent = await waitForRelay((relay) => relay.port === silentRelay.port, 'silent')
    assert.equal(silent.browserHost, '', 'an unnamed edge must not be advertised')
    const bare = await waitForRelay((relay) => relay.id === 'relay-w6b-bare', 'bare')
    assert.equal(bare.browserHost, '', 'a relay without browser mode stays silent')
    saveEvidence(EVIDENCE, 'relay-list.json', {
      announced,
      silent,
      bare,
      relays: await relayList()
    })
  })

  test('宿主 payload：合法 routeKey 拼出入口，带点 routeKey 为空串', async () => {
    const valid = await registerHost('w6b-valid-host', ROUTE_KEY)
    const dotted = await registerHost('w6b-dotted-host', DOTTED_ROUTE_KEY)
    assert.equal(
      valid.browserEntryUrl,
      `https://${BROWSER_PUBLIC_HOST}/h/${ROUTE_KEY}/web-index.html`
    )
    assert.equal(
      dotted.browserEntryUrl,
      '',
      'the relay refuses dotted route keys, so name no entry'
    )
    saveEvidence(EVIDENCE, 'host-payload.json', { valid, dotted })
  })

  test('项目 payload：browserEntryUrl 跟随宿主 routeKey', async () => {
    const hosts = await hostRows()
    const valid = hosts.find((h) => h.name === 'w6b-valid-host')
    const dotted = hosts.find((h) => h.name === 'w6b-dotted-host')
    assert.ok(valid && dotted, JSON.stringify(hosts))
    for (const [key, host] of [
      ['w6b-on-valid', valid],
      ['w6b-on-dotted', dotted]
    ] as const) {
      const res = await fetch(`${api.url}/v1/projects`, {
        method: 'POST',
        headers: auth(adminToken),
        body: JSON.stringify({ key, name: key, hostId: host.id, path: `/srv/work/${key}` })
      })
      assert.equal(res.status, 201, await res.text())
    }
    const projects = await projectRows()
    const onValid = projects.find((p) => p.key === 'w6b-on-valid')
    const onDotted = projects.find((p) => p.key === 'w6b-on-dotted')
    assert.ok(onValid && onDotted, JSON.stringify(projects))
    assert.equal(
      onValid.browserEntryUrl,
      `https://${BROWSER_PUBLIC_HOST}/h/${ROUTE_KEY}/web-index.html`
    )
    assert.equal(onDotted.browserEntryUrl, '')
    saveEvidence(EVIDENCE, 'project-payload.json', { onValid, onDotted })
  })

  test('connect 响应的宿主 payload 带同一入口', async () => {
    const project = (await projectRows()).find((p) => p.key === 'w6b-on-valid')
    assert.ok(project, 'project missing')
    await fetch(`${api.url}/v1/projects/${project.id}/grants`, {
      method: 'PUT',
      headers: auth(adminToken),
      body: JSON.stringify({
        subjectType: 'group',
        subjectId: 'team-payment',
        permissions: ['open']
      })
    })
    const res = await fetch(`${api.url}/v1/projects/${project.id}/connect`, {
      method: 'POST',
      headers: auth(devToken),
      body: JSON.stringify({
        deviceId: devDeviceId,
        devicePubKey: DEVICE_PUBKEY,
        clientVersion: '1.5.0'
      })
    })
    const body = (await res.json()) as ConnectBody
    assert.equal(res.status, 200, JSON.stringify(body))
    assert.equal(
      body.host?.browserEntryUrl,
      `https://${BROWSER_PUBLIC_HOST}/h/${ROUTE_KEY}/web-index.html`
    )
    saveEvidence(EVIDENCE, 'connect-payload.json', { browserEntryUrl: body.host?.browserEntryUrl })
  })

  test('无中继宣告 browserHost：入口一律空串', async () => {
    quietApi = await spawnService(
      'apps/api/src/server.ts',
      { PORT: '0', INTERNAL_TOKEN: `${INTERNAL_TOKEN}-quiet` },
      /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
      'api-w6b-quiet'
    )
    const admin = await fetch(`${quietApi.url}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'w6b-quiet-admin' })
    })
    const quietToken = ((await admin.json()) as { accessToken?: string }).accessToken ?? ''
    assert.notEqual(quietToken, '')
    const previousToken = adminToken
    adminToken = quietToken
    try {
      // Browser mode on, but RELAY_BROWSER_PUBLIC_HOST unset: an edge with no name.
      const certs = makeTlsCerts()
      quietRelay = await startRelay({
        port: 0,
        id: 'relay-w6b-quiet',
        apiUrl: quietApi.url,
        internalToken: `${INTERNAL_TOKEN}-quiet`,
        browser: { port: 0, certPath: certs.cert, keyPath: certs.key }
      })
      const listed = await waitForRelay(
        (relay) => relay.id === 'relay-w6b-quiet',
        'quiet',
        quietApi.url,
        quietToken
      )
      assert.equal(listed.browserHost, '', 'browser mode alone names no entry')

      const alone = await registerHost('w6b-quiet-host', 'w6b-quiet-host', quietApi.url)
      assert.equal(alone.browserEntryUrl, '', 'no announcing relay, no entry URL')
      const created = await fetch(`${quietApi.url}/v1/projects`, {
        method: 'POST',
        headers: auth(quietToken),
        body: JSON.stringify({
          key: 'w6b-quiet-project',
          name: 'w6b-quiet-project',
          hostId: alone.id,
          path: '/srv/work/w6b-quiet-project'
        })
      })
      assert.equal(created.status, 201, await created.text())
      const project = (await projectRows(quietApi.url)).find((p) => p.key === 'w6b-quiet-project')
      assert.ok(project, 'project missing')
      assert.equal(project.browserEntryUrl, '')
      saveEvidence(EVIDENCE, 'no-announced-host.json', { listed, host: alone, project })
    } finally {
      adminToken = previousToken
    }
  }, 60_000)

  test('宣告中继掉线超窗：last-known 死宣告不再拼出入口 URL', async () => {
    // Alive window 6s against the 2s announce beat: a live relay stays
    // comfortably healthy, a stopped one lapses within one window.
    lapseApi = await spawnService(
      'apps/api/src/server.ts',
      { PORT: '0', INTERNAL_TOKEN, ORCA_CLOUD_RELAY_ALIVE_MS: '6000' },
      /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
      'api-w6b-lapse'
    )
    const admin = await fetch(`${lapseApi.url}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'w6b-lapse-admin' })
    })
    const lapseToken = ((await admin.json()) as { accessToken?: string }).accessToken ?? ''
    assert.notEqual(lapseToken, '')
    const certs = makeTlsCerts()
    const relay = await spawnService(
      'apps/relay/src/relay.ts',
      {
        PORT: '0',
        API_URL: lapseApi.url,
        INTERNAL_TOKEN,
        RELAY_BROWSER_TLS_CERT: certs.cert,
        RELAY_BROWSER_TLS_KEY: certs.key,
        RELAY_BROWSER_PORT: '0',
        RELAY_BROWSER_PUBLIC_HOST: BROWSER_PUBLIC_HOST
      },
      /\[relay\] listening on :(\d+)/,
      'relay-w6b-lapse'
    )
    lapseRelay = relay
    const announced = await waitForRelay(
      (row) => row.port === relay.port,
      'lapse',
      lapseApi.url,
      lapseToken
    )
    assert.equal(announced.browserHost, BROWSER_PUBLIC_HOST)
    const live = await registerHost('w6b-lapse-host', 'w6b-lapse-host', lapseApi.url, lapseToken)
    assert.equal(
      live.browserEntryUrl,
      `https://${BROWSER_PUBLIC_HOST}/h/w6b-lapse-host/web-index.html`,
      'a live announcement still names the entry'
    )

    await relay.stop()
    // The registry never evicts, so the row stays listed with its stale
    // announcement — it is the entry URL that must go, not the row.
    const deadline = Date.now() + 20_000
    let lapsed: RelayRow | undefined
    for (;;) {
      const rows = await relayList(lapseApi.url, lapseToken)
      const row = rows.find((candidate) => candidate.port === relay.port)
      if (row && !row.online) {
        lapsed = row
        break
      }
      if (Date.now() > deadline) assert.fail(`relay never lapsed: ${JSON.stringify(rows)}`)
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    assert.equal(lapsed.browserHost, BROWSER_PUBLIC_HOST, 'last-known announcement stays listed')
    const after = (await hostRows(lapseApi.url, lapseToken)).find(
      (h) => h.name === 'w6b-lapse-host'
    )
    assert.ok(after, 'host missing')
    assert.equal(after.browserEntryUrl, '', 'a dead announcement must not mint an entry URL')
    saveEvidence(EVIDENCE, 'lapsed-relay-entry.json', { lapsed, host: after })
  }, 60_000)
})
