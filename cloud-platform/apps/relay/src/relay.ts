import { connect, createServer, type Socket } from 'node:net'
import { extractSni } from './sni.ts'

export type RelayRoute = { routeKey: string; hostId: string; target: string; version: number }

export type RelayOptions = {
  port: number
  apiUrl: string
  internalToken: string
  /** Reject new connections when the route table is older than this. */
  routeStaleMaxMs?: number
}

export type RelayHandle = {
  port: number
  routes: () => Map<string, RelayRoute>
  refresh: () => Promise<void>
  close: () => Promise<void>
}

const DEFAULT_STALE_MS = 300_000

function parseTarget(target: string): { host: string; port: number } | null {
  const [host, portText] = target.split(':')
  const port = Number(portText)
  if (!host || !Number.isInteger(port)) return null
  return { host, port }
}

export async function startRelay(options: RelayOptions): Promise<RelayHandle> {
  const routes = new Map<string, RelayRoute>()
  let lastSyncAt = 0
  const staleMax = options.routeStaleMaxMs ?? DEFAULT_STALE_MS
  const connections = new Set<Socket>()

  async function refresh(): Promise<void> {
    const res = await fetch(`${options.apiUrl}/v1/internal/relay-routes`, {
      headers: { 'x-internal-token': options.internalToken }
    })
    if (!res.ok) throw new Error(`route sync failed: ${res.status}`)
    const body = (await res.json()) as { routes: RelayRoute[] }
    routes.clear()
    for (const route of body.routes) routes.set(route.routeKey, route)
    lastSyncAt = Date.now()
  }

  const timer = setInterval(() => {
    void refresh()
      .then(() => console.log(`[relay] routes synced n=${routes.size}`))
      .catch(() => undefined)
  }, 2_000)

  const server = createServer((socket) => {
    connections.add(socket)
    socket.on('close', () => connections.delete(socket))
    socket.on('error', () => socket.destroy())

    // Read only until the TLS ClientHello is complete, then pick a route.
    let buffered = Buffer.alloc(0)
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk])
      if (buffered.length > 0 && buffered[0] !== 0x16) {
        // Not a TLS handshake: the relay is not a general proxy.
        console.log('[relay] drop non-tls')
        socket.destroy()
        return
      }
      const needed = buffered.length >= 5 ? 5 + buffered.readUInt16BE(3) : Number.POSITIVE_INFINITY
      if (buffered.length < needed) return
      socket.off('data', onData)
      route(buffered)
    }
    socket.on('data', onData)

    function route(hello: Buffer): void {
      if (Date.now() - lastSyncAt > staleMax) {
        console.log('[relay] drop stale-route-table')
        socket.destroy()
        return
      }
      const sni = extractSni(hello)
      if (!sni) {
        console.log('[relay] drop no-sni')
        socket.destroy()
        return
      }
      const routeKey = sni.endsWith('.relay.local') ? sni.slice(0, -'.relay.local'.length) : sni
      const found = routes.get(routeKey)
      if (!found) {
        // Default blackhole: unknown SNI never reaches the intranet.
        console.log(`[relay] drop unknown-route=${routeKey}`)
        socket.destroy()
        return
      }
      console.log(`[relay] route ${routeKey} -> ${found.target}`)
      const parsed = parseTarget(found.target)
      if (!parsed) {
        socket.destroy()
        return
      }
      const upstream = connect(parsed.port, parsed.host)
      connections.add(upstream)
      upstream.on('close', () => connections.delete(upstream))
      upstream.on('error', () => socket.destroy())
      socket.on('error', () => upstream.destroy())
      upstream.on('connect', () => {
        upstream.write(hello)
        socket.pipe(upstream)
        upstream.pipe(socket)
      })
    }
  })

  await refresh()
    .then(() => console.log(`[relay] routes synced n=${routes.size}`))
    .catch(() => console.log('[relay] api not ready, will retry'))
  await new Promise<void>((resolve) => server.listen(options.port, '0.0.0.0', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : options.port

  return {
    port,
    routes: () => new Map(routes),
    refresh,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(timer)
        for (const socket of connections) socket.destroy()
        server.close(() => resolve())
      })
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const relay = await startRelay({
    port: Number(process.env.PORT ?? 18443),
    apiUrl: process.env.API_URL ?? 'http://127.0.0.1:18787',
    internalToken: process.env.INTERNAL_TOKEN ?? 'internal-test-token'
  })
  console.log(`[relay] listening on :${relay.port}, routes=${relay.routes().size}`)
}
