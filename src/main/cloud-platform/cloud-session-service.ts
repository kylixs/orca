import type {
  CloudConnectionEvent,
  CloudOpenResult,
  CloudProjectSummary,
  CloudRpcOutcome,
  CloudSessionState
} from '../../shared/cloud-platform-ipc'
import { CloudConnectClient, type CloudProject } from './cloud-connect-client'
import { buildCloudProjectLink, type CloudProjectLink } from './cloud-pairing-offer'
import { errorCodeOf } from '../../shared/json-fields'
import { ensureCloudWorkspace, type EnsureWorkspaceResult } from './cloud-workspace-ensure'
import {
  CloudProjectConnections,
  type CloudConnectionIdentity,
  type CloudSessionOptions,
  type CreateCloudClient
} from './cloud-project-connections'

export type { CloudSessionOptions } from './cloud-project-connections'
export type { CloudConnectionIdentity } from './cloud-project-connections'

export type CloudProjectLinkResult =
  | { ok: true; link: CloudProjectLink }
  | { ok: false; code: string; message?: string }

/**
 * Owns the desktop cloud session. One platform login (token, device keys, device
 * id) and one live socket per project; the renderer sees only credential-free state.
 */

export type CloudSessionDeps = {
  createClient?: CreateCloudClient
}

function summarize(project: CloudProject): CloudProjectSummary {
  return {
    id: project.id,
    key: project.key,
    name: project.name,
    hostName: project.hostName,
    hostStatus: project.hostStatus,
    // Managed projects deny export by default; the host enforces it, this only
    // drives whether the UI offers the action at all (FR-7.3).
    downloadRestricted: !project.permissions.includes('download')
  }
}

export class CloudSessionService {
  private readonly options: CloudSessionOptions
  private readonly createClient: CreateCloudClient
  private client: CloudConnectClient | null = null
  private readonly connections: CloudProjectConnections
  private state: CloudSessionState = { status: 'signed-out' }
  private listeners = new Set<(event: CloudConnectionEvent) => void>()

  constructor(options: CloudSessionOptions, deps: CloudSessionDeps = {}) {
    this.options = options
    this.createClient =
      deps.createClient ?? ((settings, identity) => new CloudConnectClient(settings, identity))
    this.connections = new CloudProjectConnections(
      options,
      this.createClient,
      () => this.client?.deviceIdentity() ?? null,
      (event) => this.emit(event)
    )
  }

  onConnectionChanged(listener: (event: CloudConnectionEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Identifier only: the token and device key stay inside the client. */
  get currentDeviceId(): string {
    return this.client?.currentDeviceId ?? ''
  }

  /** Main-process only (never over IPC): the device key the host demands proof of. */
  deviceKeyPair(): { publicKey: Uint8Array; secretKey: Uint8Array } | null {
    return this.client?.deviceKeyPair() ?? null
  }

  getState(): CloudSessionState {
    return this.state
  }

  async login(username: string, password: string): Promise<CloudSessionState> {
    this.connections.closeAll()
    this.client?.close()
    this.client = null
    const client = this.createClient(this.options)
    const user = await client.login(username, password)
    const projects = await client.listProjects()
    this.client = client
    this.state = {
      status: 'signed-in',
      displayName: user.displayName,
      projects: projects.map(summarize)
    }
    return this.state
  }

  logout(): CloudSessionState {
    this.connections.closeAll()
    this.client?.close()
    this.client = null
    this.state = { status: 'signed-out' }
    return this.state
  }

  /** Leaves one workspace without ending the platform session or other projects. */
  closeProject(projectId: string): { ok: true } {
    // Keeps the token and device keys: reopening must not need a re-login.
    this.connections.close(projectId)
    return { ok: true }
  }

  async listProjects(): Promise<CloudProjectSummary[]> {
    if (!this.client) {
      throw Object.assign(new Error('not signed in'), { code: 'NOT_SIGNED_IN' })
    }
    const projects = await this.client.listProjects()
    const summaries = projects.map(summarize)
    if (this.state.status === 'signed-in') {
      this.state = { ...this.state, projects: summaries }
    }
    return summaries
  }

  async openProject(projectId: string): Promise<CloudOpenResult> {
    if (!this.client) {
      return { ok: false, code: 'NOT_SIGNED_IN' }
    }
    try {
      const { connection, ticket } = await this.connections.open(projectId)
      return {
        ok: true,
        projectId,
        route: connection.route,
        workspaceRoot: ticket.workspace.workspaceRoot,
        capabilities: ticket.host.capabilities
      }
    } catch (error) {
      const code = errorCodeOf(error) ?? 'OPEN_FAILED'
      return { ok: false, code, message: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Opens the project and makes sure the user's checkout exists (design §8.3):
   * an existing worktree in their workspace root is reused, otherwise one is
   * created through `worktree.createManaged`.
   */
  async ensureWorkspace(projectId: string): Promise<EnsureWorkspaceResult> {
    const identity = this.client?.deviceIdentity()
    if (!identity) {
      return { ok: false, code: 'NOT_SIGNED_IN' }
    }
    // Why a fresh client: this socket performs the worktree calls itself, so it
    // must not share the platform session's no-socket client. An existing socket
    // for the project stays untouched until this one succeeds.
    const client = this.createClient(this.options, identity)
    const result = await ensureCloudWorkspace(client, projectId)
    if (!result.ok) {
      client.close()
      return result
    }
    this.connections.track(projectId, client, result.route)
    return result
  }

  /**
   * Material for the renderer's own Orca workspace connection. The main process
   * does not open a socket here: the ticket is single-use and belongs to whoever
   * connects with it.
   */
  async prepareProjectLink(projectId: string): Promise<CloudProjectLinkResult> {
    if (!this.client) {
      return { ok: false, code: 'NOT_SIGNED_IN' }
    }
    try {
      const prepared = await this.client.prepareProjectLink(projectId)
      const link = buildCloudProjectLink({
        ticket: prepared.ticket,
        endpoint: prepared.endpoint,
        route: prepared.route,
        tlsRejectUnauthorized: this.options.tlsRejectUnauthorized
      })
      if (!link) {
        return { ok: false, code: 'HOST_KEY_INVALID' }
      }
      return { ok: true, link }
    } catch (error) {
      const code = errorCodeOf(error) ?? 'OPEN_FAILED'
      return { ok: false, code, message: error instanceof Error ? error.message : String(error) }
    }
  }

  rpc(
    method: string,
    params: Record<string, unknown>,
    projectId: string
  ): Promise<CloudRpcOutcome> {
    if (!this.client) {
      return Promise.resolve({ ok: false, code: 'NOT_SIGNED_IN' })
    }
    return this.connections.rpc(projectId, method, params)
  }

  /** True while that project's host socket is live; used to decide reconnects. */
  isProjectConnected(projectId: string): boolean {
    return this.connections.has(projectId)
  }

  get connectedProjectIds(): string[] {
    return this.connections.projectIds()
  }

  /** Main-process only: which device each live connection's ticket proved. */
  connectionIdentities(): CloudConnectionIdentity[] {
    return this.connections.identities()
  }

  private emit(event: CloudConnectionEvent): void {
    for (const listener of this.listeners) {
      listener(event)
    }
  }
}
