import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect } from 'node:net'
import { readFileSync } from 'node:fs'
import { WebSocketServer, WebSocket } from 'ws'
import { startRelay, type RelayHandle } from '../../apps/relay/src/relay.ts'
import { makeTlsCerts, saveEvidence } from './harness.ts'

const EVIDENCE = 'm10-relay'

type Api = { close: () => Promise<void>; port: number; setRoutes: (routes: unknown[]) => void }

/** Minimal route-source stand-in so the relay can be exercised without the full API. */
async function startRouteApi(): Promise<Api> {
  let routes: unknown[] = []
  const server = createHttpServer()
  server.on('request', (req, res) => {
    if (req.url === '/v1/internal/relay-routes') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ routes }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as { port: number }).port
  return {
    port,
    setRoutes: (next) => {
      routes = next
    },
    close: () => new Promise<void>((r) => server.close(() => r()))
  }
}

function tlsHelloFor(sni: string): Buffer {
  // Hand-built ClientHello: enough for the relay's SNI parser.
  const name = Buffer.from(sni, 'ascii')
  const serverName = Buffer.concat([
    Buffer.from([0x00]),
    Buffer.from([(name.length >> 8) & 0xff, name.length & 0xff]),
    name
  ])
  const serverNameList = Buffer.concat([
    Buffer.from([(serverName.length >> 8) & 0xff, serverName.length & 0xff]),
    serverName
  ])
  const ext = Buffer.concat([
    Buffer.from([0x00, 0x00, (serverNameList.length >> 8) & 0xff, serverNameList.length & 0xff]),
    serverNameList
  ])
  const extensions = Buffer.concat([
    Buffer.from([(ext.length >> 8) & 0xff, ext.length & 0xff]),
    ext
  ])
  const body = Buffer.concat([
    Buffer.from([0x03, 0x03]),
    Buffer.alloc(32, 7),
    Buffer.from([0x00]), // session id len
    Buffer.from([0x00, 0x02, 0x13, 0x01]), // cipher suites
    Buffer.from([0x01, 0x00]), // compression
    extensions
  ])
  const handshake = Buffer.concat([
    Buffer.from([0x01]),
    Buffer.from([(body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff]),
    body
  ])
  return Buffer.concat([
    Buffer.from([0x16, 0x03, 0x01, (handshake.length >> 8) & 0xff, handshake.length & 0xff]),
    handshake
  ])
}

function attempt(
  sni: string,
  port: number,
  timeoutMs = 1200
): Promise<{ closed: boolean; received: boolean }> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1')
    let received = false
    socket.once('connect', () => socket.write(tlsHelloFor(sni)))
    socket.once('data', () => {
      received = true
    })
    socket.once('close', () => resolve({ closed: !received, received }))
    socket.once('error', () => resolve({ closed: true, received }))
    setTimeout(() => {
      socket.destroy()
      resolve({ closed: !received, received })
    }, timeoutMs)
  })
}

let relay: RelayHandle
let api: Api
let upstreamPort = 0
let upstream: Awaited<ReturnType<typeof startUpstream>>

async function startUpstream(): Promise<{ port: number; close: () => Promise<void> }> {
  const tls = makeTlsCerts()
  const server = createHttpsServer({
    key: readFileSync(tls.key),
    cert: readFileSync(tls.cert)
  })
  const wss = new WebSocketServer({ server })
  wss.on('connection', (ws) => ws.send('upstream-ok'))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  return {
    port: (server.address() as { port: number }).port,
    close: () =>
      new Promise<void>((r) => {
        wss.close()
        server.close(() => r())
      })
  }
}

before(async () => {
  upstream = await startUpstream()
  upstreamPort = upstream.port
  api = await startRouteApi()
  api.setRoutes([
    { routeKey: 'dev-001', hostId: 'host_dev001', target: `127.0.0.1:${upstreamPort}`, version: 1 }
  ])
  relay = await startRelay({
    port: 0,
    apiUrl: `http://127.0.0.1:${api.port}`,
    internalToken: 'internal-test-token',
    maxConnectionsPerIp: 5
  })
})

after(async () => {
  await relay?.close()
  await api?.close()
  await upstream?.close()
})

