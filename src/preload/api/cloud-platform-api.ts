import type {
  CloudConnectionEvent,
  CloudOpenResult,
  CloudProjectLinkResult,
  CloudProjectSummary,
  CloudRpcOutcome,
  CloudSessionState
} from '../../shared/cloud-platform-ipc'

export type CloudPlatformApi = {
  login: (username: string, password: string) => Promise<CloudSessionState>
  logout: () => Promise<CloudSessionState>
  getState: () => Promise<CloudSessionState>
  listProjects: () => Promise<CloudProjectSummary[]>
  openProject: (projectId: string) => Promise<CloudOpenResult>
  /** Leave the workspace; the platform session survives. */
  closeProject: () => Promise<{ ok: boolean }>
  prepareProjectLink: (projectId: string) => Promise<CloudProjectLinkResult>
  rpc: (method: string, params?: Record<string, unknown>) => Promise<CloudRpcOutcome>
  onConnectionChanged: (listener: (event: CloudConnectionEvent) => void) => () => void
}
