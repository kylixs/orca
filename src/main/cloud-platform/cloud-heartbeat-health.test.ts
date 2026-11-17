import { describe, expect, it } from 'vitest'
import { createCloudAgentClient } from './cloud-agent-client'
import type { CloudAgentConfig } from './cloud-agent-config'

const NOW = 1_730_000_010_000

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function heartbeatBody(): Record<string, unknown> {
  return { policyVersion: 1, policies: null, revoked: null, maintenance: null }
}

function config(fetchImpl: typeof fetch, now: () => number = () => NOW): CloudAgentConfig {
  return {
    apiUrl: 'https://platform.test',
    internalToken: 'internal',
    hostId: 'host_1',
    hostName: 'dev-001',
    fetchImpl,
    now,
    heartbeat: { hostId: 'host_1', credential: 'cred_1' }
  }
}

function fetchWith(heartbeat: () => Promise<Response>): typeof fetch {
  return async (input) => {
    const url = String(input)
    if (url.endsWith('/v1/jwks')) {
      return jsonResponse({ keys: [] })
    }
    if (url.includes('/heartbeat')) {
      return heartbeat()
    }
    throw new Error(`unexpected fetch: ${url}`)
  }
}

describe('cloud agent heartbeat health', () => {
  it('records a successful heartbeat as online with status 200', async () => {
    const client = createCloudAgentClient(
      config(fetchWith(async () => jsonResponse(heartbeatBody())))
    )
    const seen: { ok: unknown; status: unknown; at: unknown; code: unknown }[] = []
    client.onRefresh((snapshot) => {
      seen.push({
        ok: snapshot.lastHeartbeatOk,
        status: snapshot.lastHeartbeatHttpStatus,
        at: snapshot.lastHeartbeatAt,
        code: snapshot.lastErrorCode
      })
    })

    await client.refresh()

    expect(seen).toEqual([{ ok: true, status: 200, at: NOW, code: null }])
    expect(client.snapshot()).toMatchObject({
      lastHeartbeatOk: true,
      lastHeartbeatHttpStatus: 200,
      lastHeartbeatAt: NOW,
      lastErrorCode: null
    })
  })

  it('records a 401 as an unauthorized heartbeat instead of a silent null', async () => {
    const client = createCloudAgentClient(
      config(fetchWith(async () => new Response('', { status: 401 })))
    )
    let notifications = 0
    client.onRefresh(() => {
      notifications += 1
    })

    await client.refresh()

    expect(notifications).toBe(1)
    expect(client.snapshot()).toMatchObject({
      lastHeartbeatOk: false,
      lastHeartbeatHttpStatus: 401,
      lastHeartbeatAt: null,
      lastErrorCode: 'heartbeat_unauthorized'
    })
  })

  it('records a 5xx heartbeat as failed with the HTTP status', async () => {
    const client = createCloudAgentClient(
      config(fetchWith(async () => new Response('', { status: 503 })))
    )
    let notifications = 0
    client.onRefresh(() => {
      notifications += 1
    })

    await client.refresh()

    expect(notifications).toBe(1)
    expect(client.snapshot()).toMatchObject({
      lastHeartbeatOk: false,
      lastHeartbeatHttpStatus: 503,
      lastErrorCode: 'heartbeat_failed'
    })
  })

  it('records a network failure as failed with no HTTP status', async () => {
    const client = createCloudAgentClient(
      config(
        fetchWith(async () => {
          throw new Error('ECONNREFUSED')
        })
      )
    )
    let notifications = 0
    client.onRefresh(() => {
      notifications += 1
    })

    await client.refresh()

    expect(notifications).toBe(1)
    expect(client.snapshot()).toMatchObject({
      lastHeartbeatOk: false,
      lastHeartbeatHttpStatus: null,
      lastErrorCode: 'heartbeat_failed'
    })
  })

  it('keeps the last successful heartbeat time when a later beat fails', async () => {
    let fail = false
    const client = createCloudAgentClient(
      config(
        fetchWith(async () =>
          fail ? new Response('', { status: 500 }) : jsonResponse(heartbeatBody())
        )
      )
    )

    await client.refresh()
    fail = true
    await client.refresh()

    expect(client.snapshot()).toMatchObject({
      lastHeartbeatOk: false,
      lastHeartbeatHttpStatus: 500,
      lastHeartbeatAt: NOW
    })
  })

  it('notifies listeners when refresh itself throws', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/v1/jwks')) {
        // A truncated body makes Response.json() reject inside the refresh pass.
        return new Response('not json', {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }
    const client = createCloudAgentClient(config(fetchImpl))
    let notifications = 0
    client.onRefresh(() => {
      notifications += 1
    })

    await client.refresh()

    expect(notifications).toBe(1)
    expect(client.snapshot()).toMatchObject({
      lastHeartbeatOk: false,
      lastHeartbeatHttpStatus: null,
      lastErrorCode: 'heartbeat_failed'
    })
    expect(client.snapshot().lastError).not.toBeNull()
  })

  it('backs heartbeat retries off 10s, 30s, then 60s while degraded', async () => {
    let at = NOW
    let beats = 0
    const client = createCloudAgentClient(
      config(
        fetchWith(async () => {
          beats += 1
          return new Response('', { status: 503 })
        }),
        () => at
      )
    )

    await client.refresh()
    expect(beats).toBe(1)
    expect(client.snapshot()).toMatchObject({
      lastHeartbeatOk: false,
      lastHeartbeatHttpStatus: 503,
      lastErrorCode: 'heartbeat_failed'
    })

    at = NOW + 9_999
    await client.refresh()
    expect(beats).toBe(1)

    at = NOW + 10_000
    await client.refresh()
    expect(beats).toBe(2)

    at += 29_999
    await client.refresh()
    expect(beats).toBe(2)

    at += 1
    await client.refresh()
    expect(beats).toBe(3)

    at += 59_999
    await client.refresh()
    expect(beats).toBe(3)

    at += 1
    await client.refresh()
    expect(beats).toBe(4)
    expect(client.snapshot().lastHeartbeatOk).toBe(false)
  })

  it('returns to online and resets the backoff after a successful beat', async () => {
    let at = NOW
    let healthy = false
    let beats = 0
    const client = createCloudAgentClient(
      config(
        fetchWith(async () => {
          beats += 1
          return healthy ? jsonResponse(heartbeatBody()) : new Response('', { status: 500 })
        }),
        () => at
      )
    )

    await client.refresh()
    at = NOW + 10_000
    healthy = true
    await client.refresh()

    expect(beats).toBe(2)
    expect(client.snapshot()).toMatchObject({
      lastHeartbeatOk: true,
      lastHeartbeatHttpStatus: 200,
      lastHeartbeatAt: at,
      lastErrorCode: null
    })

    // A later failure schedules its first retry only 10s out again.
    healthy = false
    at += 10_000
    await client.refresh()
    at += 9_999
    await client.refresh()
    expect(beats).toBe(3)
    at += 1
    await client.refresh()
    expect(beats).toBe(4)
  })

  it('classifies a 409 heartbeat as a terminal host revocation', async () => {
    const client = createCloudAgentClient(
      config(
        fetchWith(
          async () =>
            new Response(JSON.stringify({ error: { code: 'HOST_REVOKED' } }), { status: 409 })
        )
      )
    )

    await client.refresh()

    expect(client.snapshot()).toMatchObject({
      lastHeartbeatOk: false,
      lastHeartbeatHttpStatus: 409,
      lastErrorCode: 'host_revoked'
    })
  })

  it('classifies hostRevoked on an accepted beat as a terminal revocation', async () => {
    const client = createCloudAgentClient(
      config(fetchWith(async () => jsonResponse({ ...heartbeatBody(), hostRevoked: true })))
    )

    await client.refresh()

    expect(client.snapshot()).toMatchObject({
      hostRevoked: true,
      lastHeartbeatOk: false,
      lastHeartbeatHttpStatus: 200,
      lastErrorCode: 'host_revoked'
    })
  })
})
