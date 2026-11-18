import { connect, createServer, type Socket } from 'node:net'
import {
  createServer as createTlsServer,
  request as tlsRequest,
  type Server as TlsServer
} from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { readFileSync } from 'node:fs'
import { mtlsFetch } from '../../../packages/contract/src/internal-fetch.ts'
import { isEntryModule } from '../../login-lockout/src/entry-module.ts'
import { extractSni } from './sni.ts'
import { RELAY_CODE_VERSION } from './relay-version.ts'

export type RelayRoute = { routeKey: string; hostId: string; target: string; version: number }

/**
 * Browser edge: TLS terminates here with the relay's own certificate and
 * `/h/<routeKey>/...` is routed by URL path, because a browser cannot dial an
 * IP and present an arbitrary SNI label the way the desktop client does.
 */
export type RelayBrowserOptions = {
  port: number
  certPath: string
  keyPath: string
}

export type RelayOptions = {
  port: number
  /** How the platform knows this relay; defaults to `relay:<port>`. */
  id?: string
  /** U183 R10a: optional nonce echoed back so the installer can self-check. */
  installNonce?: string
  /** The address clients dial (NAT/DNS name); default is the registration's source IP. */
  publicHost?: string
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
  /** Browser-mode listener; absent means the feature is entirely off. */
  browser?: RelayBrowserOptions
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
  /** Assigned port of the browser-mode listener, or null when not enabled. */
  browserPort: number | null
  routes: () => Map<string, RelayRoute>
  refresh: () => Promise<void>
  stats: () => RelayStats
  events: () => RelayConnectionEvent[]
  close: () => Promise<void>
}

const DEFAULT_API_URL = 'http://127.0.0.1:18787'
const DEFAULT_INTERNAL_TOKEN = 'internal-test-token'
const DEFAULT_STALE_MS = 300_000
const DEFAULT_SNI_SUFFIX = '.relay.local'
const DEFAULT_PER_IP = 100
const MAX_EVENTS = 500
const BROWSER_ROUTE_KEY = /^[A-Za-z0-9_-]+$/
/** RFC 2616 13.5.1: headers that belong to one hop and must not be relayed. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
])
/** Hop-by-hop names a WebSocket handshake still needs at the next hop. */
const UPGRADE_KEEP_HEADERS = new Set(['connection', 'upgrade'])

function parseTarget(target: string): { host: string; port: number } | null {
  const [host, portText] = target.split(':')
  const port = Number(portText)
  if (!host || !Number.isInteger(port)) return null
  return { host, port }
}

/**
 * `/h/<routeKey>/rest` → the route key and the path the host should see, or
 * null when the URL is not a browser route. The key shape matches the SNI
 * listener's rule: no dots, so `..` and FQDN look-alikes cannot reach a target.
 */
export function parseBrowserPath(url: string): { routeKey: string; path: string } | null {
  if (!url.startsWith('/h/')) return null
  const remainder = url.slice('/h/'.length)
  const separator = remainder.indexOf('/')
  if (separator <= 0) return null
  const routeKey = remainder.slice(0, separator)
  if (!BROWSER_ROUTE_KEY.test(routeKey)) return null
  return { routeKey, path: remainder.slice(separator) }
}

/**
 * Request headers for the host hop: hop-by-hop dropped, proxy trail appended.
 * An upgrade keeps only `connection`/`upgrade` of that set — without
 * `Connection: Upgrade` the host never answers 101 — while `proxy-authorization`
 * and friends still die at the hop, exactly as on the plain HTTP path.
 */
function forwardedHeaders(
  req: IncomingMessage,
  sourceIp: string,
  keepUpgrade: boolean
): Record<string, string | string[] | undefined> {
  const headers: Record<string, string | string[] | undefined> = {}
  for (const [name, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(name) && !(keepUpgrade && UPGRADE_KEEP_HEADERS.has(name))) continue
    headers[name] = value
  }
  const prior = req.headers['x-forwarded-for']
  headers['x-forwarded-for'] = prior ? `${prior}, ${sourceIp}` : sourceIp
  headers['x-forwarded-proto'] = 'https'
  if (req.headers.host) headers['x-forwarded-host'] = req.headers.host
  return headers
}

