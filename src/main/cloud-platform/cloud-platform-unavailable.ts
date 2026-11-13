/**
 * "The platform did not answer" is not "your session died" (design §6.4, AC-20).
 *
 * A network failure must stay recoverable: the refresh token is still valid, so
 * callers back off and retry instead of signing the user out. Only an answer the
 * platform actually gave can end a session.
 */

export const PLATFORM_UNAVAILABLE = 'PLATFORM_UNAVAILABLE'

const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET'
])

export type PlatformUnavailableError = Error & { code: 'PLATFORM_UNAVAILABLE' }

export function platformUnavailableError(cause?: unknown): PlatformUnavailableError {
  const specific = new Error('platform unavailable')
  const tagged: PlatformUnavailableError = Object.assign(specific, {
    code: 'PLATFORM_UNAVAILABLE' as const,
    ...(cause !== undefined ? { cause } : {})
  })
  return tagged
}

/**
 * `fetch` reports a dead endpoint as a bare `TypeError: fetch failed` with the
 * real reason nested one or two levels down, so walk the cause chain.
 */
export function isPlatformUnreachable(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    if (typeof current !== 'object') {
      return false
    }
    // Some layers rethrow a bare `{ code }`; the code alone identifies a network failure.
    const code = Reflect.get(current, 'code')
    if (typeof code === 'string' && UNREACHABLE_CODES.has(code)) {
      return true
    }
    if (current instanceof Error) {
      if (current.name === 'AbortError' || current.name === 'TimeoutError') {
        return true
      }
      if (current instanceof TypeError && /fetch failed|network/i.test(current.message)) {
        return true
      }
    }
    current = Reflect.get(current, 'cause')
  }
  return false
}

/** Runs one platform request, converting a transport failure into the retryable code. */
export async function platformRequest<T>(send: () => Promise<T>): Promise<T> {
  try {
    return await send()
  } catch (error) {
    if (isPlatformUnreachable(error)) {
      throw platformUnavailableError(error)
    }
    throw error
  }
}
