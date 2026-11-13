import { generateKeyPair } from '../../shared/e2ee-crypto'
import { readField, readNumber, readString, readStringArray } from '../../shared/json-fields'
import type {
  CloudReplyEndpoint,
  CloudReplyHostOption,
  CloudReplyProject,
  CloudReplyTicket
} from '../../shared/cloud-platform-reply'
import type { CloudCreateProjectInput } from '../../shared/cloud-platform-ipc'
import {
  createCloudProject,
  listProvisionableHosts as fetchProvisionableHosts
} from './cloud-self-service-api'
import { chooseRoute, probeEndpoint } from './cloud-route-selection'
import { parseConnectTicket, parseProjectList } from './cloud-connect-response'
import type { CloudStreamEvent, CloudSubscription } from './cloud-rpc-multiplexer'
import {
  createCloudAuthSession,
  type CloudAuthFingerprints,
  type CloudAuthSession,
  type CloudAuthTokens
} from './cloud-auth-session'
import { cloudAuthorizedFetch, throwCloudPlatformError } from './cloud-authorized-request'
import { platformRequest } from './cloud-platform-unavailable'
import { createHostKeyGuard, type HostKeyGuard } from './cloud-host-key-guard'
import { upgradeCloudSocket, type CloudSocket } from './cloud-socket-handshake'

/** Desktop-side cloud connection: the platform is a registry, never the data path (D1). */

export type CloudProject = CloudReplyProject
export type CloudEndpoint = CloudReplyEndpoint
export type CloudConnectTicket = CloudReplyTicket

export type CloudRpcResult =
  | { ok: true; result: unknown }
  | {
      ok: false
      code: string
      message?: string
      /** Machine-readable denial details. */ data?: unknown
    }

export type CloudDeviceKeyPair = {
  publicKey: Uint8Array
  secretKey: Uint8Array
}

/**
 * The platform identity a project connection must reuse. The device key pair is
 * registered once at login and the host checks the E2EE hello against the ticket
 * that names it, so a second login (new keys ⇒ new device) would break binding.
 * `auth` is shared so every fork sees the same refreshed tokens.
 */
export type CloudDeviceIdentity = {
  auth: CloudAuthSession
  deviceId: string
  keyPair: CloudDeviceKeyPair
  /**
   * Shared with every forked client: a fork that hits a changed host key must
   * move the same pin the session's own client reads (AC-29).
   */
  hostKeys?: HostKeyGuard
}

export type CloudConnectOptions = {
  apiUrl: string
  /** Direct probe timeout per address. */
  probeTimeoutMs?: number
  /** How many direct addresses to try before falling back. */
  maxDirectAddrs?: number
  /** Test-only: accept the host's self-signed certificate. */
  tlsRejectUnauthorized?: boolean
  /** Refresh this long before expiry; short-lived test tokens shrink it. */
  refreshLeadMs?: number
  fetchImpl?: typeof fetch
  /** Rotation hook: the service writes the newest refresh token to its session store. */
  onTokensChanged?: (tokens: CloudAuthTokens) => void
  /** Where host-key pins live; omitted keeps them in memory (tests, throwaway clients). */
  userDataPath?: string
}

const DEFAULT_PROBE_TIMEOUT_MS = 800
const DEFAULT_MAX_DIRECT = 2
export { chooseRoute, probeEndpoint } from './cloud-route-selection'
export type { EndpointProbe } from './cloud-endpoint-probe'
export type { RouteChoice } from './cloud-route-selection'

export class CloudConnectClient {
  private readonly options: CloudConnectOptions
  private readonly fetchImpl: typeof fetch
  private auth: CloudAuthSession
  private deviceId = ''
  private readonly deviceKeys: CloudDeviceKeyPair
  private connection: CloudSocket | null = null
  private closeListener: ((code: number, reason: string) => void) | null = null
  private readonly hostKeys: HostKeyGuard

  constructor(options: CloudConnectOptions, identity?: CloudDeviceIdentity) {
    this.options = options
    this.fetchImpl = options.fetchImpl ?? fetch
    this.deviceKeys = identity?.keyPair ?? generateKeyPair()
    this.hostKeys =
      identity?.hostKeys ??
      createHostKeyGuard({
        ...(options.userDataPath !== undefined ? { userDataPath: options.userDataPath } : {}),
        closeConnection: (code, reason) => {
          this.connection?.close(code, reason)
          this.connection = null
        }
      })
    this.auth = identity?.auth ?? this.blankAuth()
    if (identity) {
      this.deviceId = identity.deviceId
    }
  }

