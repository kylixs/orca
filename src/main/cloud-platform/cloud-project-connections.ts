import type { CloudConnectionEvent, CloudRpcOutcome } from '../../shared/cloud-platform-ipc'
import type {
  CloudConnectClient,
  CloudConnectTicket,
  CloudDeviceIdentity
} from './cloud-connect-client'

/**
 * One socket per project (design §4.1). The platform session stays singular; this
 * map owns only the live connections, so opening project B never re-points A.
 */

export type CloudSessionOptions = {
  apiUrl: string
  tlsRejectUnauthorized?: boolean
  probeTimeoutMs?: number
  /** Where the saved login lives; omitted by tests that must not touch disk. */
  userDataPath?: string
  /** Refresh this long before expiry; short-lived test tokens shrink it. */
  refreshLeadMs?: number
  /** Test seam: observe/record platform traffic without changing production paths. */
  fetchImpl?: typeof fetch
}

export type CreateCloudClient = (
  options: CloudSessionOptions,
  identity?: CloudDeviceIdentity
) => CloudConnectClient

export type CloudProjectConnection = {
  client: CloudConnectClient
  route: 'direct' | 'relay'
  /** The device the host accepted on this socket's ticket. */
  devicePubKey: string | null
}

export type OpenedCloudConnection = {
  connection: CloudProjectConnection
  ticket: CloudConnectTicket
}

export type CloudConnectionIdentity = {
  projectId: string
  route: 'direct' | 'relay'
  devicePubKey: string | null
}

type ConnectionEntry = CloudProjectConnection & { closing: boolean }

export class CloudProjectConnections {
  private readonly entries = new Map<string, ConnectionEntry>()

  constructor(
    private readonly options: CloudSessionOptions,
    private readonly createClient: CreateCloudClient,
    /** Resolved per open: the session must be signed in and owns the device keys. */
    private readonly identity: () => CloudDeviceIdentity | null,
    private readonly onDropped: (event: CloudConnectionEvent) => void
  ) {}

  get(projectId: string): CloudProjectConnection | null {
    return this.entries.get(projectId) ?? null
  }

  has(projectId: string): boolean {
    return this.entries.has(projectId)
  }

  projectIds(): string[] {
    return [...this.entries.keys()]
  }

  identities(): CloudConnectionIdentity[] {
    return [...this.entries.entries()].map(([projectId, entry]) => ({
      projectId,
      route: entry.route,
      devicePubKey: entry.devicePubKey
    }))
  }

  /** Opens a fresh socket; only this project's previous socket is replaced. */
  async open(projectId: string): Promise<OpenedCloudConnection> {
    const identity = this.identity()
    if (!identity) {
      throw Object.assign(new Error('not signed in'), { code: 'NOT_SIGNED_IN' })
    }
    // Why the shared identity: a second login would register another device, and
    // the host rejects a ticket whose device key is not the hello key.
    const client = this.createClient(this.options, identity)
    let ticket: CloudConnectTicket
    let route: 'direct' | 'relay'
    try {
      const opened = await client.openProject(projectId)
      ticket = opened.ticket
      route = opened.route
    } catch (error) {
      client.close()
      throw error
    }
    return { connection: this.track(projectId, client, route), ticket }
  }

  /** Takes ownership of a client that already completed `openProject`. */
  track(
    projectId: string,
    client: CloudConnectClient,
    route: 'direct' | 'relay'
  ): CloudProjectConnection {
    this.close(projectId)
    const entry: ConnectionEntry = {
      client,
      route,
      devicePubKey: client.ticketDevicePubKey,
      closing: false
    }
    this.entries.set(projectId, entry)
    client.onClose((code, reason) => this.handleClose(projectId, entry, code, reason))
    return { client, route, devicePubKey: entry.devicePubKey }
  }

  close(projectId: string): boolean {
    const entry = this.entries.get(projectId)
    if (!entry) {
      return false
    }
    // Why: an intentional close is not a dropped connection, so it must not make
    // the renderer mark this project as needing attention.
    entry.closing = true
    this.entries.delete(projectId)
    entry.client.close()
    return true
  }

  closeAll(): void {
    for (const projectId of this.projectIds()) {
      this.close(projectId)
    }
  }

  rpc(
    projectId: string,
    method: string,
    params: Record<string, unknown>
  ): Promise<CloudRpcOutcome> {
    const entry = this.entries.get(projectId)
    return entry === undefined
      ? Promise.resolve({ ok: false, code: 'NOT_CONNECTED' })
      : entry.client.rpc(method, params)
  }

  private handleClose(
    projectId: string,
    entry: ConnectionEntry,
    code: number,
    reason: string
  ): void {
    if (entry.closing || this.entries.get(projectId) !== entry) {
      return
    }
    this.entries.delete(projectId)
    this.onDropped({ projectId, route: entry.route, closeCode: code, reason })
  }
}