describe('M10 中继 SNI 白名单与边界', () => {
  test('白名单内 SNI 正常转发并完成 TLS 握手', async () => {
    const ws = new WebSocket(`wss://127.0.0.1:${relay.port}/`, {
      rejectUnauthorized: false,
      servername: 'dev-001.relay.local'
    })
    const message = await new Promise<string>((resolve, reject) => {
      ws.once('message', (data) => resolve(data.toString()))
      ws.once('error', reject)
    })
    ws.close()
    assert.equal(message, 'upstream-ok')
    saveEvidence(EVIDENCE, 'whitelisted-sni-forwarded.json', { message, stats: relay.stats() })
  })

  test('裸主机名（无 relay 后缀）即使等于 routeKey 也被拒', async () => {
    const result = await attempt('dev-001', relay.port)
    assert.equal(result.received, false)
    const stats = relay.stats()
    assert.ok((stats.dropsByReason['sni-not-whitelisted'] ?? 0) >= 1)
    saveEvidence(EVIDENCE, 'bare-hostname-rejected.json', { result, drops: stats.dropsByReason })
  })

  test('同名但不同后缀的域名被拒', async () => {
    const result = await attempt('dev-001.relay.evil.com', relay.port)
    assert.equal(result.received, false)
    const stats = relay.stats()
    assert.ok((stats.dropsByReason['sni-not-whitelisted'] ?? 0) >= 1)
    saveEvidence(EVIDENCE, 'wrong-suffix-rejected.json', { result })
  })

  test('多层子域名被拒（sni-shape-invalid）', async () => {
    const result = await attempt('a.dev-001.relay.local', relay.port)
    assert.equal(result.received, false)
    const stats = relay.stats()
    assert.ok((stats.dropsByReason['sni-shape-invalid'] ?? 0) >= 1)
    saveEvidence(EVIDENCE, 'nested-label-rejected.json', { result })
  })

  test('白名单内但路由不存在时黑洞', async () => {
    const result = await attempt('dev-999.relay.local', relay.port)
    assert.equal(result.received, false)
    const stats = relay.stats()
    assert.ok((stats.dropsByReason['unknown-route'] ?? 0) >= 1)
    saveEvidence(EVIDENCE, 'unknown-route-blackholed.json', { result })
  })

  test('非 TLS 流量被拒（中继不是通用代理）', async () => {
    const closed = await new Promise<boolean>((resolve) => {
      const socket = connect(relay.port, '127.0.0.1')
      socket.once('connect', () => socket.write(Buffer.from('GET / HTTP/1.1\r\nHost: x\r\n\r\n')))
      socket.once('close', () => resolve(true))
      socket.once('error', () => resolve(true))
      setTimeout(() => resolve(!socket.writable), 900)
    })
    assert.equal(closed, true)
    const stats = relay.stats()
    assert.ok((stats.dropsByReason['non-tls'] ?? 0) >= 1)
    saveEvidence(EVIDENCE, 'non-tls-rejected.json', { closed, drops: stats.dropsByReason })
  })

  test('单 IP 并发超限被拒', async () => {
    const sockets = [] as ReturnType<typeof connect>[]
    // Hold connections open by never completing the ClientHello.
    for (let i = 0; i < 5; i++) {
      const socket = connect(relay.port, '127.0.0.1')
      socket.once('connect', () => socket.write(tlsHelloFor('dev-001.relay.local')))
      socket.on('error', () => undefined)
      sockets.push(socket)
    }
    await new Promise((r) => setTimeout(r, 400))

    const extra = await attempt('dev-001.relay.local', relay.port, 900)
    const stats = relay.stats()
    const limited = (stats.dropsByReason['per-ip-limit'] ?? 0) >= 1

    for (const socket of sockets) socket.destroy()
    assert.equal(limited, true, `expected per-ip-limit drop, stats=${JSON.stringify(stats)}`)
    saveEvidence(EVIDENCE, 'per-ip-limit.json', { extra, stats })
  })

  test('连接元数据被记录，且不含负载内容', async () => {
    const events = relay.events()
    assert.ok(events.length > 0, 'events recorded')
    for (const event of events) {
      const keys = Object.keys(event).sort()
      assert.deepEqual(
        keys,
        ['at', 'outcome', 'reason', 'routeKey', 'sni', 'sourceIp', 'target']
          .filter((k) => k in event)
          .sort()
      )
      assert.equal('payload' in event, false)
      assert.equal('credential' in event, false)
    }
    const routed = events.filter((e) => e.outcome === 'routed')
    assert.ok(routed.length >= 1)
    saveEvidence(EVIDENCE, 'connection-metadata.json', { sample: events.slice(-6) })
  })
})
