import { connect as tcpConnect } from 'node:net'

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

/** One address the client tried, kept so a failure can be explained step by step (AC-07). */
export type EndpointProbe = {
  route: 'direct' | 'relay'
  /** `host:port` only — the ticket's route key and query are not the user's problem. */
  endpoint: string
  ok: boolean
  elapsedMs: number
}

/** Strips credentials and path: a diagnosis shows where it looked, not what it carried. */
export function describeEndpoint(url: string): string {
  try {
    const parsed = new URL(url)
    const port = parsed.port || (parsed.protocol === 'wss:' ? '443' : '80')
    return `${parsed.hostname}:${port}`
  } catch {
    return url
  }
}