  private blankAuth(): CloudAuthSession {
    return createCloudAuthSession({
      apiUrl: this.options.apiUrl,
      accessToken: '',
      refreshToken: null,
      fetchImpl: this.fetchImpl,
      ...(this.options.refreshLeadMs !== undefined
        ? { refreshLeadMs: this.options.refreshLeadMs }
        : {}),
      ...(this.options.onTokensChanged ? { onTokensChanged: this.options.onTokensChanged } : {})
    })
  }

  get devicePubKeyB64(): string {
    return Buffer.from(this.deviceKeys.publicKey).toString('base64')
  }

  get currentDeviceId(): string {
    return this.deviceId
  }

  /**
   * The key pair the platform registered as this device. The cloud handshake must
   * use it: completing E2EE with this key is the proof of possession the host checks.
   */
  deviceKeyPair(): CloudDeviceKeyPair {
    return this.deviceKeys
  }

  /** Credentials a per-project connection forks; never exposed to a renderer. */
  deviceIdentity(): CloudDeviceIdentity {
    return {
      auth: this.auth,
      deviceId: this.deviceId,
      keyPair: this.deviceKeys,
      hostKeys: this.hostKeys
    }
  }

  /** Main-process only: non-reversible digests for rotation diagnostics. */
  authTokenFingerprints(): CloudAuthFingerprints {
    return this.auth.fingerprints()
  }

  /** Main-process only: the device key the host bound the live socket to. */
  get ticketDevicePubKey(): string | null {
    return this.connection?.ticketDevicePubKey ?? null
  }

