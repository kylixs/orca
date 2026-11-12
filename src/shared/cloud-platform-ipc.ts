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
  rpc: 'cloud:rpc',
  connectionChanged: 'cloud:connectionChanged'
} as const

export type CloudProjectSummary = {
  id: string
  key: string
  name: string
  hostName: string | null
  hostStatus: string
  /** True when the managed project forbids exporting files (FR-7). */
  downloadRestricted: boolean
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
      capabilities: string[]
    }
  | { ok: false; code: string; message?: string }

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
