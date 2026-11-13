import { describe, expect, it, vi } from 'vitest'
import {
  isPlatformUnreachable,
  platformRequest,
  platformUnavailableError
} from './cloud-platform-unavailable'

/** M75: the transport shapes a dead platform actually produces. */

function fetchFailed(cause: unknown): Error {
  return Object.assign(new TypeError('fetch failed'), { cause })
}

describe('platform unreachability', () => {
  it('recognises the nested reasons node fetch reports', () => {
    expect(isPlatformUnreachable(fetchFailed({ code: 'ECONNREFUSED' }))).toBe(true)
    expect(isPlatformUnreachable(fetchFailed({ code: 'ENOTFOUND' }))).toBe(true)
    expect(
      isPlatformUnreachable(new Error('socket hang up', { cause: { code: 'ECONNRESET' } }))
    ).toBe(true)
    expect(isPlatformUnreachable(Object.assign(new Error('t'), { name: 'TimeoutError' }))).toBe(
      true
    )
  })

  it('does not mistake an application error for an outage', () => {
    expect(isPlatformUnreachable(platformUnavailableError())).toBe(false)
    expect(isPlatformUnreachable(Object.assign(new Error('x'), { code: 'SESSION_EXPIRED' }))).toBe(
      false
    )
    expect(isPlatformUnreachable(null)).toBe(false)
  })

  it('converts a transport failure and passes other errors through untouched', async () => {
    const refusal = fetchFailed({ code: 'ECONNREFUSED' })
    await expect(platformRequest(() => Promise.reject(refusal))).rejects.toMatchObject({
      code: 'PLATFORM_UNAVAILABLE'
    })
    const expired = Object.assign(new Error('session expired'), { code: 'SESSION_EXPIRED' })
    await expect(platformRequest(() => Promise.reject(expired))).rejects.toBe(expired)
    const ok = vi.fn(async () => 'value')
    await expect(platformRequest(ok)).resolves.toBe('value')
  })
})
