import type {
  CloudConnectionEvent,
  CloudOpenResult,
  CloudProjectEnvironment,
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
  /** Open and register the project as a runtime environment panes can address. */
  openWorkspace: (projectId: string) => Promise<CloudOpenResult>
  /** Register one runtime environment per visible project (no checkout). */
  registerProjects: () => Promise<CloudProjectEnvironment[]>
  /** Leave the workspace; the platform session survives. */
  closeProject: () => Promise<{ ok: boolean }>
  rpc: (method: string, params?: Record<string, unknown>) => Promise<CloudRpcOutcome>
  onConnectionChanged: (listener: (event: CloudConnectionEvent) => void) => () => void
}
