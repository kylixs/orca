/**
 * One refresh pass's control-plane reads. Each outcome is independent: a broken
 * JWKS endpoint must not stop revocation from being applied, or an unreachable
 * key endpoint would keep a revoked device online (review-07 F1).
 */

export type ControlPlaneReads = {
  jwks: Response | null
  revoked: Response | null
  policy: Response | null
}

export type ControlPlaneReadInput = {
  fetchImpl: typeof fetch
  apiUrl: string
  internalUrl: string
  internalToken: string
  timeoutMs: number
  /** An enrolled host gets revocation and policy from its heartbeat instead. */
  heartbeatMode: boolean
}

export async function fetchControlPlaneReads(
  input: ControlPlaneReadInput
): Promise<ControlPlaneReads> {
  const headers = { 'x-internal-token': input.internalToken }
  const signal = (): AbortSignal => AbortSignal.timeout(input.timeoutMs)
  const results = await Promise.allSettled([
    input.fetchImpl(`${input.apiUrl}/v1/jwks`, { signal: signal() }),
    input.heartbeatMode
      ? Promise.resolve(null)
      : input.fetchImpl(`${input.internalUrl}/v1/internal/revocations`, {
          signal: signal(),
          headers
        }),
    // Poll-mode hosts have no heartbeat, so this is their only policy channel.
    input.heartbeatMode
      ? Promise.resolve(null)
      : input.fetchImpl(`${input.internalUrl}/v1/internal/policy`, { signal: signal(), headers })
  ])
  const settled = results.map((result) => (result.status === 'fulfilled' ? result.value : null))
  return { jwks: settled[0], revoked: settled[1], policy: settled[2] }
}
