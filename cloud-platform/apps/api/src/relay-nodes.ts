
/**
 * The relays clients may be sent to (AC-23). A relay re-registers on every route
 * sync, so "recently seen" means "still serving"; one that stops beating drops
 * out of `/connect` instead of being handed to a client that cannot reach it.
 */

export const RELAY_ALIVE_DEFAULT_MS = 30_000

export type RelayNode = {
  id: string
  port: number
  lastSeenAt: number
  /** Order of first registration; it is the priority clients fall back in. */
  order: number
}

export type RelayNodeRegistry = {
  /** Registers or refreshes one relay; the id lets the same node re-check in. */
  register: (input: { id?: string | undefined; port: number }, nowMs: number) => RelayNode
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
      const node: RelayNode = existing
        ? { ...existing, port: input.port, lastSeenAt: nowMs }
        : { id, port: input.port, lastSeenAt: nowMs, order: nextOrder++ }
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

/** Reads a relay registration body; a bad port is the only thing that invalidates it. */
export function parseRelayRegistration(body: unknown): { id?: string; port: number } | null {
  const rawPort = field(body, 'port')
  const port = typeof rawPort === 'number' ? rawPort : Number(rawPort)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return null
  }
  const rawId = field(body, 'id')
  const id = typeof rawId === 'string' ? rawId : ''
  return id === '' ? { port } : { id, port }
}