  async login(
    username: string,
    password: string
  ): Promise<{ displayName: string; permissions: string[] }> {
    const res = await platformRequest(() =>
      this.fetchImpl(`${this.options.apiUrl}/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username,
          password,
          devicePubKey: this.devicePubKeyB64,
          deviceName: 'orca-desktop'
        })
      })
    )
    const body: unknown = await res.json()
    if (!res.ok) {
      const code = readString(readField(body, 'error'), 'code')
      throw Object.assign(new Error(code ?? 'login failed'), { code })
    }
    const accessToken = readString(body, 'accessToken')
    const deviceId = readString(readField(body, 'device'), 'id')
    const displayName = readString(readField(body, 'user'), 'displayName')
    const permissions = readStringArray(readField(body, 'user'), 'permissions')
    if (accessToken === null || deviceId === null || displayName === null || permissions === null) {
      throw new Error('login response malformed')
    }
    this.auth = createCloudAuthSession({
      apiUrl: this.options.apiUrl,
      accessToken,
      refreshToken: readString(body, 'refreshToken'),
      expiresIn: readNumber(body, 'expiresIn'),
      fetchImpl: this.fetchImpl,
      ...(this.options.refreshLeadMs !== undefined
        ? { refreshLeadMs: this.options.refreshLeadMs }
        : {}),
      ...(this.options.onTokensChanged ? { onTokensChanged: this.options.onTokensChanged } : {})
    })
    this.deviceId = deviceId
    return { displayName, permissions }
  }

  async listProjects(): Promise<CloudProject[]> {
    const res = await cloudAuthorizedFetch(
      this.fetchImpl,
      this.options.apiUrl,
      this.auth,
      '/v1/projects'
    )
    if (!res.ok) {
      return throwCloudPlatformError(res, `list projects failed: ${res.status}`)
    }
    const projects = parseProjectList(await res.json())
    if (projects === null) {
      throw new Error('list projects response malformed')
    }
    return projects
  }

  createProject(input: CloudCreateProjectInput): Promise<CloudProject> {
    return createCloudProject(this.fetchImpl, this.options.apiUrl, this.auth, input)
  }

  async archiveProject(projectId: string): Promise<void> {
    const res = await cloudAuthorizedFetch(
      this.fetchImpl,
      this.options.apiUrl,
      this.auth,
      `/v1/projects/${projectId}/archive`,
      { method: 'POST' }
    )
    if (!res.ok) {
      return throwCloudPlatformError(res, `archive project failed: ${res.status}`)
    }
  }

  listProvisionableHosts(): Promise<CloudReplyHostOption[]> {
    return fetchProvisionableHosts(this.fetchImpl, this.options.apiUrl, this.auth)
  }

  async requestTicket(projectId: string): Promise<CloudConnectTicket> {
    const res = await cloudAuthorizedFetch(
      this.fetchImpl,
      this.options.apiUrl,
      this.auth,
      `/v1/projects/${projectId}/connect`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          deviceId: this.deviceId,
          devicePubKey: this.devicePubKeyB64,
          clientVersion: '1.5.0'
        })
      }
    )
    if (!res.ok) {
      return throwCloudPlatformError(res, `connect failed: ${res.status}`)
    }
    const ticket = parseConnectTicket(await res.json())
    if (ticket === null) {
      throw new Error('connect response malformed')
    }
    return ticket
  }

  /**
   * Probe → ticket → route, WITHOUT opening a socket. The ticket is single-use, so
   * a caller that intends to connect itself (the renderer's Orca workspace) must
   * not have the main process consume it first.
   */
  async prepareProjectLink(
    projectId: string
  ): Promise<{ route: 'direct' | 'relay'; ticket: CloudConnectTicket; endpoint: CloudEndpoint }> {
    const ticket = await this.requestTicket(projectId)
    this.hostKeys.check(ticket)
    const probeTimeout = this.options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
    const selection = await chooseRoute(
      ticket.endpoints,
      (url) => probeEndpoint(url, probeTimeout),
      this.options.maxDirectAddrs ?? DEFAULT_MAX_DIRECT
    )
    const choice = selection.choice
    if (!choice) {
      // Why the probes ride along: the user must be able to see which address
      // failed and how long it waited, not just that nothing worked (AC-07).
      throw Object.assign(new Error('no reachable endpoint'), {
        code: 'ENDPOINT_UNREACHABLE',
        probes: selection.probes
      })
    }
    return { route: choice.route, ticket, endpoint: choice.endpoint }
  }

  /** The user re-verified a changed host key; the new key replaces the pinned one. */
  trustHostKey(hostId: string, e2eePublicKeyB64: string): void {
    this.hostKeys.trust(hostId, e2eePublicKeyB64)
  }

  /** Pins the key a `FINGERPRINT_MISMATCH` just exposed, without crossing IPC. */
  trustPendingHostKey(hostId: string): boolean {
    return this.hostKeys.trustPending(hostId)
  }

  /** What the confirmation dialog shows; null when this host was never seen. */
  pinnedHostFingerprint(hostId: string): string | null {
    return this.hostKeys.pinnedFingerprint(hostId)
  }

  /** Probe → one ticket → upgrade → E2EE. A failed upgrade needs a fresh ticket. */
  async openProject(
    projectId: string
  ): Promise<{ route: 'direct' | 'relay'; ticket: CloudConnectTicket }> {
    const prepared = await this.prepareProjectLink(projectId)
    this.connection?.close()
    this.connection = await upgradeCloudSocket({
      endpoint: prepared.endpoint,
      ticket: prepared.ticket,
      devicePubKeyB64: this.devicePubKeyB64,
      deviceKeys: this.deviceKeys,
      tlsRejectUnauthorized: this.options.tlsRejectUnauthorized ?? true,
      onClose: (code, reason) => this.closeListener?.(code, reason)
    })
    return { route: prepared.route, ticket: prepared.ticket }
  }

  onClose(listener: (code: number, reason: string) => void): void {
    this.closeListener = listener
  }

  rpc(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 5000
  ): Promise<CloudRpcResult> {
    const mux = this.connection?.mux
    return mux
      ? mux.call(method, params, timeoutMs)
      : Promise.resolve({ ok: false, code: 'NOT_CONNECTED' })
  }

  /**
   * Opens a streaming method (`terminal.subscribe`) and delivers each event. The
   * host ends the stream with `{type:'end'}`, which also settles `done`; a caller
   * that unsubscribes first should call `subscribe`'s `requestId` back to the host
   * so it can release the terminal.
   */
  subscribe(
    method: string,
    params: Record<string, unknown>,
    onEvent: (event: CloudStreamEvent) => void,
    timeoutMs = 10_000
  ): CloudSubscription | null {
    return this.connection?.mux.subscribe(method, params, onEvent, timeoutMs) ?? null
  }

  /** Stops delivering a stream locally; the host is told separately. */
  forgetSubscription(requestId: string): void {
    this.connection?.mux.forget(requestId)
  }

  close(): void {
    this.connection?.close()
    this.connection = null
  }
}

export type { CloudAuthSession } from './cloud-auth-session'