/** Response headers for the caller: framing stays ours, not the host hop's. */
function forwardableResponseHeaders(res: IncomingMessage): [string, string][] {
  const pairs: [string, string][] = []
  for (let index = 0; index < res.rawHeaders.length; index += 2) {
    if (HOP_BY_HOP.has(res.rawHeaders[index].toLowerCase())) continue
    pairs.push([res.rawHeaders[index], res.rawHeaders[index + 1]])
  }
  return pairs
}

function rawHead(status: number, reason: string, res: IncomingMessage, keepAll = false): string {
  const lines = [`HTTP/1.1 ${status} ${reason}`.trimEnd()]
  // A 101 *is* the handshake: Connection/Upgrade must survive the hop or the
  // client never sees an upgrade at all.
  const headers = keepAll ? allResponseHeaders(res) : forwardableResponseHeaders(res)
  for (const [name, value] of headers) lines.push(`${name}: ${value}`)
  return `${lines.join('\r\n')}\r\n\r\n`
}

function allResponseHeaders(res: IncomingMessage): [string, string][] {
  const pairs: [string, string][] = []
  for (let index = 0; index < res.rawHeaders.length; index += 2) {
    pairs.push([res.rawHeaders[index], res.rawHeaders[index + 1]])
  }
  return pairs
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export type RelayEnvResolution = {
  apiUrl: string
  internalToken: string
  /** Every degraded choice, in order; empty when the env is complete. */
  warnings: string[]
}

/**
 * `/install/relay.sh` writes `ORCA_CLOUD_*`; deployments from before that name
 * (and local dev) still carry the bare names, so both are read — new name first,
 * legacy as fallback. Every degradation is reported instead of swallowed: a relay
 * that quietly dials the loopback default stays "listening" while syncing
 * nothing, which is the failure mode U38 shipped with.
 */
export function resolveRelayEnv(
  env: Record<string, string | undefined> = process.env
): RelayEnvResolution {
  const warnings: string[] = []
  const preferredApi = env.ORCA_CLOUD_API_URL?.trim()
  const legacyApi = env.API_URL?.trim()
  let apiUrl: string
  if (preferredApi) {
    apiUrl = preferredApi
    if (legacyApi && legacyApi !== preferredApi) {
      warnings.push(
        `[relay] ORCA_CLOUD_API_URL and legacy API_URL disagree; using ORCA_CLOUD_API_URL=${preferredApi}`
      )
    }
  } else if (legacyApi) {
    apiUrl = legacyApi
    warnings.push(
      `[relay] ORCA_CLOUD_API_URL unset; using legacy API_URL=${legacyApi} — rename the key in the env file`
    )
  } else {
    apiUrl = DEFAULT_API_URL
    warnings.push(
      `[relay] ORCA_CLOUD_API_URL unset; defaulting to ${DEFAULT_API_URL} — set ORCA_CLOUD_API_URL to the platform address or route sync keeps failing`
    )
  }
  const preferredToken = env.ORCA_CLOUD_INTERNAL_TOKEN?.trim()
  const legacyToken = env.INTERNAL_TOKEN?.trim()
  let internalToken: string
  if (preferredToken) {
    internalToken = preferredToken
    if (legacyToken && legacyToken !== preferredToken) {
      warnings.push(
        '[relay] ORCA_CLOUD_INTERNAL_TOKEN and legacy INTERNAL_TOKEN disagree; using ORCA_CLOUD_INTERNAL_TOKEN'
      )
    }
  } else if (legacyToken) {
    internalToken = legacyToken
    warnings.push(
      '[relay] ORCA_CLOUD_INTERNAL_TOKEN unset; using legacy INTERNAL_TOKEN — rename the key in the env file'
    )
  } else {
    internalToken = DEFAULT_INTERNAL_TOKEN
    warnings.push(
      `[relay] ORCA_CLOUD_INTERNAL_TOKEN unset; defaulting to '${DEFAULT_INTERNAL_TOKEN}' — the platform will reject every route sync`
    )
  }
  return { apiUrl, internalToken, warnings }
}

/** `--preflight` verdicts; 64 is a host/tool problem, 78 a terminal config one. */
export type RelayPreflightResult =
  | { ok: true; id: string; port: number }
  | { ok: false; exitCode: 64 | 78; reason: string }

const MIN_NODE = { major: 22, minor: 18 } as const
export const PREFLIGHT_NODE_EXIT = 64
export const PREFLIGHT_CONFIG_EXIT = 78

function nodeVersionAtLeast(version: string): boolean {
  const [major, minor] = version.replace(/^v/, '').split('.').map(Number)
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return false
  return major > MIN_NODE.major || (major === MIN_NODE.major && minor >= MIN_NODE.minor)
}

/**
 * Validates config only: no listen, no HTTP, no registration. The install script
 * runs this against the real release path (and a symlinked path) before
 * activating anything, so a broken env fails there instead of in the service.
 */
export function preflightRelay(
  env: Record<string, string | undefined> = process.env,
  nodeVersion: string = process.versions.node
): RelayPreflightResult {
  if (!nodeVersionAtLeast(nodeVersion)) {
    return {
      ok: false,
      exitCode: PREFLIGHT_NODE_EXIT,
      reason: `node ${nodeVersion} is older than ${MIN_NODE.major}.${MIN_NODE.minor}`
    }
  }
  const fail = (reason: string): RelayPreflightResult => ({
    ok: false,
    exitCode: PREFLIGHT_CONFIG_EXIT,
    reason
  })
  const apiUrl = env.ORCA_CLOUD_API_URL?.trim()
  if (!apiUrl) return fail('ORCA_CLOUD_API_URL is required')
  try {
    const protocol = new URL(apiUrl).protocol
    if (protocol !== 'http:' && protocol !== 'https:') {
      return fail(`ORCA_CLOUD_API_URL must be http(s), got ${protocol}`)
    }
  } catch {
    return fail('ORCA_CLOUD_API_URL is not a valid URL')
  }
  if (!env.ORCA_CLOUD_INTERNAL_TOKEN?.trim()) {
    return fail('ORCA_CLOUD_INTERNAL_TOKEN is required')
  }
  const port = Number(env.PORT?.trim() || 18443)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return fail(`PORT must be an integer in 0..65535, got ${env.PORT}`)
  }
  const id = env.ORCA_CLOUD_RELAY_ID?.trim() || `relay:${port}`
  return { ok: true, id, port }
}

