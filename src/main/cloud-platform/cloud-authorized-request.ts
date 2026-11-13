import { readField, readString } from '../../shared/json-fields'
import type { CloudAuthSession } from './cloud-auth-session'
import { platformRequest, platformUnavailableError } from './cloud-platform-unavailable'

/** Bearer requests against the platform registry, transparently refreshed once on 401. */

export type CloudRequestInit = {
  method?: string
  headers?: Record<string, string>
  body?: string
}

export async function cloudAuthorizedFetch(
  fetchImpl: typeof fetch,
  apiUrl: string,
  auth: CloudAuthSession,
  path: string,
  init: CloudRequestInit = {}
): Promise<Response> {
  const send = (): Promise<Response> =>
    fetchImpl(`${apiUrl}${path}`, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${auth.accessToken}` }
    })
  // Why wrapped: a dead platform must surface as `PLATFORM_UNAVAILABLE` (a retry
  // later), not as a raw fetch `TypeError` callers cannot branch on.
  await platformRequest(() => auth.ensureFresh())
  const first = await platformRequest(send)
  if (first.status !== 401) {
    return first
  }
  // Why once: a second 401 means the session itself is gone, not a stale token.
  await platformRequest(() => auth.refresh(true))
  return platformRequest(send)
}

/** Throws the platform's error code so callers can treat `SESSION_EXPIRED` specially. */
export async function throwCloudPlatformError(
  res: Response,
  fallback: string,
  message?: string
): Promise<never> {
  // A 5xx without a body still means "ask again later", never "you were rejected".
  if (res.status >= 500) {
    throw platformUnavailableError()
  }
  const body: unknown = await res.json().catch(() => null)
  const code = readString(readField(body, 'error'), 'code') ?? fallback
  throw Object.assign(new Error(code), { code, ...(message !== undefined ? { message } : {}) })
}
