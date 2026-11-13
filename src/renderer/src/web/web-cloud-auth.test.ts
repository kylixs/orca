import { describe, expect, it } from 'vitest'
import { parseJsonText, readString } from '../../../shared/json-fields'
import { createWebCloudAuth } from './web-cloud-auth'
import { WebCloudSessionError } from './web-cloud-error'

/**
 * Renewal semantics without a platform process: the injected clock and fetch
 * make the lead window, single-flight, rotation and lock-out observable.
 */

const START = 1_700_000_000_000

function jsonReply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

type RefreshPlatform = {
  fetchImpl: typeof fetch
  tokens: string[]
  reply: (replacement: () => Response) => void
}

function refreshBodies(): RefreshPlatform {
  const tokens: string[] = []
  const defaultReply = (index: number): Response =>
    jsonReply({
      accessToken: `access-${index}`,
      refreshToken: `refresh-${index}`,
      expiresIn: 120
    })
  let next: () => Response = () => defaultReply(tokens.length)
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = parseJsonText(String(init?.body))
    tokens.push(readString(body, 'refreshToken') ?? '')
    return next()
  }
  return {
    fetchImpl,
    tokens,
    reply: (replacement) => {
      next = replacement
    }
  }
}

async function captureError(run: () => Promise<unknown>): Promise<WebCloudSessionError> {
  const error = await run().then(
    () => null,
    (reason: unknown) => reason
  )
  expect(error).toBeInstanceOf(WebCloudSessionError)
  if (!(error instanceof WebCloudSessionError)) {
    throw new Error('expected WebCloudSessionError')
  }
  return error
}

describe('浏览器云端令牌续期', () => {
  it('只在提前窗口内刷新，刷新后使用旋转后的两个令牌', async () => {
    const clock = { now: START }
    const platform = refreshBodies()
    const auth = createWebCloudAuth({
      apiUrl: 'http://platform.test/',
      accessToken: 'access-0',
      refreshToken: 'refresh-0',
      expiresIn: 120,
      fetchImpl: platform.fetchImpl,
      now: () => clock.now,
      refreshLeadMs: 60_000
    })
    const before = auth.fingerprints()

    await auth.ensureFresh()
    expect(platform.tokens).toEqual([])

    clock.now += 61_000
    await auth.ensureFresh()
    expect(platform.tokens).toEqual(['refresh-0'])
    expect(auth.accessToken).toBe('access-1')
    expect(auth.refreshToken).toBe('refresh-1')
    expect(auth.accessTokenExpiresAt).toBe(clock.now + 120_000)

    const after = auth.fingerprints()
    expect(after.access).not.toBe(before.access)
    expect(after.refresh).not.toBe(before.refresh)
    expect(after.access).toHaveLength(8)
    expect(JSON.stringify(after)).not.toContain('access-1')
    expect(JSON.stringify(after)).not.toContain('refresh-1')

    clock.now += 61_000
    await auth.ensureFresh()
    expect(platform.tokens).toEqual(['refresh-0', 'refresh-1'])
  })

  it('无 expiresIn 时不做提前刷新，只靠 401 强制刷新', async () => {
    const platform = refreshBodies()
    const auth = createWebCloudAuth({
      apiUrl: 'http://platform.test',
      accessToken: 'access-0',
      refreshToken: 'refresh-0',
      fetchImpl: platform.fetchImpl,
      now: () => START,
      refreshLeadMs: 60_000
    })
    await auth.ensureFresh()
    await auth.ensureFresh()
    expect(platform.tokens).toEqual([])
    expect(auth.accessTokenExpiresAt).toBeNull()

    await auth.refresh(true)
    expect(platform.tokens).toEqual(['refresh-0'])
    expect(auth.accessToken).toBe('access-1')
  })

  it('并发刷新单飞：一次请求、两个调用者共享结果', async () => {
    const releases: ((response: Response) => void)[] = []
    const bodies: string[] = []
    const fetchImpl: typeof fetch = (_input, init) => {
      const body = parseJsonText(String(init?.body))
      bodies.push(readString(body, 'refreshToken') ?? '')
      return new Promise<Response>((resolve) => {
        releases.push(resolve)
      })
    }
    const auth = createWebCloudAuth({
      apiUrl: 'http://platform.test',
      accessToken: 'access-0',
      refreshToken: 'refresh-0',
      fetchImpl,
      now: () => START
    })

    const first = auth.refresh(true)
    const second = auth.refresh(true)
    expect(bodies).toEqual(['refresh-0'])
    const release = releases[0]
    if (!release) {
      throw new Error('refresh request was not sent')
    }
    release(jsonReply({ accessToken: 'access-1', refreshToken: 'refresh-1', expiresIn: 120 }))
    await Promise.all([first, second])
    expect(auth.accessToken).toBe('access-1')
  })

  it('刷新失败锁定为 SESSION_EXPIRED，之后不再请求平台', async () => {
    const platform = refreshBodies()
    platform.reply(() => jsonReply({ error: { code: 'SESSION_EXPIRED' } }, 401))
    const auth = createWebCloudAuth({
      apiUrl: 'http://platform.test',
      accessToken: 'access-0',
      refreshToken: 'refresh-0',
      fetchImpl: platform.fetchImpl,
      now: () => START
    })

    const error = await captureError(() => auth.refresh(true))
    expect(error.code).toBe('SESSION_EXPIRED')
    expect(error.status).toBe(401)
    expect(platform.tokens).toEqual(['refresh-0'])

    const locked = await captureError(() => auth.ensureFresh())
    expect(locked.code).toBe('SESSION_EXPIRED')
    expect(platform.tokens).toEqual(['refresh-0'])
  })

  it('网络异常同样把会话锁定为 SESSION_EXPIRED', async () => {
    const auth = createWebCloudAuth({
      apiUrl: 'http://platform.test',
      accessToken: 'access-0',
      refreshToken: 'refresh-0',
      fetchImpl: async () => {
        throw new Error('offline')
      },
      now: () => START
    })
    const error = await captureError(() => auth.refresh(true))
    expect(error.code).toBe('SESSION_EXPIRED')
    expect(error.status).toBe(401)
  })
})
