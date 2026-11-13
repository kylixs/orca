import type {
  CloudArchiveProjectResult,
  CloudConnectionEvent,
  CloudCreateProjectInput,
  CloudCreateProjectResult,
  CloudOpenResult,
  CloudProjectRegistration,
  CloudProjectSummary,
  CloudProvisionableHost,
  CloudRetryPrepareResult,
  CloudRpcOutcome,
  CloudSessionState,
  CloudTrustHostKeyResult
} from '../../shared/cloud-platform-ipc'

export type CloudPlatformApi = {
  login: (username: string, password: string) => Promise<CloudSessionState>
  logout: () => Promise<CloudSessionState>
  getState: () => Promise<CloudSessionState>
  listProjects: () => Promise<CloudProjectSummary[]>
  openProject: (projectId: string) => Promise<CloudOpenResult>
  /** Open and register the project as a runtime environment panes can address. */
  openWorkspace: (projectId: string) => Promise<CloudOpenResult>
  /** Pin the host key the user just re-verified after a mismatch (AC-29). */
  trustHostKey: (hostId: string) => Promise<CloudTrustHostKeyResult>
  /** Register one runtime environment per visible project (no checkout). */
  registerProjects: () => Promise<CloudProjectRegistration>
  /** Re-run provisioning and linking for one project that failed to register. */
  retryPrepare: (projectId: string) => Promise<CloudRetryPrepareResult>
  /** Developer self-service creation; path is derived by the platform. */
  createProject: (input: CloudCreateProjectInput) => Promise<CloudCreateProjectResult>
  /** Archive a project the user created; retires its local runtime environment. */
  archiveProject: (projectId: string) => Promise<CloudArchiveProjectResult>
  /** Credential-free host catalog for the creation dialog. */
  listProvisionableHosts: () => Promise<CloudProvisionableHost[]>
  /** Leave one project's workspace; its socket closes, the platform session survives. */
  closeProject: (projectId: string) => Promise<{ ok: boolean }>
  /** Routes to `projectId`'s own connection; there is no implicit current project. */
  rpc: (
    method: string,
    params: Record<string, unknown>,
    projectId: string
  ) => Promise<CloudRpcOutcome>
  onConnectionChanged: (listener: (event: CloudConnectionEvent) => void) => () => void
}
