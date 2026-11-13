import { readField, readString } from '../../shared/json-fields'
import type { CloudAuthSession } from './cloud-auth-session'

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
  await auth.ensureFresh()
  const first = await send()
  if (first.status !== 401) {
    return first
  }
  // Why once: a second 401 means the session itself is gone, not a stale token.
  await auth.refresh(true)
  return send()
}

/** Throws the platform's error code so callers can treat `SESSION_EXPIRED` specially. */
export async function throwCloudPlatformError(
  res: Response,
  fallback: string,
  message?: string
): Promise<never> {
  const body: unknown = await res.json().catch(() => null)
  const code = readString(readField(body, 'error'), 'code') ?? fallback
  throw Object.assign(new Error(code), { code, ...(message !== undefined ? { message } : {}) })
}
