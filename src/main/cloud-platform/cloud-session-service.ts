import type {
  CloudConnectionEvent,
  CloudCreateProjectInput,
  CloudOpenResult,
  CloudProjectSummary,
  CloudProvisionableHost,
  CloudRpcOutcome,
  CloudSessionState
} from '../../shared/cloud-platform-ipc'
import { CloudConnectClient, type CloudProject } from './cloud-connect-client'
import type { CloudAuthFingerprints } from './cloud-auth-session'
import { CloudSessionSavedLogin } from './cloud-session-saved-login'
import {
  archiveSessionProject,
  createSessionProject,
  type CreateProjectOutcome,
  type ProjectAdminHooks
} from './cloud-session-project-admin'
import { summarizeCloudProject } from './cloud-project-summary'
import { buildCloudProjectLink, type CloudProjectLinkResult } from './cloud-pairing-offer'
import { errorCodeOf } from '../../shared/json-fields'
import {
  provisionCloudProjectOverRpc,
  type ProvisionCloudProjectResult
} from '../../shared/cloud-workspace-open'
import { ensureCloudWorkspace, type EnsureWorkspaceResult } from './cloud-workspace-ensure'
import {
  CloudProjectConnections,
  type CloudConnectionIdentity,
  type CloudSessionOptions,
  type CreateCloudClient
} from './cloud-project-connections'

export type { CloudProjectLinkResult } from './cloud-pairing-offer'

/**
 * Owns the desktop cloud session. One platform login (token, device keys, device
 * id) and one live socket per project; the renderer sees only credential-free state.
 */

export type CloudSessionDeps = { createClient?: CreateCloudClient }

export class CloudSessionService {
  private readonly options: CloudSessionOptions
  private readonly createClient: CreateCloudClient
  private client: CloudConnectClient | null = null
  private readonly connections: CloudProjectConnections
  private state: CloudSessionState = { status: 'signed-out' }
  private listeners = new Set<(event: CloudConnectionEvent) => void>()
  private restorePromise: Promise<CloudSessionState> | null = null
  private readonly savedLogin: CloudSessionSavedLogin

