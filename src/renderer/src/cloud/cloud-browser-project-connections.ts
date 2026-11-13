import { readTicketClaims } from '../../../shared/cloud-platform-reply'
import type {
  CloudConnectionEvent,
  CloudHostKeyMismatch,
  CloudOpenResult
} from '../../../shared/cloud-platform-ipc'
import { loadWebHostTrust, pinWebHostKey, webHostKeyVerdict } from '../web/web-host-key-trust'
import type { WebCloudSessionStorage } from '../web/web-cloud-session-storage'
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
  /** Where host-key pins live; the browser persists them in localStorage. */
  hostTrustStorage: WebCloudSessionStorage
  now?: () => number
  onPlatformError: (error: unknown) => void
  onDropped: (event: CloudConnectionEvent) => void
}

export class BrowserProjectConnections {
  private readonly entries = new Map<string, OpenConnection>()
  /** A mismatch's incoming key, held only until the user re-verifies it (AC-29). */
  private readonly pendingKeys = new Map<string, string>()

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
      const refused = await this.checkHostKey(ticket)
      if (refused) {
        return refused
      }
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
        permissions: readTicketClaims(ticket.credential).permissions,
        hostId: ticket.host.id,
        hostFingerprint: this.pinnedFingerprint(ticket.host.id)
      }
      this.entries.set(projectId, entry)
      return entry
    } catch (error) {
      this.host.onPlatformError(error)
      return failure(error, 'OPEN_FAILED')
    }
  }

  /**
   * Trust on first use, browser half (AC-29). A changed key is refused before any
   * socket is opened — the browser cannot send a 4433 close because there is no
   * connection to close yet.
   */
  private async checkHostKey(ticket: {
    host: { id: string; e2eePublicKeyB64: string }
  }): Promise<{ ok: false; code: string; message: string; hostKey?: CloudHostKeyMismatch } | null> {
    const { id: hostId, e2eePublicKeyB64 } = ticket.host
    if (!e2eePublicKeyB64) {
      return null
    }
    const verdict = await webHostKeyVerdict(
      loadWebHostTrust(this.host.hostTrustStorage),
      hostId,
      e2eePublicKeyB64
    )
    if (verdict.state === 'mismatch') {
      this.pendingKeys.set(hostId, e2eePublicKeyB64)
      return {
        ok: false,
        code: 'FINGERPRINT_MISMATCH',
        message: 'host public key changed',
        hostKey: {
          hostId,
          pinnedFingerprint: verdict.pinnedFingerprint,
          seenFingerprint: verdict.seenFingerprint
        }
      }
    }
    if (verdict.state === 'first_use') {
      await pinWebHostKey(
        this.host.hostTrustStorage,
        hostId,
        e2eePublicKeyB64,
        this.host.now?.() ?? Date.now()
      )
    }
    this.pendingKeys.delete(hostId)
    return null
  }

  /** The user re-verified a changed host key; pins what the mismatch exposed. */
  async trustPendingHostKey(hostId: string): Promise<boolean> {
    const key = this.pendingKeys.get(hostId)
    if (key === undefined) {
      return false
    }
    await pinWebHostKey(this.host.hostTrustStorage, hostId, key, this.host.now?.() ?? Date.now())
    this.pendingKeys.delete(hostId)
    return true
  }

  /** The fingerprint pinned for a host, shown by the workspace view. */
  pinnedFingerprint(hostId: string): string | null {
    return loadWebHostTrust(this.host.hostTrustStorage).hosts[hostId]?.fingerprint ?? null
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
