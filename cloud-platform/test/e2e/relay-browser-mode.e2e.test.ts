import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { request as tlsRequest } from 'node:https'
import { WebSocket } from 'ws'
import { startRelay, type RelayHandle } from '../../apps/relay/src/relay.ts'
import { makeTlsCerts, saveEvidence, spawnService, type Service } from './harness.ts'

/**
 * W6a / M121: the relay's browser edge terminates TLS with its own certificate
 * and routes `/h/<routeKey>/...` onto the same route table the SNI listener
 * uses, while the SNI passthrough listener keeps its existing behaviour.
 * Three real processes: platform, relay (spawned with the env wiring), host.
 */

const EVIDENCE = 'w6a-relay-browser'
const INTERNAL_TOKEN = 'w6a-relay-token'
const ROUTE_KEY = 'w6a-host'

let api: Service
let host: Service
let relay: Service
let relaySniPort = 0
let browserPort = 0
let bareRelay: RelayHandle | null = null

type HostView = {
  path: string
  method: string
  body: string
  forwarded: { for: string | null; proto: string | null; host: string | null }
}

function waitForLog(service: Service, pattern: RegExp, timeoutMs = 15_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = (): void => {
      const match = pattern.exec(service.logs.join(''))
      if (match) return resolve(Number(match[1]))
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`log never matched ${pattern}: ${service.logs.join('')}`))
      }
      setTimeout(tick, 100)
    }
    tick()
  })
}

/** GET through the browser edge; the host's self-signed cert is expected here. */
function browserGet(path: string, port = browserPort): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = tlsRequest(
      { host: '127.0.0.1', port, path, servername: 'relay-browser.test', rejectUnauthorized: false },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
        )
      }
    )
    req.on('error', reject)
    req.end()
  })
}