/** All three env vars must be set: a half-configured browser listener is worse than none. */
function browserOptionsFromEnv(): RelayBrowserOptions | undefined {
  const certPath = process.env.RELAY_BROWSER_TLS_CERT?.trim()
  const keyPath = process.env.RELAY_BROWSER_TLS_KEY?.trim()
  const port = Number(process.env.RELAY_BROWSER_PORT?.trim())
  if (!certPath || !keyPath || !process.env.RELAY_BROWSER_PORT?.trim() || !Number.isInteger(port)) {
    return undefined
  }
  return { port, certPath, keyPath }
}

export async function startRelay(options: RelayOptions): Promise<RelayHandle> {
  const routes = new Map<string, RelayRoute>()
  // Why a mutable copy: the timer can beat the listen callback, and announcing a
  // port of 0 would register an unreachable node.
  let announcedPort = options.port
  let lastSyncAt = 0
  const staleMax = options.routeStaleMaxMs ?? DEFAULT_STALE_MS
  const sniSuffix = options.sniSuffix ?? DEFAULT_SNI_SUFFIX
  const perIpMax = options.maxConnectionsPerIp ?? DEFAULT_PER_IP
  const connections = new Set<Socket>()
  // Inbound sockets too: close() waits for them, and a relay left holding an idle
  // client would never shut down.
  const inbound = new Set<Socket>()
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

  /**
   * Admission shared by both listeners: one per-IP budget, one active count.
   * The browser edge faces untrusted browsers, so it must not be the listener
   * that lets a single IP hold unlimited sockets (design.md §4.3.2).
   */
  function admitPerIp(socket: Socket, sourceIp: string): boolean {
    const current = perIp.get(sourceIp) ?? 0
    if (current >= perIpMax) {
      drop(socket, sourceIp, null, 'per-ip-limit')
      return false
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
    return true
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
    // Why here: a successful sync proves both that this relay is alive and that the
    // platform can be reached, which is exactly when re-registering is meaningful.
    // A failed announce must still be loud: the node silently ages off the live list.
    await announce().catch((error: unknown) => {
      console.warn(
        `[relay] announce failed (node may drop off the live list): ${describeError(error)}`
      )
    })
  }

  /** AC-23: keeps this node in the platform's live relay list, or lets it lapse. */
  async function announce(): Promise<void> {
    const res = await mtlsFetch(
      {
        internalUrl: options.apiUrl,
        token: options.internalToken,
        keyPath: options.keyPath,
        certPath: options.certPath,
        caPath: options.caPath
      },
      '/v1/internal/relay-endpoint',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: options.id ?? `relay:${announcedPort}`,
          // Old platforms ignore an unknown field; absent keeps old relays old.
          ...(options.installNonce ? { installNonce: options.installNonce } : {}),
          // Where clients should dial us: an explicit advertise wins (NAT),
          // otherwise the platform falls back to the registration's source IP.
          ...(options.publicHost ? { host: options.publicHost } : {}),
          port: announcedPort,
          // Only a live browser edge may name one, and the platform blanks
          // anything that is not a bare host[:port].
          ...(options.browser && process.env.RELAY_BROWSER_PUBLIC_HOST?.trim()
            ? { browserHost: process.env.RELAY_BROWSER_PUBLIC_HOST.trim() }
            : {})
        }),
        signal: AbortSignal.timeout(options.controlTimeoutMs ?? 3000)
      }
    )
    if (!res.ok) throw new Error(`relay announce failed: ${res.status}`)
  }

  const timer = setInterval(() => {
    void refresh()
      .then(() => console.log(`[relay] routes synced n=${routes.size}`))
      .catch((error: unknown) =>
        console.warn(`[relay] route sync failed, retrying in 2s: ${describeError(error)}`)
      )
  }, 2_000)

  const server = createServer((socket) => {
    inbound.add(socket)
    socket.once('close', () => inbound.delete(socket))
    const sourceIp = socket.remoteAddress?.replace(/^::ffff:/, '') ?? 'unknown'
    if (!admitPerIp(socket, sourceIp)) return
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

  /**
   * Browser edge. Same route table and staleness rule as the SNI listener, but
   * TLS ends here, so a miss is a plain 404 rather than a silent blackhole —
   * a browser needs an answer, not a hanging socket.
   */
  let browserServer: TlsServer | null = null
  let browserPort: number | null = null
  const browser = options.browser
  if (browser) {
    browserServer = createTlsServer(
      { key: readFileSync(browser.keyPath), cert: readFileSync(browser.certPath) },
      (req: IncomingMessage, res: ServerResponse) => {
        const sourceIp = req.socket.remoteAddress?.replace(/^::ffff:/, '') ?? 'unknown'
        const stale = Date.now() - lastSyncAt > staleMax
        const parsed = stale ? null : parseBrowserPath(req.url ?? '/')
        if (!parsed) {
          const reason = stale ? 'browser-stale-route-table' : 'browser-route-miss'
          stats.dropped += 1
          stats.dropsByReason[reason] = (stats.dropsByReason[reason] ?? 0) + 1
          record({
            at: Date.now(),
            sourceIp,
            sni: null,
            routeKey: null,
            target: null,
            outcome: 'drop',
            reason
          })
          res.writeHead(stale ? 503 : 404, { connection: 'close' })
          res.end()
          return
        }
        const route = routes.get(parsed.routeKey)
        const target = route ? parseTarget(route.target) : null
        if (!route || !target) {
          stats.dropped += 1
          stats.dropsByReason['browser-unknown-route'] =
            (stats.dropsByReason['browser-unknown-route'] ?? 0) + 1
          record({
            at: Date.now(),
            sourceIp,
            sni: null,
            routeKey: null,
            target: null,
            outcome: 'drop',
            reason: 'browser-unknown-route'
          })
          res.writeHead(404, { connection: 'close' })
          res.end()
          return
        }
        stats.routed += 1
        record({
          at: Date.now(),
          sourceIp,
          sni: null,
          routeKey: route.routeKey,
          target: route.target,
          outcome: 'routed'
        })
        const upstream = tlsRequest(
          {
            host: target.host,
            port: target.port,
            method: req.method,
            path: parsed.path,
            headers: forwardedHeaders(req, sourceIp, false),
            agent: false,
            // The host hop re-enters the host's own TLS listener, whose cert is
            // self-signed by design; identity is pinned by the route table.
            rejectUnauthorized: false
          },
          (upstreamRes) => {
            res.writeHead(upstreamRes.statusCode ?? 502, forwardableResponseHeaders(upstreamRes))
            upstreamRes.pipe(res)
          }
        )
        upstream.on('error', () => {
          if (res.headersSent) res.destroy()
          else {
            res.writeHead(502, { connection: 'close' })
            res.end()
          }
        })
        // A client gone mid-flight must take its upstream socket with it, or every
        // abandoned request parks a half-open dial on the host until its timeout.
        res.on('close', () => upstream.destroy())
        req.on('error', () => upstream.destroy())
        req.pipe(upstream)
      }
    )
    browserServer.on('upgrade', (req: IncomingMessage, clientSocket: Duplex, head: Buffer) => {
      const sourceIp = req.socket.remoteAddress?.replace(/^::ffff:/, '') ?? 'unknown'
      const stale = Date.now() - lastSyncAt > staleMax
      const parsed = stale ? null : parseBrowserPath(req.url ?? '/')
      // Same status contract as the HTTP path: stale means "retry soon", not
      // "no such host" — an upgrade must not lie about which one it hit.
      const refuse = (reason: string, status: 404 | 503): void => {
        stats.dropped += 1
        stats.dropsByReason[reason] = (stats.dropsByReason[reason] ?? 0) + 1
        record({
          at: Date.now(),
          sourceIp,
          sni: null,
          routeKey: null,
          target: null,
          outcome: 'drop',
          reason
        })
        clientSocket.write(
          `HTTP/1.1 ${status} ${status === 503 ? 'Service Unavailable' : 'Not Found'}\r\nconnection: close\r\n\r\n`
        )
        clientSocket.destroy()
      }
      if (!parsed) {
        refuse(stale ? 'browser-stale-route-table' : 'browser-route-miss', stale ? 503 : 404)
        return
      }
      const route = routes.get(parsed.routeKey)
      const target = route ? parseTarget(route.target) : null
      if (!route || !target) {
        refuse('browser-unknown-route', 404)
        return
      }
      stats.routed += 1
      record({
        at: Date.now(),
        sourceIp,
        sni: null,
        routeKey: route.routeKey,
        target: route.target,
        outcome: 'routed'
      })
      const upstream = tlsRequest({
        host: target.host,
        port: target.port,
        path: parsed.path,
        headers: forwardedHeaders(req, sourceIp, true),
        agent: false,
        rejectUnauthorized: false
      })
      // Until the 101 lands nobody watches this dial: a client that disappears
      // here would otherwise leave it half-open on the host until its timeout.
      const abortDial = (): void => {
        upstream.destroy()
      }
      clientSocket.once('close', abortDial)
      clientSocket.once('error', abortDial)
      upstream.on('upgrade', (upstreamRes, upstreamSocket: Duplex, upstreamHead: Buffer) => {
        clientSocket.off('close', abortDial)
        clientSocket.off('error', abortDial)
        clientSocket.write(
          rawHead(upstreamRes.statusCode ?? 101, upstreamRes.statusMessage ?? '', upstreamRes, true)
        )
        if (upstreamHead.length > 0) clientSocket.write(upstreamHead)
        const teardown = (): void => {
          clientSocket.destroy()
          upstreamSocket.destroy()
        }
        clientSocket.on('error', teardown)
        upstreamSocket.on('error', teardown)
        clientSocket.on('close', teardown)
        upstreamSocket.on('close', teardown)
        upstreamSocket.pipe(clientSocket)
        clientSocket.pipe(upstreamSocket)
      })
      // The host refused the upgrade: its answer is the client's answer.
      upstream.on('response', (upstreamRes) => {
        clientSocket.write(
          rawHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage ?? '', upstreamRes)
        )
        clientSocket.end()
      })
      upstream.on('error', () => clientSocket.destroy())
      upstream.end(head)
    })
    browserServer.on('connection', (socket: Socket) => {
      // close() reaps browser sockets through the same set as the SNI listener.
      inbound.add(socket)
      socket.once('close', () => inbound.delete(socket))
      // A refused socket is destroyed here, so it must never surface as uncaught.
      socket.on('error', () => socket.destroy())
      admitPerIp(socket, socket.remoteAddress?.replace(/^::ffff:/, '') ?? 'unknown')
    })
    const listening = browserServer
    await new Promise<void>((resolve) => listening.listen(browser.port, '0.0.0.0', () => resolve()))
    const browserAddress = browserServer.address()
    browserPort =
      typeof browserAddress === 'object' && browserAddress ? browserAddress.port : browser.port
    console.log(`[relay] browser mode listening on :${browserPort}`)
  }

  // Listen before the first sync: a platform that accepts but never answers must
  // not keep the relay from starting (review-06 N9). The sync is still bounded.
  await new Promise<void>((resolve) => server.listen(options.port, '0.0.0.0', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : options.port
  announcedPort = port
  await refresh()
    .then(() => console.log(`[relay] routes synced n=${routes.size}`))
    .catch((error: unknown) =>
      console.warn(`[relay] platform not reachable yet, retrying every 2s: ${describeError(error)}`)
    )

  return {
    port,
    browserPort,
    routes: () => new Map(routes),
    stats: () => ({ ...stats, dropsByReason: { ...stats.dropsByReason } }),
    events: () => events.slice(-50),
    refresh,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(timer)
        for (const socket of connections) socket.destroy()
        for (const socket of inbound) socket.destroy()
        server.close(() => resolve())
        browserServer?.close(() => resolve())
      })
  }
}

