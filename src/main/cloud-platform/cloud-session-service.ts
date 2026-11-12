import type {
  CloudConnectionEvent,
  CloudOpenResult,
  CloudProjectSummary,
  CloudRpcOutcome,
  CloudSessionState
} from '../../shared/cloud-platform-ipc'
import { CloudConnectClient, type CloudProject } from './cloud-connect-client'

/**
 * Owns the desktop cloud session. The renderer gets a thin, credential-free view:
 * tokens, device keys, and the socket stay in the main process.
 */

export type CloudSessionOptions = {
  apiUrl: string
  tlsRejectUnauthorized?: boolean
  probeTimeoutMs?: number
}

export type CloudSessionDeps = {
  createClient?: (options: CloudSessionOptions) => CloudConnectClient
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
  private readonly createClient: (options: CloudSessionOptions) => CloudConnectClient
  private client: CloudConnectClient | null = null
  private state: CloudSessionState = { status: 'signed-out' }
  private currentProjectId: string | null = null
  private currentRoute: 'direct' | 'relay' | null = null
  private listeners = new Set<(event: CloudConnectionEvent) => void>()

  constructor(options: CloudSessionOptions, deps: CloudSessionDeps = {}) {
    this.options = options
    this.createClient = deps.createClient ?? ((settings) => new CloudConnectClient(settings))
  }

  onConnectionChanged(listener: (event: CloudConnectionEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState(): CloudSessionState {
    return this.state
  }

  async login(username: string, password: string): Promise<CloudSessionState> {
    this.client?.close()
    const client = this.createClient(this.options)
    const user = await client.login(username, password)
    const projects = await client.listProjects()
    client.onClose((code, reason) => {
      // A revoked session must not leave the UI looking connected.
      this.emit({
        closeCode: code,
        reason,
        projectId: this.currentProjectId,
        route: this.currentRoute
      })
      this.currentProjectId = null
      this.currentRoute = null
    })
    this.client = client
    this.state = {
      status: 'signed-in',
      displayName: user.displayName,
      projects: projects.map(summarize)
    }
    return this.state
  }

  logout(): CloudSessionState {
    this.client?.close()
    this.client = null
    this.currentProjectId = null
    this.currentRoute = null
    this.state = { status: 'signed-out' }
    return this.state
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
      const opened = await this.client.openProject(projectId)
      this.currentProjectId = projectId
      this.currentRoute = opened.route
      return {
        ok: true,
        projectId,
        route: opened.route,
        workspaceRoot: opened.ticket.workspace.workspaceRoot,
        capabilities: opened.ticket.host.capabilities
      }
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'OPEN_FAILED'
      return { ok: false, code, message: error instanceof Error ? error.message : String(error) }
    }
  }

  async rpc(method: string, params: Record<string, unknown> = {}): Promise<CloudRpcOutcome> {
    if (!this.client) {
      return { ok: false, code: 'NOT_SIGNED_IN' }
    }
    return this.client.rpc(method, params)
  }

  /** True until the host closes the socket; used to decide whether to reconnect. */
  get connectedProjectId(): string | null {
    return this.currentProjectId
  }

  private emit(event: CloudConnectionEvent): void {
    for (const listener of this.listeners) {
      listener(event)
    }
  }
}
