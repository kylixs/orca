import { openCloudWorkspaceOverRpc } from '../../../shared/cloud-workspace-open'
import type {
  CloudConnectionEvent,
  CloudOpenResult,
  CloudProjectSummary,
  CloudRpcOutcome,
  CloudSessionState
} from '../../../shared/cloud-platform-ipc'
import {
  loadOrCreateWebCloudDeviceKey,
  type WebCloudDeviceIdentity,
  type WebCloudDeviceKeyStorage
} from '../web/web-cloud-device-key'
import { WebRuntimeClient } from '../web/web-runtime-client'
import type { WebPairingOffer } from '../web/web-pairing'
import {
  failure,
  isSessionExpired,
  outcomeOf,
  summarize,
  type BrowserCloudClient
} from './cloud-browser-bridge-replies'
import {
  listCloudProjects,
  loginToCloud,
  type WebCloudProject,
  type WebCloudSession
} from '../web/web-cloud-session'
import {
  createBrowserWebCloudSessionStorage,
  type WebCloudSessionStorage
} from '../web/web-cloud-session-storage'
import {
  clearBrowserSession,
  persistBrowserSession,
  restoreBrowserSession,
  type BrowserSavedSession
} from './cloud-browser-saved-session'
import { browserUnsupportedAdminMethods } from './cloud-browser-bridge-unsupported'
import { BrowserProjectConnections } from './cloud-browser-project-connections'
import type { CloudBridge } from './use-cloud-session'

/**
 * The admin session page's `CloudBridge`: the same interface the Electron preload
 * exposed, backed only by browser-safe modules. One platform login owns one live
 * client per opened project; every call names its project, so two projects never
 * share a socket. Tokens stay in memory; the injected device-key store is the
 * only thing persisted, and the secret half never enters an offer or bridge state.
 */

export type { BrowserCloudClient } from './cloud-browser-bridge-replies'

export type CloudBrowserBridgeOptions = {
  apiUrl: string
  deviceName: string
  deviceKeyStore: WebCloudDeviceKeyStorage
  /** Saved-login seam; defaults to localStorage in a browser and to nothing in node. */
  sessionStorage?: WebCloudSessionStorage
  fetchImpl?: typeof fetch
  now?: () => number
  endpointUrl?: string
  /** Test seam: the unit test scripts the socket instead of spawning a host. */
  clientFactory?: (offer: WebPairingOffer, deviceSecretKeyB64: string) => BrowserCloudClient
}

const RPC_TIMEOUT_MS = 5_000
const CONNECTION_POLL_MS = 2_000

