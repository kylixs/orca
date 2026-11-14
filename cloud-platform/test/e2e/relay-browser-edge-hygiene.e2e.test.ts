import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse
} from 'node:http'
import { createServer as createHttpsServer, request as tlsRequest } from 'node:https'
import { connect as connectTcp, type Server as NetServer } from 'node:net'
import { connect as connectTls, type TLSSocket } from 'node:tls'
import { readFileSync } from 'node:fs'
import { WebSocket, WebSocketServer } from 'ws'
import {
  startRelay,
  type RelayHandle,
  type RelayOptions,
  type RelayRoute
} from '../../apps/relay/src/relay.ts'
import { makeTlsCerts, saveEvidence } from './harness.ts'

/**
 * W6a audit re-dispatch regressions for the browser edge (MAJ-1/MAJ-2/MIN-1/
 * MIN-3): a client that disappears mid-flight must reap the upstream socket it
 * caused, the browser listener holds the same per-IP budget as the SNI
 * listener, a stale route table reads as 503 on upgrades too, and upgrade
 * request headers follow the same hop-by-hop rule as plain HTTP.
 */

const TOKEN = 'w6a-hygiene-token'
const KEY = 'w6a-hygiene-host'
const EVIDENCE = 'w6a-fixes'

type RouteSource = {
  url: string
  setUp: () => void
  setDown: () => void
  close: () => Promise<void>
}

/**
 * The relay's only control-plane peer. "Down" means the platform accepts but
 * never answers, which ages the relay's table past its TTL in milliseconds.
 */
async function startRouteSource(routes: RelayRoute[]): Promise<RouteSource> {
  let down = false
  const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    if (down) return
    if (req.url === '/v1/internal/relay-routes') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ routes }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return {
    url: `http://127.0.0.1:${port}`,
    setUp: () => {
      down = false
    },
    setDown: () => {
      down = true
    },
    close: () =>
      new Promise<void>((resolve) => {
        // Hung "down" sockets would keep the relay's handle alive past close().
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

/** Live server-side TCP connections: where a relay leak shows up first. */
function liveCount(server: NetServer): Promise<number> {
  return new Promise((resolve, reject) =>
    server.getConnections((err, count) => (err ? reject(err) : resolve(count)))
  )
}

type SilentHost = { port: number; liveCount: () => Promise<number>; close: () => Promise<void> }

/**
 * Host hop that reads the request and then never answers, so the relay's
 * upgrade window stays open and a leaked dial stays visible on the host side.
 * It must read: a host that never reads cannot observe its peer's abort at all.
 */
async function startSilentHost(): Promise<SilentHost> {
  const certs = makeTlsCerts()
  const server = createHttpsServer(
    { key: readFileSync(certs.key), cert: readFileSync(certs.cert) },
    (_req, res) => res.on('error', () => undefined)
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return {
    port,
    liveCount: () => liveCount(server),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

type EchoHost = { port: number; liveCount: () => Promise<number>; close: () => Promise<void> }

/**
 * Host hop that answers HTTP with the request it saw (path, method, body,
 * headers) and WSS with the upgrade headers plus frame echo.
 */
async function startEchoHost(): Promise<EchoHost> {
  const certs = makeTlsCerts()
  const server = createHttpsServer(
    { key: readFileSync(certs.key), cert: readFileSync(certs.cert) },
    (req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            path: req.url,
            method: req.method,
            body: Buffer.concat(chunks).toString('utf8'),
            headers: req.headers
          })
        )
      })
    }
  )
  const wss = new WebSocketServer({ server })
  wss.on('connection', (ws, req) => {
    ws.send(JSON.stringify({ greeting: 'echo-host-ok', headers: req.headers }))
    ws.on('message', (data) => ws.send(`echo:${data.toString()}`))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return {
    port,
    liveCount: () => liveCount(server),
    close: () =>
      new Promise<void>((resolve) => {
        wss.close()
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

async function startBrowserRelay(
  source: RouteSource,
  extra: Partial<RelayOptions> = {}
): Promise<{ relay: RelayHandle; browserPort: number }> {
  const certs = makeTlsCerts()
  const relay = await startRelay({
    port: 0,
    apiUrl: source.url,
    internalToken: TOKEN,
    ...extra,
    browser: { port: 0, certPath: certs.cert, keyPath: certs.key }
  })
  const browserPort = relay.browserPort ?? 0
  assert.ok(browserPort > 0, 'browser listener must be enabled for these regressions')
  return { relay, browserPort }
}

/** Polls until `probe` holds; the timeout message carries `detail` for triage. */
async function waitFor(
  label: string,
  probe: () => boolean | Promise<boolean>,
  detail: () => string | Promise<string>,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await probe()) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}: ${await detail()}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

function browserGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = tlsRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        servername: 'relay-browser.test',
        rejectUnauthorized: false
      },
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

/** The status the browser edge answers an upgrade with (101 / refusal / 0). */
function upgradeStatus(port: number, path: string): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`wss://127.0.0.1:${port}${path}`, { rejectUnauthorized: false })
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
}

function tlsDial(port: number): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = connectTls(
      { host: '127.0.0.1', port, servername: 'relay-browser.test', rejectUnauthorized: false },
      () => resolve(socket)
    )
    socket.once('error', reject)
  })
}

