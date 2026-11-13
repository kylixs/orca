import { BrowserWindow, ipcMain, type WebContents } from 'electron'
import {
  CLOUD_PLATFORM_IPC,
  type CloudArchiveProjectResult,
  type CloudCreateProjectInput,
  type CloudCreateProjectResult,
  type CloudOpenResult,
  type CloudProjectRegistration,
  type CloudProvisionableHost,
  type CloudRetryPrepareResult,
  type CloudRpcOutcome,
  type CloudSessionState
} from '../../shared/cloud-platform-ipc'
import { readTicketClaims } from '../cloud-platform/cloud-connect-response'
import { CloudSessionService } from '../cloud-platform/cloud-session-service'
import {
  prepareProjectEnvironment,
  registerProjectEnvironments
} from '../cloud-platform/cloud-project-preparation'
import {
  cloudEnvironmentIdForProject,
  registerCloudRuntimeEnvironment,
  removeCloudRuntimeEnvironment,
  removeCloudRuntimeEnvironments
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
    /** Maximum projects whose clone/ticket work overlaps; environment writes stay serial. */
    prepareConcurrency?: number
  }
): CloudPlatformHandlers {
  const handle = <T>(channel: string, fn: (...args: never[]) => Promise<T> | T): void => {
    ipcMain.handle(channel, async (_event, ...args: unknown[]) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the preload bridge is the only caller and its signatures are this channel's contract; Electron hands args over untyped.
      fn(...(args as never[]))
    )
  }

  // Why await: the first renderer read must see the restored login, not signed-out.
  handle<CloudSessionState>(CLOUD_PLATFORM_IPC.state, () => session.whenRestored())
  handle<CloudSessionState>(CLOUD_PLATFORM_IPC.login, async (username: string, password: string) =>
    session.login(username, password)
  )
  handle<CloudSessionState>(CLOUD_PLATFORM_IPC.logout, () => {
    // Why: the native shell owns one environment per project, so signing out
    // must retire all of them, not just the project the user last opened.
    if (options.userDataPath) {
      removeCloudRuntimeEnvironments(options.userDataPath)
    }
    return session.logout()
  })
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
      link: prepared.link,
      workspacePath: ensured.workspacePath
    })
    return {
      ok: true,
      projectId,
      route: prepared.link.route,
      workspaceRoot: prepared.link.workspaceRoot,
      workspacePath: ensured.workspacePath,
      capabilities: ensured.capabilities,
      // Read from the ticket the host will verify, so the UI shows exactly the
      // permissions this connection carries rather than a stale platform list.
      permissions: readTicketClaims(prepared.link.cloudUpgrade.credential).permissions,
      environmentId: environment.id
    }
  })
  handle<CloudProjectRegistration>(CLOUD_PLATFORM_IPC.registerProjects, async () => {
    const state = session.getState()
    if (state.status !== 'signed-in' || !options.userDataPath) {
      return { environments: [], failures: [], removedEnvironmentIds: [] }
    }
    return registerProjectEnvironments(
      session,
      options.userDataPath,
      state.projects,
      options.prepareConcurrency
    )
  })
  handle<CloudRetryPrepareResult>(CLOUD_PLATFORM_IPC.retryPrepare, async (projectId: string) => {
    const state = session.getState()
    if (state.status !== 'signed-in') {
      return { ok: false, code: 'NOT_SIGNED_IN' }
    }
    if (!options.userDataPath) {
      return { ok: false, code: 'WORKSPACE_UNAVAILABLE' }
    }
    const project = state.projects.find((entry) => entry.id === projectId)
    if (!project) {
      return { ok: false, code: 'PROJECT_NOT_FOUND' }
    }
    return prepareProjectEnvironment(session, options.userDataPath, project)
  })
  handle<CloudCreateProjectResult>(
    CLOUD_PLATFORM_IPC.createProject,
    async (input: CloudCreateProjectInput) => {
      if (session.getState().status !== 'signed-in') {
        return { ok: false, code: 'NOT_SIGNED_IN' }
      }
      if (!options.userDataPath) {
        return { ok: false, code: 'WORKSPACE_UNAVAILABLE' }
      }
      const created = await session.createProject(input)
      if (!created.ok) {
        return created
      }
      const prepared = await prepareProjectEnvironment(
        session,
        options.userDataPath,
        created.project
      )
      // Why carry the project: the platform row exists, so the renderer must be
      // able to retry preparation after an admin fixes the repo URL.
      return prepared.ok
        ? { ok: true, projectId: created.projectId, environment: prepared.environment }
        : { ...prepared, projectId: created.projectId, project: created.project }
    }
  )
  handle<CloudArchiveProjectResult>(
    CLOUD_PLATFORM_IPC.archiveProject,
    async (projectId: string) => {
      const archived = await session.archiveProject(projectId)
      if (!archived.ok || !options.userDataPath) {
        return archived.ok ? { ok: true, environmentId: null } : archived
      }
      const environmentId = cloudEnvironmentIdForProject(options.userDataPath, projectId)
      removeCloudRuntimeEnvironment(options.userDataPath, projectId)
      return { ok: true, environmentId }
    }
  )
  handle<CloudProvisionableHost[]>(CLOUD_PLATFORM_IPC.listProvisionableHosts, async () => {
    try {
      return await session.listProvisionableHosts()
    } catch {
      // The dialog treats an empty list as "no eligible host".
      return []
    }
  })
  handle(CLOUD_PLATFORM_IPC.closeProject, (projectId: string) => {
    if (options.userDataPath) {
      removeCloudRuntimeEnvironment(options.userDataPath, projectId)
    }
    return session.closeProject(projectId)
  })
  handle<CloudRpcOutcome>(
    CLOUD_PLATFORM_IPC.rpc,
    (method: string, params: Record<string, unknown> | undefined, projectId: string) =>
      session.rpc(method, params ?? {}, projectId)
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
  const userDataPath = getCanonicalUserDataPath()
  const session = new CloudSessionService({
    apiUrl,
    // Production hosts present a certificate the platform's CA signed; test
    // harnesses opt out of verification explicitly.
    tlsRejectUnauthorized: env.ORCA_CLOUD_TLS_INSECURE !== '1',
    userDataPath
  })
  setActiveCloudSession(session)
  // Why background: startup must not wait on a platform round-trip; the state IPC awaits it.
  void session
    .restoreSession()
    .catch((error: unknown) => console.warn('[cloud] session restore did not complete', error))
  const handlers = registerCloudPlatformHandlers(session, {
    userDataPath,
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
