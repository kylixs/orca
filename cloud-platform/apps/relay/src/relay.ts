import { connect, createServer, type Socket } from 'node:net'
import { mtlsFetch } from '../../../packages/contract/src/internal-fetch.ts'
import { extractSni } from './sni.ts'

export type RelayRoute = { routeKey: string; hostId: string; target: string; version: number }

export type RelayOptions = {
  port: number
  /** Control-plane URL for route sync. HTTPS here means mTLS is used. */
  apiUrl: string
  internalToken: string
  /** mTLS material for the control channel (required when apiUrl is https). */
  keyPath?: string
  certPath?: string
  caPath?: string
  /** Reject new connections when the route table is older than this. */
  routeStaleMaxMs?: number
  /**
   * Only SNI values under this suffix are routed, even if a bare route key would
   * otherwise match. Makes the whitelist explicit rather than "whatever the table
   * happens to contain".
   */
  sniSuffix?: string
  /** Concurrent connections allowed from one source IP. */
  maxConnectionsPerIp?: number
  /** Timeout for one route-sync request; a hung platform must not block listening. */
  controlTimeoutMs?: number
}

export type RelayConnectionEvent = {
  at: number
  sourceIp: string
  sni: string | null
  routeKey: string | null
  target: string | null
  outcome: 'routed' | 'drop'
  reason?: string
}

export type RelayStats = {
  active: number
  routed: number
  dropped: number
  dropsByReason: Record<string, number>
}

export type RelayHandle = {
  port: number
  routes: () => Map<string, RelayRoute>
  refresh: () => Promise<void>
  stats: () => RelayStats
  events: () => RelayConnectionEvent[]
  close: () => Promise<void>
}

const DEFAULT_STALE_MS = 300_000
const DEFAULT_SNI_SUFFIX = '.relay.local'
const DEFAULT_PER_IP = 100
const MAX_EVENTS = 500

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
  const sniSuffix = options.sniSuffix ?? DEFAULT_SNI_SUFFIX
  const perIpMax = options.maxConnectionsPerIp ?? DEFAULT_PER_IP
  const connections = new Set<Socket>()
  const perIp = new Map<string, number>()
  const stats: RelayStats = { active: 0, routed: 0, dropped: 0, dropsByReason: {} }
  const events: RelayConnectionEvent[] = []

  function record(event: RelayConnectionEvent): void {
    // Metadata only: never the payload, never the credentials.
    events.push(event)
    if (events.length > MAX_EVENTS) events.shift()
  }

  function drop(socket: Socket, sourceIp: string, sni: string | null, reason: string): void {
    stats.dropped += 1
    stats.dropsByReason[reason] = (stats.dropsByReason[reason] ?? 0) + 1
    record({ at: Date.now(), sourceIp, sni, routeKey: null, target: null, outcome: 'drop', reason })
    socket.destroy()
  }

  let refreshInFlight: Promise<void> | null = null

  /** Single-flight: 2s ticks must not stack hung requests against a dead platform. */
  function refresh(): Promise<void> {
    if (refreshInFlight) return refreshInFlight
    refreshInFlight = refreshOnce().finally(() => {
      refreshInFlight = null
    })
    return refreshInFlight
  }

  async function refreshOnce(): Promise<void> {
    const res = await mtlsFetch(
      {
        internalUrl: options.apiUrl,
        token: options.internalToken,
        keyPath: options.keyPath,
        certPath: options.certPath,
        caPath: options.caPath
      },
      '/v1/internal/relay-routes',
      { signal: AbortSignal.timeout(options.controlTimeoutMs ?? 3000) }
    )
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
    const sourceIp = socket.remoteAddress?.replace(/^::ffff:/, '') ?? 'unknown'
    const current = perIp.get(sourceIp) ?? 0
    if (current >= perIpMax) {
      drop(socket, sourceIp, null, 'per-ip-limit')
      return
    }
    perIp.set(sourceIp, current + 1)
    stats.active += 1
    connections.add(socket)
    socket.on('close', () => {
      connections.delete(socket)
      stats.active = Math.max(0, stats.active - 1)
      const remaining = (perIp.get(sourceIp) ?? 1) - 1
      if (remaining <= 0) perIp.delete(sourceIp)
      else perIp.set(sourceIp, remaining)
    })
    socket.on('error', () => socket.destroy())

    // Read only until the TLS ClientHello is complete, then pick a route.
    let buffered = Buffer.alloc(0)
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk])
      if (buffered.length > 0 && buffered[0] !== 0x16) {
        // Not a TLS handshake: the relay is not a general proxy.
        drop(socket, sourceIp, null, 'non-tls')
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
        drop(socket, sourceIp, null, 'stale-route-table')
        return
      }
      const sni = extractSni(hello)
      if (!sni) {
        drop(socket, sourceIp, null, 'no-sni')
        return
      }
      // Explicit whitelist: anything outside the relay zone is refused even if a
      // route key would match, so the relay cannot be used as a general proxy by
      // presenting a bare hostname.
      if (!sni.endsWith(sniSuffix) || sni.length === sniSuffix.length) {
        drop(socket, sourceIp, sni, 'sni-not-whitelisted')
        return
      }
      const routeKey = sni.slice(0, -sniSuffix.length)
      if (routeKey.includes('.') || routeKey.length === 0) {
        drop(socket, sourceIp, sni, 'sni-shape-invalid')
        return
      }
      const found = routes.get(routeKey)
      if (!found) {
        // Default blackhole: unknown route keys never reach the intranet.
        drop(socket, sourceIp, sni, 'unknown-route')
        return
      }
      const parsed = parseTarget(found.target)
      if (!parsed) {
        drop(socket, sourceIp, sni, 'bad-target')
        return
      }
      stats.routed += 1
      record({
        at: Date.now(),
        sourceIp,
        sni,
        routeKey,
        target: found.target,
        outcome: 'routed'
      })
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

  // Listen before the first sync: a platform that accepts but never answers must
  // not keep the relay from starting (review-06 N9). The sync is still bounded.
  await new Promise<void>((resolve) => server.listen(options.port, '0.0.0.0', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : options.port
  await refresh()
    .then(() => console.log(`[relay] routes synced n=${routes.size}`))
    .catch(() => console.log('[relay] api not ready, will retry'))

  return {
    port,
    routes: () => new Map(routes),
    stats: () => ({ ...stats, dropsByReason: { ...stats.dropsByReason } }),
    events: () => events.slice(-50),
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
    internalToken:
      process.env.INTERNAL_TOKEN ?? process.env.ORCA_CLOUD_INTERNAL_TOKEN ?? 'internal-test-token',
    keyPath: process.env.INTERNAL_TLS_KEY,
    certPath: process.env.INTERNAL_TLS_CERT,
    caPath: process.env.INTERNAL_TLS_CA,
    sniSuffix: process.env.RELAY_SNI_SUFFIX ?? undefined,
    maxConnectionsPerIp: process.env.RELAY_MAX_CONN_PER_IP
      ? Number(process.env.RELAY_MAX_CONN_PER_IP)
      : undefined,
    controlTimeoutMs: process.env.CONTROL_TIMEOUT_MS ? Number(process.env.CONTROL_TIMEOUT_MS) : undefined
  })
  console.log(`[relay] listening on :${relay.port}, routes=${relay.routes().size}`)
}
