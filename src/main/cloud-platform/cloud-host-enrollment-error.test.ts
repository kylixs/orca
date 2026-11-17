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
      error: { code: 'host_token_spent', retryable: false, httpStatus: 409 }
    })
  })

  it('falls back to a retryable stable code for 5xx when the body has none', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ error: {} }), { status: 503 })

    const outcome = await enrollCloudHost(INPUT, fetchImpl)

    expect(outcome).toMatchObject({
      ok: false,
      error: { code: 'http_5xx', retryable: true, httpStatus: 503 }
    })
  })

  it('reports a retryable transport failure without an HTTP status', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error('connect ECONNREFUSED')
    }

    const outcome = await enrollCloudHost(INPUT, fetchImpl)

    expect(outcome).toMatchObject({ ok: false, error: { code: 'network', retryable: true } })
    expect(outcome).not.toHaveProperty('error.httpStatus')
  })

  // Design §3.4: a 201 whose body cannot be read is a protocol fault, not a runtime one.
  it('maps an unreadable 2xx body to a non-retryable protocol failure', async () => {
    const fetchImpl: typeof fetch = async () => new Response('not-json', { status: 201 })

    const outcome = await enrollCloudHost(INPUT, fetchImpl)

    expect(outcome).toEqual({
      ok: false,
      error: {
        code: 'protocol',
        retryable: false,
        httpStatus: 201,
        detail: 'register response was not valid JSON'
      }
    })
  })

  it.each([403, 422])(
    'maps a %i with no body code to register_failed and non-retryable',
    async (status) => {
      const fetchImpl: typeof fetch = async () => new Response('', { status })

      const outcome = await enrollCloudHost(INPUT, fetchImpl)

      expect(outcome).toMatchObject({
        ok: false,
        error: { code: 'register_failed', retryable: false, httpStatus: status }
      })
    }
  )

  it.each([
    [401, 'host_token_invalid'],
    [409, 'host_revoked'],
    [400, 'host_name_required']
  ])('maps a %i with no body code to %s and non-retryable', async (status, code) => {
    const fetchImpl: typeof fetch = async () => new Response('', { status })

    const outcome = await enrollCloudHost(INPUT, fetchImpl)

    expect(outcome).toMatchObject({
      ok: false,
      error: { code, retryable: false, httpStatus: status }
    })
  })
})
