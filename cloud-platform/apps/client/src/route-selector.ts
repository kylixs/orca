import { connect } from 'node:net'

export type Endpoint = { priority: number; url: string; routeKey?: string; sni?: string }

export type ProbeResult = {
  endpoint: Endpoint
  ok: boolean
  rttMs: number
  error?: string
}

export type SelectionResult = {
  chosen: Endpoint | null
  route: 'direct' | 'relay' | null
  probes: ProbeResult[]
}

function hostPortOf(url: string): { host: string; port: number } | null {
  try {
    const parsed = new URL(url)
    const port = Number(parsed.port || (parsed.protocol === 'wss:' ? 443 : 80))
    return { host: parsed.hostname, port }
  } catch {
    return null
  }
}

/** Credential-free TCP pre-check: measures reachability without consuming the jti. */
export function probeEndpoint(endpoint: Endpoint, timeoutMs: number): Promise<ProbeResult> {
  const target = hostPortOf(endpoint.url)
  if (!target) {
    return Promise.resolve({ endpoint, ok: false, rttMs: 0, error: 'BAD_URL' })
  }
  const startedAt = Date.now()
  return new Promise((resolve) => {
    const socket = connect(target.port, target.host)
    let settled = false
    const finish = (ok: boolean, error?: string): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve({ endpoint, ok, rttMs: Date.now() - startedAt, error })
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false, 'TIMEOUT'))
    socket.once('error', (err: NodeJS.ErrnoException) => finish(false, err.code ?? 'ERROR'))
  })
}

export async function selectRoute(input: {
  direct: Endpoint[]
  relay: Endpoint[]
  probeTimeoutMs?: number
  maxDirectAddrs?: number
}): Promise<SelectionResult> {
  const timeoutMs = input.probeTimeoutMs ?? 800
  const maxDirect = input.maxDirectAddrs ?? 2
  const probes: ProbeResult[] = []
  const ordered = [...input.direct].sort((a, b) => a.priority - b.priority).slice(0, maxDirect)
  for (const endpoint of ordered) {
    const result = await probeEndpoint(endpoint, timeoutMs)
    probes.push(result)
    if (result.ok) return { chosen: endpoint, route: 'direct', probes }
  }
  for (const endpoint of input.relay) {
    const result = await probeEndpoint(endpoint, timeoutMs)
    probes.push(result)
    if (result.ok) return { chosen: endpoint, route: 'relay', probes }
  }
  return { chosen: null, route: null, probes }
}
