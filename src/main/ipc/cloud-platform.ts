import { BrowserWindow, app, ipcMain, type WebContents } from 'electron'
import {
  CLOUD_PLATFORM_IPC,
  type CloudArchiveProjectResult,
  type CloudCreateProjectInput,
  type CloudCreateProjectResult,
  type CloudLoginContext,
  type CloudOpenResult,
  type CloudProjectRegistration,
  type CloudProvisionableHost,
  type CloudRetryPrepareResult,
  type CloudRpcOutcome,
  type CloudSessionState,
  type CloudTrustHostKeyResult
} from '../../shared/cloud-platform-ipc'
import { readTicketClaims } from '../cloud-platform/cloud-connect-response'
import { CloudSessionService } from '../cloud-platform/cloud-session-service'
import { readCloudLoginMemory } from '../cloud-platform/cloud-login-memory'
import { isCloudPlatformBuild } from '../../shared/cloud-build-flags'
import {
  loginPlatformAddress,
  resolveCloudPlatformAddress
} from '../cloud-platform/cloud-platform-address'
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
    /** What the login form prefills (M119/W10); absent in older test harnesses. */
    loginContext?: CloudLoginContext
    /** Resolves the address a sign-in uses; rejects typed addresses on pinned builds. */
    loginAddress?: (
      typedUrl: string | undefined
    ) => { ok: true; apiUrl: string } | { ok: false; code: string }
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
  handle<CloudLoginContext | null>(
    CLOUD_PLATFORM_IPC.loginContext,
    () => options.loginContext ?? null
  )
  handle<CloudSessionState>(
    CLOUD_PLATFORM_IPC.login,
    async (username: string, password: string, platformUrl?: string) => {
      // Why the bypass: harnesses that register handlers without an address gate
      // keep the old two-argument behavior untouched.
      if (!options.loginAddress) {
        return session.login(username, password, platformUrl)
      }
      const address = options.loginAddress(platformUrl)
      if (!address.ok) {
        // Why the message is the code: Electron drops custom error properties at
        // the IPC boundary, and the renderer maps the surviving message to copy.
        throw Object.assign(new Error(address.code), { code: address.code })
      }
      return session.login(username, password, address.apiUrl)
    }
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
  // Why no key argument: the main process already holds the key the mismatch
  // exposed, so the renderer only says "the user verified this host".
  handle<CloudTrustHostKeyResult>(CLOUD_PLATFORM_IPC.trustHostKey, (hostId: string) =>
    session.trustHostKey(hostId)
  )
  handle<CloudOpenResult>(CLOUD_PLATFORM_IPC.openWorkspace, async (projectId: string) => {
    // Why ensure rather than open: a first-time user has no checkout yet, and
    // design §8.3 says opening the project creates it (managed worktree).
    const ensured = await session.ensureWorkspace(projectId)
    if (!ensured.ok || !options.userDataPath) {
      return ensured.ok
        ? { ok: false, code: 'WORKSPACE_UNAVAILABLE' }
        : {
            ok: false,
            code: ensured.code,
            message: ensured.message,
            ...(ensured.hostKey ? { hostKey: ensured.hostKey } : {})
          }
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
      // U44: provisioning means the host's kick clone is already running. Connect
      // would only hit the U20 gate, so report the real state instead of a failure.
      if (created.project.status === 'provisioning') {
        return {
          ok: true,
          preparing: true,
          projectId: created.projectId,
          project: created.project
        }
      }
      const prepared = await prepareProjectEnvironment(
        session,
        options.userDataPath,
        created.project
      )
      // Why carry the project: the platform row exists, so the renderer must be
      // able to retry preparation after an admin fixes the repo URL.
      if (prepared.ok && 'preparing' in prepared) {
        // U44: the host's kick clone is still running; this is not a failure.
        return {
          ok: true,
          preparing: true,
          projectId: created.projectId,
          project: created.project
        }
      }
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
 * Registers the IPC surface in every build (W11): the native shell keeps a
 * permanent sign-in button, so even a dev build with no environment variable can
 * log in by typing the platform address. Without any address the login IPC
 * answers `PLATFORM_ADDRESS_REQUIRED` instead of failing to register.
 *
 * A cloud build additionally restores the last saved session at startup; other
 * builds stay signed out and never touch the network on boot.
 */
export function installCloudPlatformIpc(
  env: NodeJS.ProcessEnv = process.env,
  deps: { userDataPath?: string; packaged?: boolean } = {}
): CloudPlatformHandlers {
  const userDataPath = deps.userDataPath ?? getCanonicalUserDataPath()
  const packaged = deps.packaged ?? isPackagedOrcaBuild()
  const memory = readCloudLoginMemory(userDataPath)
  const address = resolveCloudPlatformAddress({
    envApiUrl: env.ORCA_CLOUD_API_URL,
    memoryApiUrl: memory.lastPlatformUrl,
    packaged
  })
  const session = new CloudSessionService({
    // Why '' can happen: a cloud build with no resolvable address still installs,
    // and only a login that types one ever builds a client.
    apiUrl: address.apiUrl ?? '',
    // Production hosts present a certificate the platform's CA signed; test
    // harnesses opt out of verification explicitly.
    tlsRejectUnauthorized: env.ORCA_CLOUD_TLS_INSECURE !== '1',
    userDataPath
  })
  setActiveCloudSession(session)
  // Why background: startup must not wait on a platform round-trip; the state IPC awaits it.
  // Why the gate: a build without the platform entry must not sign itself in —
  // its user opts in through the shell's sign-in button instead.
  if (isCloudPlatformBuild(env)) {
    void session
      .restoreSession()
      .catch((error: unknown) => console.warn('[cloud] session restore did not complete', error))
  }
  const handlers = registerCloudPlatformHandlers(session, {
    userDataPath,
    loginContext: {
      platformUrl: address.apiUrl,
      username: memory.lastUsername,
      locked: address.locked
    },
    loginAddress: (typedUrl) => loginPlatformAddress(address, typedUrl, packaged),
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

function isPackagedOrcaBuild(): boolean {
  try {
    return app?.isPackaged === true
  } catch {
    return false
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
