import { describe, expect, it } from 'vitest'
import { readString } from '../../shared/json-fields'
import { createCloudAuthSession, type CloudAuthSessionInit } from './cloud-auth-session'

/**
 * The refresh policy in isolation: when it fires, that concurrent callers share
 * one request, that a dead refresh token is remembered, and that rotation sticks.
 */

type RecordedCall = { url: string; refreshToken: string }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function harness(init: Partial<CloudAuthSessionInit> = {}): {
  calls: RecordedCall[]
  next: (body: unknown, status?: number) => void
  advance: (ms: number) => void
  session: ReturnType<typeof createCloudAuthSession>
} {
  let clock = 1_000_000
  let responder: { body: unknown; status: number } = {
    body: { accessToken: 'a2', refreshToken: 'r2', expiresIn: 100 },
    status: 200
  }
  const calls: RecordedCall[] = []
  const fetchImpl: typeof fetch = async (input, requestInit) => {
    const body: unknown = JSON.parse(String(requestInit?.body))
    calls.push({ url: String(input), refreshToken: readString(body, 'refreshToken') ?? '' })
    return jsonResponse(responder.body, responder.status)
  }
  const session = createCloudAuthSession({
    apiUrl: 'http://platform.test',
    accessToken: 'a1',
    refreshToken: 'r1',
    expiresIn: 100,
    fetchImpl,
    now: () => clock,
    ...init
  })
  return {
    calls,
    next: (body, status = 200) => {
      responder = { body, status }
    },
    advance: (ms) => {
      clock += ms
    },
    session
  }
}

describe('云端令牌自动续期（单测）', () => {
  it('距过期超过阈值时不刷新，进入 60s 窗口后刷新并替换全部字段', async () => {
    const { calls, session, advance } = harness()
    await session.ensureFresh()
    expect(calls).toEqual([])
    expect(session.accessTokenExpiresAt).toBe(1_000_000 + 100_000)

    advance(40_000)
    await session.ensureFresh()
    expect(calls).toEqual([{ url: 'http://platform.test/v1/auth/refresh', refreshToken: 'r1' }])
    expect(session.accessToken).toBe('a2')
    expect(session.refreshToken).toBe('r2')
    expect(session.accessTokenExpiresAt).toBe(1_040_000 + 100_000)
  })

  it('并发调用共享同一个刷新请求（单飞）', async () => {
    const { calls, session, next } = harness({ expiresIn: 0 })
    next({ accessToken: 'a2', refreshToken: 'r2', expiresIn: 100 })
    await Promise.all([session.refresh(true), session.refresh(true), session.ensureFresh()])
    expect(calls).toHaveLength(1)
    expect(session.accessToken).toBe('a2')
  })

  it('刷新失败抛 SESSION_EXPIRED，并记住已失效，后续调用不再打平台', async () => {
    const { calls, session, next, advance } = harness({ expiresIn: 0 })
    next({ error: { code: 'SESSION_EXPIRED' } }, 401)
    await expect(session.refresh(true)).rejects.toMatchObject({ code: 'SESSION_EXPIRED' })
    expect(calls).toHaveLength(1)

    advance(10_000)
    await expect(session.refresh(true)).rejects.toMatchObject({ code: 'SESSION_EXPIRED' })
    await expect(session.ensureFresh()).rejects.toMatchObject({ code: 'SESSION_EXPIRED' })
    expect(calls).toHaveLength(1)
  })

  it('旋转后下一次刷新使用新的 refresh token', async () => {
    const { calls, session, next } = harness({ expiresIn: 0 })
    next({ accessToken: 'a2', refreshToken: 'r2', expiresIn: 0 })
    await session.refresh(true)
    next({ accessToken: 'a3', refreshToken: 'r3', expiresIn: 0 })
    await session.refresh(true)
    expect(calls.map((call) => call.refreshToken)).toEqual(['r1', 'r2'])
    expect(session.refreshToken).toBe('r3')
  })

  it('旧平台没有 expiresIn 时不提前刷新，401 后强制刷新可用', async () => {
    const { calls, session } = harness({ expiresIn: undefined })
    await session.ensureFresh()
    expect(calls).toEqual([])
    expect(session.accessTokenExpiresAt).toBeNull()

    await session.refresh(true)
    expect(calls).toHaveLength(1)
    expect(session.accessToken).toBe('a2')
    // The refresh response restored an expiry, so later calls are proactive again.
    expect(session.accessTokenExpiresAt).toBe(1_000_000 + 100_000)
  })

  it('旧平台刷新失败后，即使没有过期时间也不再放行请求', async () => {
    const { calls, session, next } = harness({ expiresIn: undefined })
    next({ error: { code: 'SESSION_EXPIRED' } }, 401)
    await expect(session.refresh(true)).rejects.toMatchObject({ code: 'SESSION_EXPIRED' })
    await expect(session.ensureFresh()).rejects.toMatchObject({ code: 'SESSION_EXPIRED' })
    expect(calls).toHaveLength(1)
  })

  it('没有 refresh token 时立即判定会话失效', async () => {
    const { calls, session } = harness({ refreshToken: null })
    await expect(session.refresh(true)).rejects.toMatchObject({ code: 'SESSION_EXPIRED' })
    expect(calls).toEqual([])
  })

  it('指纹不含原文，但能区分刷新前后的令牌', async () => {
    const { session } = harness({ expiresIn: 0 })
    const before = session.fingerprints()
    await session.refresh(true)
    const after = session.fingerprints()
    expect(before.access).not.toBe('a1')
    expect(before.access).not.toBe(after.access)
    expect(after.refresh).not.toBe(before.refresh)
    expect(Object.values(after)).not.toContain('a2')
  })
})