/** Polls the edge until the relay's first route sync lands (503 until then). */
async function waitUntilRouted(path: string): Promise<{ status: number; body: string }> {
  const deadline = Date.now() + 15_000
  let last = { status: 0, body: '' }
  while (Date.now() < deadline) {
    last = await browserGet(path)
    if (last.status === 200) return last
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return last
}

before(async () => {
  api = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-w6a'
  )
  const admin = await fetch(`${api.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'w6a-admin' })
  })
  const adminToken = ((await admin.json()) as { accessToken?: string }).accessToken ?? ''
  assert.notEqual(adminToken, '')

  const hostCerts = makeTlsCerts()
  const browserCerts = makeTlsCerts()
  host = await spawnService(
    'test/e2e/relay-target-host.ts',
    { PORT: '0', TLS_KEY: hostCerts.key, TLS_CERT: hostCerts.cert },
    /\[relay-target-host\] listening on :(\d+)/,
    'relay-target-host'
  )

  const tokenRes = await fetch(`${api.url}/v1/hosts/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}` }
  })
  const hostToken = ((await tokenRes.json()) as { token?: string }).token ?? ''
  const registered = await fetch(`${api.url}/v1/hosts/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${hostToken}` },
    body: JSON.stringify({
      name: ROUTE_KEY,
      fingerprint: 'sha256:w6a',
      e2eePublicKeyB64: 'test-e2ee-key',
      orcaVersion: '1.5.0',
      protocolVersion: 3,
      networkZone: 'intranet',
      directAddrs: [],
      relayTarget: `127.0.0.1:${host.port}`,
      relayRoute: ROUTE_KEY,
      runtimeCapabilities: ['pty', 'files']
    })
  })
  assert.equal(registered.status, 201, await registered.text())

  relay = await spawnService(
    'apps/relay/src/relay.ts',
    {
      PORT: '0',
      API_URL: api.url,
      INTERNAL_TOKEN,
      RELAY_BROWSER_TLS_CERT: browserCerts.cert,
      RELAY_BROWSER_TLS_KEY: browserCerts.key,
      RELAY_BROWSER_PORT: '0'
    },
    /\[relay\] browser mode listening on :(\d+)/,
    'relay-w6a'
  )
  browserPort = relay.port
  relaySniPort = await waitForLog(relay, /\[relay\] listening on :(\d+)/)
}, 60_000)

after(async () => {
  await bareRelay?.close()
  await relay?.stop()
  await host?.stop()
  await api?.stop()
})

describe('W6a 中继浏览器模式监听', () => {
  test('HTTP /h/<routeKey>/ 转发到宿主：剥前缀并带 X-Forwarded-*', async () => {
    const res = await waitUntilRouted(`/h/${ROUTE_KEY}/web-index.html`)
    assert.equal(res.status, 200, res.body)
    const seen = JSON.parse(res.body) as HostView
    assert.equal(seen.path, '/web-index.html', 'the /h/<routeKey> prefix must be stripped')
    assert.equal(seen.method, 'GET')
    assert.equal(seen.forwarded.proto, 'https')
    assert.ok((seen.forwarded.for ?? '').includes('127.0.0.1'), 'client address recorded')
    assert.equal(seen.forwarded.host, `127.0.0.1:${browserPort}`)
    saveEvidence(EVIDENCE, 'http-forward.json', { seen, browserPort, relaySniPort })
  })

  test('WSS 升级按同一规则转发（剥前缀，双向可用）', async () => {
    const ws = new WebSocket(`wss://127.0.0.1:${browserPort}/h/${ROUTE_KEY}/ws`, {
      rejectUnauthorized: false
    })
    const greeting = await new Promise<string>((resolve, reject) => {
      ws.once('message', (data) => resolve(data.toString()))
      ws.once('error', reject)
    })
    assert.equal(greeting, 'w6a-host-ok')
    const echoed = await new Promise<string>((resolve, reject) => {
      ws.once('message', (data) => resolve(data.toString()))
      ws.send('ping-w6a')
      setTimeout(() => reject(new Error('echo timeout')), 5_000)
    })
    assert.equal(echoed, 'echo:ping-w6a', 'upgraded socket must stay bidirectional')
    ws.close()
    saveEvidence(EVIDENCE, 'wss-forward.json', { greeting, echoed })
  })

  test('未知 routeKey：HTTP 与升级请求都是 404', async () => {
    const http = await browserGet('/h/no-such-host/web-index.html')
    assert.equal(http.status, 404)
    assert.notEqual(http.status, 502, 'a miss must not reach any host')

    const upgradeStatus = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`wss://127.0.0.1:${browserPort}/h/no-such-host/ws`, {
        rejectUnauthorized: false
      })
      let settled = false
      const done = (status: number): void => {
        if (settled) return
        settled = true
        ws.terminate()
        resolve(status)
      }
      ws.once('unexpected-response', (_req, res) => done(res.statusCode ?? 0))
      ws.once('error', () => done(0))
      ws.once('open', () => done(101))
      setTimeout(() => done(0), 5_000)
    })
    assert.equal(upgradeStatus, 404, 'an upgrade to an unknown route is refused, not blackholed')
    saveEvidence(EVIDENCE, 'unknown-route-404.json', { httpStatus: http.status, upgradeStatus })
  })

  test('非 /h/ 路径不路由', async () => {
    const res = await browserGet('/web-index.html')
    assert.equal(res.status, 404)
    saveEvidence(EVIDENCE, 'non-route-path-404.json', { status: res.status })
  })

  test('SNI 透传监听与既有行为一致（同进程共存的另一端口）', async () => {
    const message = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`wss://127.0.0.1:${relaySniPort}/`, {
        rejectUnauthorized: false,
        servername: `${ROUTE_KEY}.relay.local`,
        handshakeTimeout: 5_000
      })
      ws.once('message', (data) => resolve(data.toString()))
      ws.once('error', reject)
    })
    assert.equal(message, 'w6a-host-ok', 'raw TLS passthrough still reaches the host untouched')
    saveEvidence(EVIDENCE, 'sni-mode-unchanged.json', { relaySniPort, message })
  })

  test('未配置浏览器证书：监听完全不启用', async () => {
    // In-process: the handle reports no browser port.
    bareRelay = await startRelay({
      port: 0,
      apiUrl: api.url,
      internalToken: INTERNAL_TOKEN
    })
    assert.equal(bareRelay.browserPort, null)

    // Spawned process: the env vars are simply absent, and no browser line ever appears.
    const bare = await spawnService(
      'apps/relay/src/relay.ts',
      { PORT: '0', API_URL: api.url, INTERNAL_TOKEN },
      /\[relay\] listening on :(\d+)/,
      'relay-w6a-bare'
    )
    try {
      await new Promise((resolve) => setTimeout(resolve, 2_500))
      assert.equal(/\[relay\] browser mode/.test(bare.logs.join('')), false)
      saveEvidence(EVIDENCE, 'browser-disabled.json', {
        inProcessBrowserPort: bareRelay?.browserPort ?? null,
        spawnedLogs: bare.logs.join('').trim().split('\n')
      })
    } finally {
      await bare.stop()
    }
  }, 30_000)
})
