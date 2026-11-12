import { BrowserWindow, ipcMain, type WebContents } from 'electron'
import {
  CLOUD_PLATFORM_IPC,
  type CloudOpenResult,
  type CloudRpcOutcome,
  type CloudSessionState
} from '../../shared/cloud-platform-ipc'
import { CloudSessionService } from '../cloud-platform/cloud-session-service'
import {
  registerCloudRuntimeEnvironment,
  removeCloudRuntimeEnvironment
} from '../cloud-platform/cloud-runtime-environment'
import { setActiveCloudSession } from '../cloud-platform/cloud-runtime-session'
import { getCanonicalUserDataPath } from '../persistence/loading-store/user-data-path'

export type CloudPlatformHandlers = { dispose: () => void }

/**
 * Exposes the main-process cloud session to renderers. Nothing here returns a
 * token, a device key, or a socket handle — only the state the UI needs.
 */
export function registerCloudPlatformHandlers(
  session: CloudSessionService,
  options: {
    broadcast: (channel: string, payload: unknown) => void
    /** Where the registered cloud environments live; omitted in tests that do not open workspaces. */
    userDataPath?: string
  }
): CloudPlatformHandlers {
  const handle = <T>(channel: string, fn: (...args: never[]) => Promise<T> | T): void => {
    ipcMain.handle(channel, async (_event, ...args: unknown[]) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the preload bridge is the only caller and its signatures are this channel's contract; Electron hands args over untyped.
      fn(...(args as never[]))
    )
  }

  handle<CloudSessionState>(CLOUD_PLATFORM_IPC.state, () => session.getState())
  handle<CloudSessionState>(CLOUD_PLATFORM_IPC.login, async (username: string, password: string) =>
    session.login(username, password)
  )
  handle<CloudSessionState>(CLOUD_PLATFORM_IPC.logout, () => session.logout())
  handle(CLOUD_PLATFORM_IPC.listProjects, () => session.listProjects())
  handle<CloudOpenResult>(CLOUD_PLATFORM_IPC.openProject, (projectId: string) =>
    session.openProject(projectId)
  )
  handle<CloudOpenResult>(CLOUD_PLATFORM_IPC.openWorkspace, async (projectId: string) => {
    // Why ensure rather than open: a first-time user has no checkout yet, and
    // design §8.3 says opening the project creates it (managed worktree).
    const ensured = await session.ensureWorkspace(projectId)
    if (!ensured.ok || !options.userDataPath) {
      return ensured.ok
        ? { ok: false, code: 'WORKSPACE_UNAVAILABLE' }
        : { ok: false, code: ensured.code, message: ensured.message }
    }
    const prepared = await session.prepareProjectLink(projectId)
    if (!prepared.ok) {
      return { ok: false, code: prepared.code, message: prepared.message }
    }
    const project = session.getState()
    const summary =
      project.status === 'signed-in' ? project.projects.find((p) => p.id === projectId) : undefined
    const environment = registerCloudRuntimeEnvironment(options.userDataPath, {
      projectId,
      projectKey: summary?.key ?? projectId,
      projectName: summary?.name ?? projectId,
      hostId: summary?.hostName ?? '',
      link: prepared.link
    })
    return {
      ok: true,
      projectId,
      route: prepared.link.route,
      workspaceRoot: prepared.link.workspaceRoot,
      workspacePath: ensured.workspacePath,
      capabilities: ensured.capabilities,
      environmentId: environment.id
    }
  })
  handle(CLOUD_PLATFORM_IPC.closeProject, () => {
    const openProjectId = session.connectedProjectId
    if (openProjectId && options.userDataPath) {
      removeCloudRuntimeEnvironment(options.userDataPath, openProjectId)
    }
    return session.closeProject()
  })
  handle<CloudRpcOutcome>(
    CLOUD_PLATFORM_IPC.rpc,
    (method: string, params?: Record<string, unknown>) => session.rpc(method, params ?? {})
  )

  const unsubscribe = session.onConnectionChanged((event) => {
    options.broadcast(CLOUD_PLATFORM_IPC.connectionChanged, event)
  })

  return {
    dispose: () => {
      unsubscribe()
      for (const channel of Object.values(CLOUD_PLATFORM_IPC)) {
        ipcMain.removeHandler(channel)
      }
    }
  }
}

/**
 * Registers the IPC surface when the app runs in cloud mode. Returns null in
 * ordinary desktop mode, which has no platform to talk to.
 */
export function installCloudPlatformIpc(
  env: NodeJS.ProcessEnv = process.env
): CloudPlatformHandlers | null {
  const apiUrl = env.ORCA_CLOUD_API_URL
  if (!apiUrl) {
    return null
  }
  const session = new CloudSessionService({
    apiUrl,
    // Production hosts present a certificate the platform's CA signed; test
    // harnesses opt out of verification explicitly.
    tlsRejectUnauthorized: env.ORCA_CLOUD_TLS_INSECURE !== '1'
  })
  setActiveCloudSession(session)
  const handlers = registerCloudPlatformHandlers(session, {
    userDataPath: getCanonicalUserDataPath(),
    broadcast: (channel, payload) =>
      broadcastToWebContents(
        BrowserWindow.getAllWindows().map((win) => win.webContents),
        channel,
        payload
      )
  })
  return {
    dispose: () => {
      handlers.dispose()
      setActiveCloudSession(null)
    }
  }
}

/** Sends to every live renderer; a destroyed window must not throw during a push. */
export function broadcastToWebContents(
  contents: WebContents[],
  channel: string,
  payload: unknown
): void {
  for (const target of contents) {
    if (!target.isDestroyed()) {
      target.send(channel, payload)
    }
  }
}
