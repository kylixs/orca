import type { WebCloudAuth } from './web-cloud-auth'
import { WebCloudSessionError } from './web-cloud-error'

/**
 * Sends with the freshest access token. A 401 forces one refresh and one retry:
 * a second rejection means the session itself is gone, not a stale token.
 */
export async function authorizedRequest(
  auth: WebCloudAuth,
  send: (accessToken: string) => Promise<unknown>
): Promise<unknown> {
  await auth.ensureFresh()
  try {
    return await send(auth.accessToken)
  } catch (error) {
    // Why only 401: a network or permission failure must not spend a refresh.
    if (!(error instanceof WebCloudSessionError) || error.status !== 401) {
      throw error
    }
  }
  await auth.refresh(true)
  return send(auth.accessToken)
}
