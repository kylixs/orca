import { readTicketClaims } from '../../../shared/cloud-platform-reply'
import { openCloudWorkspaceOverRpc } from '../../../shared/cloud-workspace-open'
import type {
  CloudArchiveProjectResult,
  CloudConnectionEvent,
  CloudCreateProjectResult,
  CloudOpenResult,
  CloudProjectRegistration,
  CloudProjectSummary,
  CloudProvisionableHost,
  CloudRetryPrepareResult,
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
  routeOf,
  summarize,
  type BrowserCloudClient,
  type OpenConnection
} from './cloud-browser-bridge-replies'
import {
  cloudPairingOfferFromTicket,
  listCloudProjects,
  loginToCloud,
  requestCloudTicket,
  type WebCloudProject,
  type WebCloudSession
} from '../web/web-cloud-session'
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
  fetchImpl?: typeof fetch
  now?: () => number
  endpointUrl?: string
  /** Test seam: the unit test scripts the socket instead of spawning a host. */
  clientFactory?: (offer: WebPairingOffer, deviceSecretKeyB64: string) => BrowserCloudClient
}

const STATUS_TIMEOUT_MS = 15_000
const RPC_TIMEOUT_MS = 5_000
const CONNECTION_POLL_MS = 2_000

export function createCloudBrowserBridge(options: CloudBrowserBridgeOptions): CloudBridge {
  const fetchOptions = options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}
  const createClient =
    options.clientFactory ??
    ((offer: WebPairingOffer, deviceSecretKeyB64: string) =>
      new WebRuntimeClient(offer, { deviceSecretKeyB64 }))
  const connections = new Map<string, OpenConnection>()
  const listeners = new Set<(event: CloudConnectionEvent) => void>()
  let session: WebCloudSession | null = null
  let identity: WebCloudDeviceIdentity | null = null
  let state: CloudSessionState = { status: 'signed-out' }
  let pollTimer: ReturnType<typeof setInterval> | null = null
  // Why once: concurrent platform calls can all fail after the first one signed out.
  let sessionEnded = false

  function closeConnection(projectId: string): boolean {
    const entry = connections.get(projectId)
    if (!entry) {
      return false
    }
    connections.delete(projectId)
    entry.client.close()
    return true
  }

  function closeAll(): void {
    for (const projectId of Array.from(connections.keys())) {
      closeConnection(projectId)
    }
  }

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
    closeAll()
    session = null
    identity = null
    state = { status: 'signed-out' }
    emit({ projectId: null, route: null, closeCode: 4401, reason: 'session_expired' })
  }

  function notePlatformError(error: unknown): void {
    if (isSessionExpired(error)) {
      endSession()
    }
  }

  /** Polls only while someone listens; a dropped socket is the notice the UI shows. */
  function sweepConnections(): void {
    for (const [projectId, entry] of Array.from(connections)) {
      const next = entry.client.connectionState
      if (next !== 'disconnected' && next !== 'auth-failed') {
        continue
      }
      connections.delete(projectId)
      entry.client.close()
      emit({ projectId, route: entry.route, closeCode: null, reason: next })
    }
  }

  async function openConnection(projectId: string): Promise<OpenConnection | CloudOpenResult> {
    if (!session || !identity) {
      return { ok: false, code: 'NOT_SIGNED_IN' }
    }
    try {
      const ticket = await requestCloudTicket(
        session,
        projectId,
        identity.publicKeyB64,
        fetchOptions
      )
      const offer = cloudPairingOfferFromTicket(
        ticket,
        identity.publicKeyB64,
        options.endpointUrl ? { endpointUrl: options.endpointUrl } : {}
      )
      const client = createClient(offer, identity.secretKeyB64)
      const probe = await client.call('status.get', undefined, { timeoutMs: STATUS_TIMEOUT_MS })
      if (!probe.ok) {
        client.close()
        return { ok: false, code: probe.error.code, message: probe.error.message }
      }
      closeConnection(projectId)
      const entry: OpenConnection = {
        client,
        route: routeOf(offer, ticket),
        workspace: ticket.workspace,
        capabilities: ticket.host.capabilities,
        permissions: readTicketClaims(ticket.credential).permissions
      }
      connections.set(projectId, entry)
      return entry
    } catch (error) {
      notePlatformError(error)
      return failure(error, 'OPEN_FAILED')
    }
  }

  return {
    async login(username: string, password: string): Promise<CloudSessionState> {
      closeAll()
      session = null
      identity = null
      sessionEnded = false
      state = { status: 'signed-out' }
      const loaded = loadOrCreateWebCloudDeviceKey(options.deviceKeyStore)
      const nextSession = await loginToCloud({
        apiUrl: options.apiUrl,
        username,
        password,
        devicePublicKeyB64: loaded.publicKeyB64,
        deviceName: options.deviceName,
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
      return state
    },

    async getState(): Promise<CloudSessionState> {
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
      const opened = await openConnection(projectId)
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
      const opened = await openConnection(projectId)
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

    /** A browser has no runtime-environment registry; the admin page never uses it. */
    async registerProjects(): Promise<CloudProjectRegistration> {
      return { environments: [], failures: [], removedEnvironmentIds: [] }
    },

    /** Admin pages have no native environment to register a recovered project into. */
    async retryPrepare(): Promise<CloudRetryPrepareResult> {
      return { ok: false, code: 'ADMIN_SESSION_UNSUPPORTED' }
    },

    /** Admin pages have no runtime host, so creation cannot produce an environment. */
    async createProject(): Promise<CloudCreateProjectResult> {
      return { ok: false, code: 'ADMIN_SESSION_UNSUPPORTED' }
    },

    /** Admin pages have no native environment to retire. */
    async archiveProject(): Promise<CloudArchiveProjectResult> {
      return { ok: false, code: 'ADMIN_SESSION_UNSUPPORTED' }
    },

    async listProvisionableHosts(): Promise<CloudProvisionableHost[]> {
      return []
    },

    async closeProject(projectId: string): Promise<{ ok: boolean }> {
      closeConnection(projectId)
      return { ok: true }
    },

    async logout(): Promise<CloudSessionState> {
      closeAll()
      session = null
      identity = null
      sessionEnded = false
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
      const entry = connections.get(projectId)
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
      pollTimer ??= setInterval(sweepConnections, CONNECTION_POLL_MS)
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