export function createCloudBrowserBridge(options: CloudBrowserBridgeOptions): CloudBridge {
  const fetchOptions = options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}
  const createClient =
    options.clientFactory ??
    ((offer: WebPairingOffer, deviceSecretKeyB64: string) =>
      new WebRuntimeClient(offer, { deviceSecretKeyB64 }))
  const listeners = new Set<(event: CloudConnectionEvent) => void>()
  let session: WebCloudSession | null = null
  let identity: WebCloudDeviceIdentity | null = null
  let state: CloudSessionState = { status: 'signed-out' }
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let restorePromise: Promise<CloudSessionState> | null = null
  // Why once: concurrent platform calls can all fail after the first one signed out.
  let sessionEnded = false
  const savedSession: BrowserSavedSession = {
    store: options.sessionStorage ?? createBrowserWebCloudSessionStorage(),
    apiUrl: options.apiUrl,
    deviceKeyStore: options.deviceKeyStore,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.now ? { now: options.now } : {}),
    getSession: () => session,
    setSession: (next) => {
      session = next
    },
    setIdentity: (next) => {
      identity = next
    },
    setState: (next) => {
      state = next
    }
  }

  const projectConnections = new BrowserProjectConnections({
    getSession: () => session,
    getIdentity: () => identity,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.endpointUrl ? { endpointUrl: options.endpointUrl } : {}),
    createClient,
    onPlatformError: (error) => notePlatformError(error),
    onDropped: (event) => emit(event)
  })

  function emit(event: CloudConnectionEvent): void {
    for (const listener of listeners) {
      listener(event)
    }
  }

  /** A dead refresh token ends the login: sockets close and the UI returns to sign-in. */
  function endSession(): void {
    if (sessionEnded) {
      return
    }
    sessionEnded = true
    projectConnections.closeAll()
    session = null
    identity = null
    state = { status: 'signed-out' }
    clearBrowserSession(savedSession)
    emit({ projectId: null, route: null, closeCode: 4401, reason: 'session_expired' })
  }

  function notePlatformError(error: unknown): void {
    if (isSessionExpired(error)) {
      endSession()
    }
  }

  /** Lazy on the first state read, so a fresh login page never waits on restoration. */
  async function restorePersistedSession(): Promise<CloudSessionState> {
    await restoreBrowserSession(savedSession)
    return state
  }

  return {
    async login(username: string, password: string): Promise<CloudSessionState> {
      projectConnections.closeAll()
      session = null
      identity = null
      sessionEnded = false
      state = { status: 'signed-out' }
      // Why: an explicit sign-in supersedes whatever login was saved before it.
      clearBrowserSession(savedSession)
      const loaded = loadOrCreateWebCloudDeviceKey(options.deviceKeyStore)
      const nextSession = await loginToCloud({
        apiUrl: options.apiUrl,
        username,
        password,
        devicePublicKeyB64: loaded.publicKeyB64,
        deviceName: options.deviceName,
        onTokensChanged: (tokens) => persistBrowserSession(savedSession, tokens),
        ...fetchOptions,
        ...(options.now ? { now: options.now } : {})
      })
      let projects: WebCloudProject[]
      try {
        projects = await listCloudProjects(nextSession, fetchOptions)
      } catch (error) {
        notePlatformError(error)
        throw error
      }
      session = nextSession
      identity = loaded
      state = {
        status: 'signed-in',
        displayName: nextSession.user.displayName,
        projects: projects.map(summarize)
      }
      const auth = nextSession.auth
      if (auth?.refreshToken) {
        persistBrowserSession(savedSession, {
          accessToken: auth.accessToken,
          refreshToken: auth.refreshToken
        })
      }
      return state
    },

    async getState(): Promise<CloudSessionState> {
      if (session === null) {
        restorePromise ??= restorePersistedSession()
        await restorePromise
      }
      return state
    },

    async listProjects(): Promise<CloudProjectSummary[]> {
      if (!session) {
        throw Object.assign(new Error('not signed in'), { code: 'NOT_SIGNED_IN' })
      }
      let listed: WebCloudProject[]
      try {
        listed = await listCloudProjects(session, fetchOptions)
      } catch (error) {
        notePlatformError(error)
        throw error
      }
      const projects = listed.map(summarize)
      if (state.status === 'signed-in') {
        state = { ...state, projects }
      }
      return projects
    },

    async openProject(projectId: string): Promise<CloudOpenResult> {
      const opened = await projectConnections.open(projectId)
      if ('ok' in opened) {
        return opened
      }
      return {
        ok: true,
        projectId,
        route: opened.route,
        workspaceRoot: opened.workspace.workspaceRoot,
        capabilities: opened.capabilities,
        ...(opened.permissions ? { permissions: opened.permissions } : {})
      }
    },

    async openWorkspace(projectId: string): Promise<CloudOpenResult> {
      const opened = await projectConnections.open(projectId)
      if ('ok' in opened) {
        return opened
      }
      const ensured = await openCloudWorkspaceOverRpc(
        async (method, params, timeoutMs) =>
          outcomeOf(await opened.client.call(method, params, { timeoutMs })),
        projectId,
        opened.workspace
      )
      if (!ensured.ok) {
        return ensured
      }
      return {
        ok: true,
        projectId,
        route: opened.route,
        workspaceRoot: opened.workspace.workspaceRoot,
        workspacePath: ensured.workspacePath,
        capabilities: opened.capabilities,
        ...(opened.permissions ? { permissions: opened.permissions } : {})
      }
    },

    ...browserUnsupportedAdminMethods,

    async closeProject(projectId: string): Promise<{ ok: boolean }> {
      projectConnections.close(projectId)
      return { ok: true }
    },

    async logout(): Promise<CloudSessionState> {
      projectConnections.closeAll()
      session = null
      identity = null
      sessionEnded = false
      clearBrowserSession(savedSession)
      state = { status: 'signed-out' }
      return state
    },

    async rpc(
      method: string,
      params: Record<string, unknown>,
      projectId: string
    ): Promise<CloudRpcOutcome> {
      if (!session) {
        return { ok: false, code: 'NOT_SIGNED_IN' }
      }
      const entry = projectConnections.get(projectId)
      if (!entry) {
        return { ok: false, code: 'NOT_CONNECTED' }
      }
      try {
        return outcomeOf(await entry.client.call(method, params, { timeoutMs: RPC_TIMEOUT_MS }))
      } catch (error) {
        return failure(error, 'RPC_FAILED')
      }
    },

    onConnectionChanged(listener: (event: CloudConnectionEvent) => void): () => void {
      listeners.add(listener)
      pollTimer ??= setInterval(() => projectConnections.sweep(), CONNECTION_POLL_MS)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && pollTimer !== null) {
          clearInterval(pollTimer)
          pollTimer = null
        }
      }
    }
  }
}
