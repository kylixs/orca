import type { CloudEndpoint } from './cloud-connect-client'
import { describeEndpoint, type EndpointProbe } from './cloud-endpoint-probe'

export { probeEndpoint } from './cloud-endpoint-probe'

/** Route selection for cloud endpoints: probe first, then pick. */

export type RouteChoice = { endpoint: CloudEndpoint; route: 'direct' | 'relay' }

export type RouteSelection = {
  /** Null when nothing answered: the caller reports `ENDPOINT_UNREACHABLE`. */
  choice: RouteChoice | null
  /** Every address tried, in order, with its outcome (AC-07's step-by-step diagnosis). */
  probes: EndpointProbe[]
}

const DEFAULT_MAX_DIRECT = 2

/**
 * Direct first, relay only when no direct address answers (design D4). Relay is a
 * fallback for reachability, never a default. Every attempt is recorded, so a
 * failure can be explained address by address instead of as one opaque error.
 */
export async function chooseRoute(
  endpoints: { direct: CloudEndpoint[]; relay: CloudEndpoint[] },
  probe: (url: string) => Promise<boolean>,
  maxDirectAddrs = DEFAULT_MAX_DIRECT
): Promise<RouteSelection> {
  const probes: EndpointProbe[] = []
  const attempt = async (endpoint: CloudEndpoint, route: 'direct' | 'relay'): Promise<boolean> => {
    const started = Date.now()
    const ok = await probe(endpoint.url)
    probes.push({
      route,
      endpoint: describeEndpoint(endpoint.url),
      ok,
      elapsedMs: Date.now() - started
    })
    return ok
  }

  for (const endpoint of [...endpoints.direct]
    .sort((a, b) => a.priority - b.priority)
    .slice(0, maxDirectAddrs)) {
    if (await attempt(endpoint, 'direct')) {
      return { choice: { endpoint, route: 'direct' }, probes }
    }
  }
  for (const endpoint of [...endpoints.relay].sort((a, b) => a.priority - b.priority)) {
    if (await attempt(endpoint, 'relay')) {
      return { choice: { endpoint, route: 'relay' }, probes }
    }
  }
  return { choice: null, probes }
}
