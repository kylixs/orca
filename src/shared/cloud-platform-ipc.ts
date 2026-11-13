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
  /** What the login form prefills: the resolved address and the remembered username. */
  loginContext: 'cloud:loginContext',
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
  /** Args: `(hostId)`. Pins the host key the user just re-verified (AC-29). */
  trustHostKey: 'cloud:trustHostKey',
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

/**
 * What the login form prefills (M119/W10). The address follows the priority
 * runtime env > last successful login > build-injected default; the username is
 * the one the last successful login used. A managed build pins the address, so
 * the form shows it read-only.
 */
export type CloudLoginContext = {
  platformUrl: string | null
  username: string | null
  locked: boolean
}

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
      /** Pinned fingerprint of the host this project runs on; the UI shows it (AC-29). */
      hostFingerprint?: string
      /**
       * How the route was chosen: every endpoint probed, in order, with its
       * latency. Present on success as well as failure, so the workspace can show
       * the line and its delay instead of only learning it when things break.
       */
      connectDiagnostics?: CloudConnectDiagnostics
    }
  | {
      ok: false
      code: string
      message?: string
      /**
       * `ENDPOINT_UNREACHABLE` only: each address the client probed, in order,
       * with its outcome — the step-by-step diagnosis the failure panel shows.
       */
      connectDiagnostics?: CloudConnectDiagnostics
      /**
       * Set when `code` is `FINGERPRINT_MISMATCH`: what was pinned, what the
       * platform now hands out, and the host it belongs to. The user must
       * re-verify before the new key replaces the pin.
       */
      hostKey?: CloudHostKeyMismatch
    }

export type CloudEndpointProbe = {
  route: 'direct' | 'relay'
  /** `host:port`; never the signed route key or query. */
  endpoint: string
  ok: boolean
  elapsedMs: number
}

export type CloudConnectDiagnostics = { probes: CloudEndpointProbe[] }

export type CloudHostKeyMismatch = {
  hostId: string
  pinnedFingerprint: string
  seenFingerprint: string
}

export type CloudTrustHostKeyResult = { ok: true } | { ok: false; code: string }

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
  /** Directory name under the host's projects root; the platform joins and contains it. */
  dir: string
  /** Omitted lets the platform derive a key from the name. */
  key?: string
  /** Empty means the host's directory is used as is — no clone task is issued. */
  repoUrl?: string
  defaultBranch?: string
  /** Omitted lets the platform use the only eligible online host. */
  hostId?: string
}

export type CloudProvisionableHost = {
  id: string
  name: string
  online: boolean
  provisionable: boolean
  /** First-level directories the host reports under its projects root. */
  projectDirs: string[]
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
  | { ok: false; code: string; message?: string; data?: unknown }

/** Pushed when the host closes the socket (revocation, maintenance, network). */
export type CloudConnectionEvent = {
  projectId: string | null
  route: 'direct' | 'relay' | null
  closeCode: number | null
  reason: string | null
}