  constructor(options: CloudSessionOptions, deps: CloudSessionDeps = {}) {
    this.options = options
    this.createClient =
      deps.createClient ?? ((settings, identity) => new CloudConnectClient(settings, identity))
    this.savedLogin = new CloudSessionSavedLogin(options, this.createClient)
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

  /** Main-process diagnostics: non-reversible token digests, never the tokens. */
  authTokenFingerprints(): CloudAuthFingerprints | null {
    return this.client?.authTokenFingerprints() ?? null
  }

  /** A dead platform session signs out and asks the renderer to show the login page. */
  private expireSession(): void {
    // Why once: concurrent platform calls can all fail after the first one signed out.
    if (this.state.status !== 'signed-in') {
      return
    }
    this.logout()
    this.emit({ projectId: null, route: null, closeCode: 4401, reason: 'session_expired' })
  }

  /** Returns the code for callers that must map it into their own result. */
  private expiredCode(error: unknown): string | null {
    const code = errorCodeOf(error)
    if (code === 'SESSION_EXPIRED') {
      this.expireSession()
      return code
    }
    return null
  }

  /** Rebuilds a login saved by a previous process; the first platform call validates it. */
  restoreSession(): Promise<CloudSessionState> {
    // Why single-flight: boot starts this in the background, the first state read awaits it.
    return (this.restorePromise ??= this.performRestore())
  }

  /** The current state once the background restore has settled (immediate if not started). */
  whenRestored(): Promise<CloudSessionState> {
    return this.restorePromise ?? Promise.resolve(this.state)
  }

  private async performRestore(): Promise<CloudSessionState> {
    if (this.state.status === 'signed-in') {
      return this.state
    }
    const restored = await this.savedLogin.restore()
    if (restored.kind !== 'ready') {
      return this.state
    }
    this.client = restored.client
    this.state = {
      status: 'signed-in',
      displayName: restored.displayName,
      projects: restored.projects.map(summarizeCloudProject)
    }
    return this.state
  }

  async login(username: string, password: string): Promise<CloudSessionState> {
    this.connections.closeAll()
    this.client?.close()
    this.client = null
    const client = this.createClient(this.savedLogin.restoredClientOptions)
    const user = await client.login(username, password)
    const projects = await client.listProjects()
    this.client = client
    this.savedLogin.attach(client.deviceIdentity(), user.displayName)
    this.state = {
      status: 'signed-in',
      displayName: user.displayName,
      projects: projects.map(summarizeCloudProject)
    }
    return this.state
  }

  logout(): CloudSessionState {
    this.connections.closeAll()
    this.client?.close()
    this.client = null
    this.savedLogin.clear()
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
    let projects: CloudProject[]
    try {
      projects = await this.client.listProjects()
    } catch (error) {
      const code = this.expiredCode(error) ?? errorCodeOf(error) ?? 'LIST_PROJECTS_FAILED'
      throw Object.assign(error instanceof Error ? error : new Error(code), { code })
    }
    const summaries = projects.map(summarizeCloudProject)
    if (this.state.status === 'signed-in') {
      this.state = { ...this.state, projects: summaries }
    }
    return summaries
  }

  /** Self-service creation; the refreshed list is what the renderer re-reads later. */
  async createProject(input: CloudCreateProjectInput): Promise<CreateProjectOutcome> {
    if (!this.client) {
      return { ok: false, code: 'NOT_SIGNED_IN' }
    }
    return createSessionProject(this.client, this.projectAdminHooks(), input)
  }

  /** Archive, retire this project's socket, then refresh the visible list. */
  async archiveProject(
    projectId: string
  ): Promise<{ ok: true } | { ok: false; code: string; message?: string }> {
    if (!this.client) {
      return { ok: false, code: 'NOT_SIGNED_IN' }
    }
    return archiveSessionProject(this.client, this.projectAdminHooks(), projectId)
  }

  private projectAdminHooks(): ProjectAdminHooks {
    return {
      expiredCode: (error) => this.expiredCode(error),
      publishProjects: (projects) => {
        if (this.state.status === 'signed-in') {
          this.state = { ...this.state, projects }
        }
      },
      closeProjectSocket: (projectId) => {
        this.connections.close(projectId)
      }
    }
  }

  async listProvisionableHosts(): Promise<CloudProvisionableHost[]> {
    if (!this.client) {
      return []
    }
    try {
      return await this.client.listProvisionableHosts()
    } catch (error) {
      this.expiredCode(error)
      throw error
    }
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
      const code = this.expiredCode(error) ?? errorCodeOf(error) ?? 'OPEN_FAILED'
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
      if (result.code === 'SESSION_EXPIRED') {
        this.expireSession()
      }
      return result
    }
    this.connections.track(projectId, client, result.route)
    return result
  }

  /**
   * Prepares the project's checkout without disturbing a live socket: reuse the
   * one this session already tracks, otherwise open a throwaway ticket. Idempotent.
   */
  async ensureProjectPrepared(projectId: string): Promise<ProvisionCloudProjectResult> {
    const identity = this.client?.deviceIdentity()
    if (!identity) {
      return { ok: false, code: 'NOT_SIGNED_IN' }
    }
    const existing = this.connections.get(projectId)
    if (existing) {
      return provisionCloudProjectOverRpc((method, params, timeoutMs) =>
        existing.client.rpc(method, params, timeoutMs)
      )
    }
    const client = this.createClient(this.options, identity)
    try {
      await client.openProject(projectId)
      return await provisionCloudProjectOverRpc((method, params, timeoutMs) =>
        client.rpc(method, params, timeoutMs)
      )
    } catch (error) {
      return {
        ok: false,
        code: this.expiredCode(error) ?? errorCodeOf(error) ?? 'OPEN_FAILED',
        message: error instanceof Error ? error.message : String(error)
      }
    } finally {
      client.close()
    }
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
      const code = this.expiredCode(error) ?? errorCodeOf(error) ?? 'OPEN_FAILED'
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
