import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { errorCodeOf } from '../../../shared/json-fields'
import type { CloudReplyTicket } from '../../../shared/cloud-platform-reply'
import type {
  CloudProjectPermission,
  CloudProjectSummary,
  CloudRpcOutcome
} from '../../../shared/cloud-platform-ipc'
import { WebCloudSessionError, type WebCloudProject } from '../web/web-cloud-session'
import type { WebRuntimeClient } from '../web/web-runtime-client'
import type { WebPairingOffer } from '../web/web-pairing'

/** Reply-shaped values the browser bridge hands back; no platform calls happen here. */

export type BrowserCloudClient = Pick<WebRuntimeClient, 'call' | 'close' | 'connectionState'> & {
  /** Streams a runtime subscription on a child socket; scripted doubles may omit it. */
  subscribe?: WebRuntimeClient['subscribe']
}

export type OpenConnection = {
  client: BrowserCloudClient
  route: 'direct' | 'relay'
  workspace: CloudReplyTicket['workspace']
  capabilities: string[]
  permissions?: CloudProjectPermission[]
  /** The host this socket belongs to, and the key pin the open verified (AC-29). */
  hostId: string
  hostFingerprint: string | null
}

export function summarize(project: WebCloudProject): CloudProjectSummary {
  return {
    id: project.id,
    key: project.key,
    name: project.name,
    hostName: project.hostName,
    hostStatus: project.hostStatus,
    status: project.status,
    provisioningError: project.provisioningError,
    downloadRestricted: project.downloadRestricted
  }
}

export function routeOf(offer: WebPairingOffer, ticket: CloudReplyTicket): 'direct' | 'relay' {
  return ticket.endpoints.direct.some((endpoint) => endpoint.url === offer.endpoint)
    ? 'direct'
    : 'relay'
}

export function outcomeOf(reply: RuntimeRpcResponse<unknown>): CloudRpcOutcome {
  return reply.ok
    ? { ok: true, result: reply.result }
    : { ok: false, code: reply.error.code, message: reply.error.message }
}

export function failure(
  cause: unknown,
  fallback: string
): { ok: false; code: string; message: string } {
  return {
    ok: false,
    code: errorCodeOf(cause) ?? fallback,
    message: cause instanceof Error ? cause.message : String(cause)
  }
}

export function isSessionExpired(error: unknown): boolean {
  return error instanceof WebCloudSessionError && error.code === 'SESSION_EXPIRED'
}
