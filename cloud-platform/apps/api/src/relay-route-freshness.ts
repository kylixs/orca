import type { RelayRoute } from './store.ts'

/** Old snapshots may predate the `updatedAt` field, so it is optional here. */
export type RelayRouteLike = Pick<RelayRoute, 'target'> & { updatedAt?: number }

export type RelayRouteFreshness = {
  relayRouteUpdatedAt: number | null
  relayRouteAgeSec: number | null
  relayRouteStale: boolean | null
}

/**
 * U151: a route is stale when it no longer matches the host's addresses, or when
 * an offline host has left it unconfirmed for three heartbeat windows.
 */
export function evaluateRelayRouteFreshness(input: {
  route: RelayRouteLike | null | undefined
  directAddrs: string[]
  now: number
  hostOfflineMs: number
}): RelayRouteFreshness {
  const { route, directAddrs, now, hostOfflineMs } = input
  if (!route) {
    return { relayRouteUpdatedAt: null, relayRouteAgeSec: null, relayRouteStale: null }
  }
  const relayRouteUpdatedAt =
    typeof route.updatedAt === 'number' && Number.isFinite(route.updatedAt)
      ? route.updatedAt
      : null
  const relayRouteAgeSec =
    relayRouteUpdatedAt === null
      ? null
      : Math.max(0, Math.floor((now - relayRouteUpdatedAt) / 1000))
  const mismatch = !directAddrs.includes(route.target)
  // Drift is stale regardless of age; with a known age, three missed beats is stale.
  const relayRouteStale = mismatch
    ? true
    : relayRouteAgeSec === null
      ? null
      : relayRouteAgeSec * 1000 > 3 * hostOfflineMs
  return { relayRouteUpdatedAt, relayRouteAgeSec, relayRouteStale }
}