if (isEntryModule(import.meta.url, process.argv[1])) {
  if (process.argv.includes('--preflight')) {
    const preflight = preflightRelay()
    if (!preflight.ok) {
      console.error(`[relay] preflight failed: ${preflight.reason}`)
      process.exitCode = preflight.exitCode
    } else {
      console.log(
        `[relay] preflight ok id=${preflight.id} port=${preflight.port} node=${process.versions.node}`
      )
    }
  } else {
    // Print the resolution verdicts before listening: a degraded env must be the
    // first thing in the log, not a mystery behind a silent sync failure (U38).
    const envConfig = resolveRelayEnv()
    for (const line of envConfig.warnings) console.warn(line)
    const relay = await startRelay({
      port: Number(process.env.PORT ?? 18443),
      // Explicit id wins; announce still derives `relay:<bound port>` otherwise.
      id: process.env.ORCA_CLOUD_RELAY_ID?.trim() || undefined,
      installNonce: process.env.ORCA_CLOUD_INSTALL_NONCE?.trim() || undefined,
      apiUrl: envConfig.apiUrl,
      internalToken: envConfig.internalToken,
      keyPath: process.env.INTERNAL_TLS_KEY,
      certPath: process.env.INTERNAL_TLS_CERT,
      caPath: process.env.INTERNAL_TLS_CA,
      publicHost: process.env.RELAY_PUBLIC_HOST?.trim() || undefined,
      sniSuffix: process.env.RELAY_SNI_SUFFIX ?? undefined,
      maxConnectionsPerIp: process.env.RELAY_MAX_CONN_PER_IP
        ? Number(process.env.RELAY_MAX_CONN_PER_IP)
        : undefined,
      controlTimeoutMs: process.env.CONTROL_TIMEOUT_MS
        ? Number(process.env.CONTROL_TIMEOUT_MS)
        : undefined,
      browser: browserOptionsFromEnv()
    })
    console.log(
      `[relay] listening on :${relay.port}, routes=${relay.routes().size}, relayCodeVersion=${RELAY_CODE_VERSION}`
    )
  }
}
