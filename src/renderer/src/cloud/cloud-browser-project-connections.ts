import { readTicketClaims } from '../../../shared/cloud-platform-reply'
import type { CloudConnectionEvent, CloudOpenResult } from '../../../shared/cloud-platform-ipc'
import type { WebCloudDeviceIdentity } from '../web/web-cloud-device-key'
import type { WebPairingOffer } from '../web/web-pairing'
import {
  cloudPairingOfferFromTicket,
  requestCloudTicket,
  type WebCloudSession
} from '../web/web-cloud-session'
import {
  failure,
  routeOf,
  type BrowserCloudClient,
  type OpenConnection
} from './cloud-browser-bridge-replies'

/**
 * One browser socket per opened project. Opening B must not re-point A, and a
 * dropped socket belongs to its own project, so the map is keyed by project id.
 */

const STATUS_TIMEOUT_MS = 15_000

export type BrowserConnectionHost = {
  getSession: () => WebCloudSession | null
  getIdentity: () => WebCloudDeviceIdentity | null
  fetchImpl?: typeof fetch
  endpointUrl?: string
  createClient: (offer: WebPairingOffer, secretKeyB64: string) => BrowserCloudClient
  onPlatformError: (error: unknown) => void
  onDropped: (event: CloudConnectionEvent) => void
}

export class BrowserProjectConnections {
  private readonly entries = new Map<string, OpenConnection>()

  constructor(private readonly host: BrowserConnectionHost) {}

  get(projectId: string): OpenConnection | null {
    return this.entries.get(projectId) ?? null
  }

  close(projectId: string): boolean {
    const entry = this.entries.get(projectId)
    if (!entry) {
      return false
    }
    this.entries.delete(projectId)
    entry.client.close()
    return true
  }

  closeAll(): void {
    for (const projectId of Array.from(this.entries.keys())) {
      this.close(projectId)
    }
  }

  async open(projectId: string): Promise<OpenConnection | CloudOpenResult> {
    const session = this.host.getSession()
    const identity = this.host.getIdentity()
    if (!session || !identity) {
      return { ok: false, code: 'NOT_SIGNED_IN' }
    }
    try {
      const ticket = await requestCloudTicket(
        session,
        projectId,
        identity.publicKeyB64,
        this.host.fetchImpl ? { fetchImpl: this.host.fetchImpl } : {}
      )
      const offer = cloudPairingOfferFromTicket(
        ticket,
        identity.publicKeyB64,
        this.host.endpointUrl ? { endpointUrl: this.host.endpointUrl } : {}
      )
      const client = this.host.createClient(offer, identity.secretKeyB64)
      const probe = await client.call('status.get', undefined, { timeoutMs: STATUS_TIMEOUT_MS })
      if (!probe.ok) {
        client.close()
        return { ok: false, code: probe.error.code, message: probe.error.message }
      }
      this.close(projectId)
      const entry: OpenConnection = {
        client,
        route: routeOf(offer, ticket),
        workspace: ticket.workspace,
        capabilities: ticket.host.capabilities,
        permissions: readTicketClaims(ticket.credential).permissions
      }
      this.entries.set(projectId, entry)
      return entry
    } catch (error) {
      this.host.onPlatformError(error)
      return failure(error, 'OPEN_FAILED')
    }
  }

  /** Polls only while someone listens; a dropped socket is the notice the UI shows. */
  sweep(): void {
    for (const [projectId, entry] of Array.from(this.entries)) {
      const next = entry.client.connectionState
      if (next !== 'disconnected' && next !== 'auth-failed') {
        continue
      }
      this.entries.delete(projectId)
      entry.client.close()
      this.host.onDropped({ projectId, route: entry.route, closeCode: null, reason: next })
    }
  }
}
