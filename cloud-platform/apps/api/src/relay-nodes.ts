/**
 * The relays clients may be sent to (AC-23). A relay re-registers on every route
 * sync, so "recently seen" means "still serving"; one that stops beating drops
 * out of `/connect` instead of being handed to a client that cannot reach it.
 */

export const RELAY_ALIVE_DEFAULT_MS = 30_000

/**
 * The route-key shape a browser path `/h/<key>/` may carry: the relay refuses
 * dotted keys, so anything else would only mint an entry URL that cannot load.
 */
export const BROWSER_ROUTE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/

export type RelayNode = {
  id: string
  /**
   * The address clients dial. Relays behind NAT may announce it explicitly; the
   * registration's source address is the fallback, which is also how relays
   * predating the field keep working.
   */
  host: string
  /**
   * Where a browser reaches this relay's `/h/<key>/` edge. Empty unless the
   * relay runs browser mode and announced a public host, so a relay that turns
   * the edge off stops being advertised at its next registration.
   */
  browserHost: string
  port: number
  lastSeenAt: number
  /** Order of first registration; it is the priority clients fall back in. */
  order: number
}

export type RelayNodeRegistry = {
  /** Registers or refreshes one relay; the id lets the same node re-check in. */
  register: (
    input: {
      id?: string | undefined
      host?: string | undefined
      browserHost?: string | undefined
      port: number
    },
    nowMs: number
  ) => RelayNode
  /** Live relays, priority order. */
  healthy: (nowMs: number, aliveMs?: number) => RelayNode[]
  all: () => RelayNode[]
}

export function createRelayNodeRegistry(): RelayNodeRegistry {
  const nodes = new Map<string, RelayNode>()
  let nextOrder = 1

  return {
    register: (input, nowMs) => {
      // Why derive when absent: relays predating the id field still must register.
      const id = input.id && input.id.length > 0 ? input.id : `relay:${input.port}`
      const existing = nodes.get(id)
      const host = input.host && input.host.length > 0 ? input.host : (existing?.host ?? '')
      // Not sticky on purpose: an absent browserHost means the edge is off now.
      const browserHost = input.browserHost ?? ''
      const node: RelayNode = existing
        ? { ...existing, host, browserHost, port: input.port, lastSeenAt: nowMs }
        : { id, host, browserHost, port: input.port, lastSeenAt: nowMs, order: nextOrder++ }
      nodes.set(id, node)
      return node
    },
    healthy: (nowMs, aliveMs = RELAY_ALIVE_DEFAULT_MS) =>
      [...nodes.values()]
        .filter((node) => nowMs - node.lastSeenAt <= aliveMs)
        .sort((a, b) => a.order - b.order),
    all: () => [...nodes.values()].sort((a, b) => a.order - b.order)
  }
}

function field(source: unknown, key: string): unknown {
  return source !== null && typeof source === 'object' ? Reflect.get(source, key) : undefined
}

/** The address part of a direct address: `[v6]:port`, `v4:port`, bare IPv6, bare host. */
export function ipOfDirectAddr(addr: string): string | null {
  const value = addr.trim()
  if (value === '') return null
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    return end > 1 ? value.slice(1, end) : null
  }
  const first = value.indexOf(':')
  const last = value.lastIndexOf(':')
  if (first === -1) return value
  // One colon separates host and port; several mean a bare IPv6 literal.
  return first === last ? value.slice(0, first) : value
}

/**
 * A host that does not name its own route gets one derived from what it
 * advertises: an intranet hostname resolves unreliably, an IP does not. Dots and
 * colons become dashes because the key is an SNI label and the relay refuses
 * dotted ones. No address falls back to the hostname.
 */
export function routeKeyFromDirectAddrs(directAddrs: string[], hostName: string): string {
  const addr = directAddrs.map(ipOfDirectAddr).find((ip) => ip !== null)
  return addr ? `ip-${addr.replace(/[.:]/g, '-')}` : hostName
}

/**
 * A browser host is spliced verbatim into `https://<browserHost>/h/...`, so only
 * a bare `host[:port]` is accepted: a scheme, path, or whitespace would move the
 * entry onto an origin the relay never serves.
 */
function isBrowserHostForm(value: string): boolean {
  const match = value.match(/^([A-Za-z0-9.-]+)(?::(\d{1,5}))?$/)
  if (!match) return false
  const port = match[2]
  return port === undefined || (Number(port) >= 1 && Number(port) <= 65535)
}

/** Reads a relay registration body; a bad port is the only thing that invalidates it. */
export function parseRelayRegistration(
  body: unknown
): { id?: string; host?: string; browserHost?: string; port: number } | null {
  const rawPort = field(body, 'port')
  const port = typeof rawPort === 'number' ? rawPort : Number(rawPort)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return null
  }
  const rawHost = field(body, 'host')
  const host = typeof rawHost === 'string' && rawHost.trim().length > 0 ? rawHost.trim() : undefined
  const rawBrowserHost = field(body, 'browserHost')
  const browserHost =
    typeof rawBrowserHost === 'string' && isBrowserHostForm(rawBrowserHost.trim())
      ? rawBrowserHost.trim()
      : undefined
  const rawId = field(body, 'id')
  const id = typeof rawId === 'string' ? rawId : ''
  return id === '' ? { host, browserHost, port } : { id, host, browserHost, port }
}
