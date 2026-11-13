import { describe, expect, it, vi } from 'vitest'
import { createCloudAgentClient } from './cloud-agent-client'

/**
 * A revoked host must stop polling: it has been told nothing else will be
 * admitted, so a timer would only keep a dead credential on the wire.
 */

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

describe('cloud agent host revocation', () => {
  it('M71-2 吊销心跳后标记状态、停止轮询并拒绝升级', async () => {
    let heartbeats = 0
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const target = String(url)
      if (target.endsWith('/v1/jwks')) {
        return jsonResponse({ keys: [] })
      }
      heartbeats += 1
      return jsonResponse({
        hostRevoked: true,
        policyVersion: 1,
        policies: {},
        revoked: { users: [], projects: [], devices: [], jtis: [] }
      })
    })
    const client = createCloudAgentClient({
      apiUrl: 'https://platform.test',
      internalToken: 'unused',
      hostId: 'host_revoked',
      hostName: 'revoked-host',
      refreshMs: 20,
      timeoutMs: 1_000,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub answers only the two endpoints this client calls, with real Response objects.
      fetchImpl: fetchImpl as unknown as typeof fetch,
      heartbeat: { hostId: 'host_revoked', credential: 'credential' }
    })

    await client.refresh()
    expect(client.isHostRevoked()).toBe(true)
    expect(client.snapshot()).toMatchObject({ hostRevoked: true, lastError: 'host_revoked' })
    expect(heartbeats).toBe(1)

    client.start()
    await new Promise((resolve) => setTimeout(resolve, 100))
    // Three refresh intervals pass; a revoked host must not send another beat.
    expect(heartbeats).toBe(1)
    expect(client.admit({})).toMatchObject({ ok: false, reason: 'host_revoked' })
    client.stop()
  })
})
