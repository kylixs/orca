/**
 * Renderer ↔ main contract for the cloud platform.
 *
 * The renderer never talks to the platform directly: the main process owns the
 * session tokens, device keys, and the WSS/E2EE socket, so credentials never
 * enter a renderer process (design §10).
 */

export const CLOUD_PLATFORM_IPC = {
  login: 'cloud:login',
  logout: 'cloud:logout',
  state: 'cloud:state',
  listProjects: 'cloud:listProjects',
  openProject: 'cloud:openProject',
  /** Args: `(projectId)`. Closes only that project's socket. */
  closeProject: 'cloud:closeProject',
  openWorkspace: 'cloud:openWorkspace',
  /** Registers one runtime environment per visible project (no checkout). */
  registerProjects: 'cloud:registerProjects',
  /** Args: `(projectId)`. Re-prepares a project whose first registration failed. */
  retryPrepare: 'cloud:retryPrepare',
  /** Args: `(input)`. Developer self-service creation; path is platform-derived. */
  createProject: 'cloud:createProject',
  /** Args: `(projectId)`. Archives the project and retires its local environment. */
  archiveProject: 'cloud:archiveProject',
  /** Lists hosts a developer may create a project on, without addresses or keys. */
  listProvisionableHosts: 'cloud:listProvisionableHosts',
  /** Args: `(method, params, projectId)`. Routes to that project's own socket. */
  rpc: 'cloud:rpc',
  connectionChanged: 'cloud:connectionChanged'
} as const

/**
 * The project permissions the platform signed into the ticket. The host enforces
 * them; the renderer reads them only to hide what it cannot do, never to allow.
 */
export type CloudProjectPermission =
  | 'open'
  | 'terminal'
  | 'agent'
  | 'file:read'
  | 'file:write'
  | 'browser'
  | 'download'

export type CloudProjectSummary = {
  id: string
  key: string
  name: string
  hostName: string | null
  hostStatus: string
  /** True when the managed project forbids exporting files (FR-7). */
  downloadRestricted: boolean
  /** Platform provisioning state; null when the platform predates it. */
  status: string | null
  /** Last host-reported provisioning failure; null when there is none. */
  provisioningError: string | null
}

export type CloudSessionState =
  | { status: 'signed-out' }
  | { status: 'signed-in'; displayName: string; projects: CloudProjectSummary[] }

export type CloudOpenResult =
  | {
      ok: true
      projectId: string
      route: 'direct' | 'relay'
      workspaceRoot: string
      /**
       * The user's actual checkout after opening a workspace. `workspaceRoot` is
       * the per-user parent directory the platform signs; a worktree is created
       * inside it, and panes must address that path (design §8.3).
       */
      workspacePath?: string
      capabilities: string[]
      /** Project permissions from the ticket; absent when the reply predates them. */
      permissions?: CloudProjectPermission[]
      /**
       * The runtime environment panes address for this project. Present when the
       * project was opened for a workspace (`cloud:openWorkspace`).
       */
      environmentId?: string
    }
  | { ok: false; code: string; message?: string }

/**
 * One cloud project as a native runtime host. The renderer turns this into a
 * sidebar repo row owned by `runtime:<environmentId>`.
 */
export type CloudProjectEnvironment = {
  projectId: string
  projectName: string
  /** The repo root the host signs into the ticket; this is the row's `path`. */
  projectRoot: string
  environmentId: string
}

/** One project the client could not prepare; the UI shows it and offers a retry. */
export type CloudProjectFailure = {
  projectId: string
  projectKey: string
  projectName: string
  code: string
  message?: string
}

export type CloudProjectRegistration = {
  environments: CloudProjectEnvironment[]
  failures: CloudProjectFailure[]
  /** Environments dropped because the platform no longer lists their project. */
  removedEnvironmentIds: string[]
}

export type CloudArchiveProjectResult =
  | {
      ok: true
      /** The retired environment, or null when the project had none registered. */
      environmentId: string | null
    }
  | { ok: false; code: string; message?: string }

export type CloudRetryPrepareResult =
  | { ok: true; environment: CloudProjectEnvironment }
  | { ok: false; code: string; message?: string }

export type CloudCreateProjectInput = {
  name: string
  /** Omitted lets the platform derive a key from the name. */
  key?: string
  repoUrl: string
  defaultBranch?: string
  /** Omitted lets the platform use the only eligible online host. */
  hostId?: string
}

export type CloudProvisionableHost = {
  id: string
  name: string
  online: boolean
  provisionable: boolean
}

export type CloudCreateProjectResult =
  | { ok: true; projectId: string; environment: CloudProjectEnvironment }
  | {
      ok: false
      code: string
      message?: string
      /** Present only when the platform created the project but preparing it failed. */
      projectId?: string
      project?: CloudProjectSummary
    }

export type CloudRpcOutcome =
  | { ok: true; result: unknown }
  | { ok: false; code: string; message?: string }

/** Pushed when the host closes the socket (revocation, maintenance, network). */
export type CloudConnectionEvent = {
  projectId: string | null
  route: 'direct' | 'relay' | null
  closeCode: number | null
  reason: string | null
}
