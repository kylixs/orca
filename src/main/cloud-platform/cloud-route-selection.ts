import { connect as tcpConnect } from 'node:net'
import type { CloudEndpoint } from './cloud-connect-client'

/** Route selection for cloud endpoints: probe first, then pick. */

export type RouteChoice = { endpoint: CloudEndpoint; route: 'direct' | 'relay' }

const DEFAULT_MAX_DIRECT = 2

/** Credential-free liveness check: a TCP connect says nothing about authorization. */
export function probeEndpoint(url: string, timeoutMs: number): Promise<boolean> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return Promise.resolve(false)
  }
  const port = Number(parsed.port || (parsed.protocol === 'wss:' ? 443 : 80))
  return new Promise<boolean>((resolve) => {
    const socket = tcpConnect({ host: parsed.hostname, port })
    const done = (ok: boolean): void => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/**
 * Direct first, relay only when no direct address answers (design D4). Relay is a
 * fallback for reachability, never a default.
 */
export async function chooseRoute(
  endpoints: { direct: CloudEndpoint[]; relay: CloudEndpoint[] },
  probe: (url: string) => Promise<boolean>,
  maxDirectAddrs = DEFAULT_MAX_DIRECT
): Promise<RouteChoice | null> {
  for (const endpoint of [...endpoints.direct]
    .sort((a, b) => a.priority - b.priority)
    .slice(0, maxDirectAddrs)) {
    if (await probe(endpoint.url)) {
      return { endpoint, route: 'direct' }
    }
  }
  for (const endpoint of [...endpoints.relay].sort((a, b) => a.priority - b.priority)) {
    if (await probe(endpoint.url)) {
      return { endpoint, route: 'relay' }
    }
  }
  return null
}
