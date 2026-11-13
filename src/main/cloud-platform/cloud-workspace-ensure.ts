import { openCloudWorkspaceOverRpc } from '../../shared/cloud-workspace-open'
import type { CloudConnectClient } from './cloud-connect-client'

/**
 * Design §8.3 step 3, desktop binding: connect through a fresh ticket, then hand
 * the ticket's roots to the shared checkout-selection logic.
 */

export type EnsureWorkspaceResult =
  | {
      ok: true
      workspacePath: string
      created: boolean
      capabilities: string[]
      /** The route the live connection used; the session tracks the socket by it. */
      route: 'direct' | 'relay'
    }
  | { ok: false; code: string; message?: string }

export async function ensureCloudWorkspace(
  client: CloudConnectClient,
  projectId: string
): Promise<EnsureWorkspaceResult> {
  let ticket
  try {
    ticket = await client.openProject(projectId)
  } catch (error) {
    const code = error !== null && typeof error === 'object' ? Reflect.get(error, 'code') : null
    return {
      ok: false,
      code: typeof code === 'string' ? code : 'OPEN_FAILED',
      message: error instanceof Error ? error.message : String(error)
    }
  }

  const ensured = await openCloudWorkspaceOverRpc(
    (method, params, timeoutMs) => client.rpc(method, params, timeoutMs),
    projectId,
    ticket.ticket.workspace
  )
  return ensured.ok
    ? { ...ensured, capabilities: ticket.ticket.host.capabilities, route: ticket.route }
    : ensured
}
