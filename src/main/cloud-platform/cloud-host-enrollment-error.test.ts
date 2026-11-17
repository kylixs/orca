import { describe, expect, it } from 'vitest'
import { enrollCloudHost, type EnrollInput } from './cloud-host-enrollment'

const INPUT: EnrollInput = {
  apiUrl: 'https://platform.test',
  hostToken: 'token',
  hostName: 'host-a',
  directAddrs: []
}

describe('enrollCloudHost error contract', () => {
  it('keeps the platform code and HTTP status', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ error: { code: 'host_token_spent' } }), {
        status: 409
      })

    const outcome = await enrollCloudHost(INPUT, fetchImpl)

    expect(outcome).toEqual({
      ok: false,
      error: { code: 'host_token_spent', status: 409 }
    })
  })

  it('falls back to a stable code when the body has none', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ error: {} }), { status: 503 })

    const outcome = await enrollCloudHost(INPUT, fetchImpl)

    expect(outcome).toMatchObject({ ok: false, error: { code: 'register_failed', status: 503 } })
  })

  it('reports a transport failure without an HTTP status', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error('connect ECONNREFUSED')
    }

    const outcome = await enrollCloudHost(INPUT, fetchImpl)

    expect(outcome).toMatchObject({ ok: false, error: { code: 'transport' } })
    expect(outcome).not.toHaveProperty('error.status')
  })
})