describe('W6a 回派回归：浏览器边缘 socket 卫生与 per-IP 上限', () => {
  test('MAJ-1 升级半开：101 之前客户端断开，宿主侧 socket 归零', async () => {
    const host = await startSilentHost()
    const source = await startRouteSource([
      { routeKey: KEY, hostId: 'host_hygiene', target: `127.0.0.1:${host.port}`, version: 1 }
    ])
    const { relay, browserPort } = await startBrowserRelay(source)
    try {
      const client = await tlsDial(browserPort)
      client.write(
        [
          `GET /h/${KEY}/ws HTTP/1.1`,
          `Host: 127.0.0.1:${browserPort}`,
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version: 13',
          '\r\n'
        ].join('\r\n')
      )
      // Precondition: the abandoned client really did cause a host-side dial.
      await waitFor(
        'the upstream dial to reach the host',
        async () => (await host.liveCount()) >= 1,
        async () => `hostLive=${await host.liveCount()}`
      )
      client.destroy()
      await waitFor(
        'the host-side socket to be reaped',
        async () => (await host.liveCount()) === 0,
        async () => `hostLive=${await host.liveCount()} stats=${JSON.stringify(relay.stats())}`
      )
      await waitFor(
        'active to drop back to zero',
        () => relay.stats().active === 0,
        () => `stats=${JSON.stringify(relay.stats())}`
      )
      saveEvidence(EVIDENCE, 'maj1-upgrade-half-open.json', {
        hostLiveAfterClientAbort: await host.liveCount(),
        stats: relay.stats()
      })
    } finally {
      await relay.close()
      await source.close()
      await host.close()
    }
  }, { timeout: 20_000 })

  test('MAJ-1 请求半体：POST 中途断开，宿主侧 socket 归零', async () => {
    const host = await startEchoHost()
    const source = await startRouteSource([
      { routeKey: KEY, hostId: 'host_hygiene', target: `127.0.0.1:${host.port}`, version: 1 }
    ])
    const { relay, browserPort } = await startBrowserRelay(source)
    try {
      const client = await tlsDial(browserPort)
      client.write(
        [
          `POST /h/${KEY}/upload HTTP/1.1`,
          `Host: 127.0.0.1:${browserPort}`,
          'Content-Type: text/plain',
          'Content-Length: 4096',
          '\r\n',
          'half-of-the-body-then-the-client-vanishes'
        ].join('\r\n')
      )
      await waitFor(
        'the upstream dial to reach the host',
        async () => (await host.liveCount()) >= 1,
        async () => `hostLive=${await host.liveCount()}`
      )
      client.destroy()
      await waitFor(
        'the host-side socket to be reaped',
        async () => (await host.liveCount()) === 0,
        async () => `hostLive=${await host.liveCount()} stats=${JSON.stringify(relay.stats())}`
      )
      // A complete request right after must still make the full round trip.
      const payload = 'complete-body-after-the-abort'
      const after = await new Promise<string>((resolve, reject) => {
        const req = tlsRequest(
          {
            host: '127.0.0.1',
            port: browserPort,
            path: `/h/${KEY}/upload`,
            method: 'POST',
            servername: 'relay-browser.test',
            rejectUnauthorized: false
          },
          (res) => {
            const chunks: Buffer[] = []
            res.on('data', (chunk: Buffer) => chunks.push(chunk))
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
          }
        )
        req.on('error', reject)
        req.end(payload)
      })
      const seen = JSON.parse(after) as { body: string }
      assert.equal(seen.body, payload, 'the relay must keep serving complete requests')
      saveEvidence(EVIDENCE, 'maj1-request-half-body.json', {
        hostLiveAfterClientAbort: await host.liveCount(),
        completeRequestStillServed: seen.body === payload
      })
    } finally {
      await relay.close()
      await source.close()
      await host.close()
    }
  }, { timeout: 20_000 })

  test('MAJ-2 浏览器监听单 IP 超限拒绝并计入 active', async () => {
    const host = await startEchoHost()
    const source = await startRouteSource([
      { routeKey: KEY, hostId: 'host_hygiene', target: `127.0.0.1:${host.port}`, version: 1 }
    ])
    const { relay, browserPort } = await startBrowserRelay(source, { maxConnectionsPerIp: 2 })
    try {
      // Raw dials that never complete a handshake: cheap way to hold two slots.
      const held = [connectTcp(browserPort), connectTcp(browserPort)]
      await waitFor(
        'both held sockets to count as active',
        () => relay.stats().active === 2,
        () => `stats=${JSON.stringify(relay.stats())}`
      )
      const over = connectTcp(browserPort)
      over.on('error', () => undefined)
      const closedUnserved = await new Promise<boolean>((resolve) => {
        over.once('close', () => resolve(over.bytesRead === 0))
        setTimeout(() => resolve(false), 2_000)
      })
      assert.equal(closedUnserved, true, 'the over-limit connection must be refused, not served')
      const whileFull = relay.stats()
      assert.ok(
        (whileFull.dropsByReason['per-ip-limit'] ?? 0) >= 1,
        `expected a per-ip-limit drop, stats=${JSON.stringify(whileFull)}`
      )
      for (const socket of held) socket.destroy()
      await waitFor(
        'the slots to free up',
        () => relay.stats().active === 0,
        () => `stats=${JSON.stringify(relay.stats())}`
      )
      const served = await browserGet(browserPort, `/h/${KEY}/after-cap.json`)
      assert.equal(served.status, 200, 'a released slot must admit new work again')
      saveEvidence(EVIDENCE, 'maj2-per-ip-limit.json', {
        activeWhileHeld: 2,
        overLimitConnectionClosed: closedUnserved,
        dropsByReason: whileFull.dropsByReason,
        activeAfterRelease: relay.stats().active,
        recoveredStatus: served.status
      })
    } finally {
      await relay.close()
      await source.close()
      await host.close()
    }
  }, { timeout: 20_000 })

  test('MIN-1 路由表过期：升级与 HTTP 同答 503，恢复后回 101', async () => {
    const host = await startEchoHost()
    const source = await startRouteSource([
      { routeKey: KEY, hostId: 'host_hygiene', target: `127.0.0.1:${host.port}`, version: 1 }
    ])
    const { relay, browserPort } = await startBrowserRelay(source, { routeStaleMaxMs: 300 })
    try {
      const healthy = await browserGet(browserPort, `/h/${KEY}/before.json`)
      assert.equal(healthy.status, 200, healthy.body)
      source.setDown()
      await waitFor(
        'the table to age past the TTL',
        async () => (await browserGet(browserPort, `/h/${KEY}/stale.json`)).status === 503,
        () => `stats=${JSON.stringify(relay.stats())}`
      )
      const staleUpgrade = await upgradeStatus(browserPort, `/h/${KEY}/ws`)
      assert.equal(staleUpgrade, 503, 'a stale table means "retry soon", not "no such host"')
      source.setUp()
      await waitFor(
        'routes to resync',
        async () => (await browserGet(browserPort, `/h/${KEY}/after.json`)).status === 200,
        () => `stats=${JSON.stringify(relay.stats())}`,
        10_000
      )
      const recoveredUpgrade = await upgradeStatus(browserPort, `/h/${KEY}/ws`)
      assert.equal(recoveredUpgrade, 101, 'recovery must restore the upgrade path')
      saveEvidence(EVIDENCE, 'min1-stale-upgrade-503.json', {
        healthyBefore: healthy.status,
        staleUpgrade,
        recoveredUpgrade
      })
    } finally {
      await relay.close()
      await source.close()
      await host.close()
    }
  }, { timeout: 30_000 })

  test('MIN-3 升级路径 hop-by-hop：剥代理头，保 WS 必需头与端到端头', async () => {
    const host = await startEchoHost()
    const source = await startRouteSource([
      { routeKey: KEY, hostId: 'host_hygiene', target: `127.0.0.1:${host.port}`, version: 1 }
    ])
    const { relay, browserPort } = await startBrowserRelay(source)
    try {
      const ws = new WebSocket(`wss://127.0.0.1:${browserPort}/h/${KEY}/ws`, {
        rejectUnauthorized: false,
        // No `trailer` here: Node's own client refuses it on a non-chunked
        // request, which is a client-side limit, not a relay property.
        headers: {
          'proxy-authorization': 'Basic cHJveHk6c2VjcmV0',
          te: 'trailers',
          'keep-alive': 'timeout=5',
          'x-probe-endtoend': 'must-survive'
        }
      })
      const first = await new Promise<string>((resolve, reject) => {
        ws.once('message', (data) => resolve(data.toString()))
        ws.once('error', reject)
      })
      const seen = (JSON.parse(first) as { headers: Record<string, string> }).headers
      assert.match(String(seen.connection), /upgrade/i, 'Connection: Upgrade must survive the hop')
      assert.equal(seen.upgrade, 'websocket', 'Upgrade must survive the hop')
      assert.ok(seen['sec-websocket-key'], 'the WS handshake key must survive the hop')
      assert.equal(
        seen['proxy-authorization'],
        undefined,
        'client-to-proxy credentials die at the relay'
      )
      assert.equal(seen.te, undefined)
      assert.equal(seen['keep-alive'], undefined)
      assert.equal(
        seen['x-probe-endtoend'],
        'must-survive',
        'end-to-end headers are not hop-scoped'
      )
      assert.equal(seen['x-forwarded-for'], '127.0.0.1', 'the source IP still travels on the hop')
      const echoed = await new Promise<string>((resolve, reject) => {
        ws.once('message', (data) => resolve(data.toString()))
        ws.send('ping-hygiene')
        setTimeout(() => reject(new Error('echo timeout')), 5_000)
      })
      assert.equal(echoed, 'echo:ping-hygiene', 'the upgraded session must stay bidirectional')
      ws.close()
      saveEvidence(EVIDENCE, 'min3-upgrade-hop-by-hop.json', { headersSeenByHost: seen, echoed })
    } finally {
      await relay.close()
      await source.close()
      await host.close()
    }
  }, { timeout: 20_000 })
})
