import WebSocket from 'ws'
import { decrypt, deriveSharedKey, encrypt, generateKeyPair } from '../../shared/e2ee-crypto'
import type {
  CloudReplyEndpoint,
  CloudReplyProject,
  CloudReplyTicket
} from '../../shared/cloud-platform-reply'
import { chooseRoute, probeEndpoint, type RouteChoice } from './cloud-route-selection'
import { parseConnectTicket, parseProjectList, readTicketClaims } from './cloud-connect-response'
import {
  CloudRpcMultiplexer,
  type CloudStreamEvent,
  type CloudSubscription
} from './cloud-rpc-multiplexer'
import { parseJsonText, readField, readString, readStringArray } from '../../shared/json-fields'

/** Desktop-side cloud connection: the platform is a registry, never the data path (D1). */

export type CloudProject = CloudReplyProject
export type CloudEndpoint = CloudReplyEndpoint
export type CloudConnectTicket = CloudReplyTicket

export type CloudRpcResult =
  | { ok: true; result: unknown }
  | { ok: false; code: string; message?: string }

export type CloudConnectOptions = {
  apiUrl: string
  /** Direct probe timeout per address. */
  probeTimeoutMs?: number
  /** How many direct addresses to try before falling back. */
  maxDirectAddrs?: number
  /** Test-only: accept the host's self-signed certificate. */
  tlsRejectUnauthorized?: boolean
  fetchImpl?: typeof fetch
}

const DEFAULT_PROBE_TIMEOUT_MS = 800
const DEFAULT_MAX_DIRECT = 2
export { chooseRoute, probeEndpoint } from './cloud-route-selection'
export type { RouteChoice } from './cloud-route-selection'

export class CloudConnectClient {
  private readonly options: CloudConnectOptions
  private readonly fetchImpl: typeof fetch
  private accessToken = ''
  private deviceId = ''
  private readonly deviceKeys = generateKeyPair()
  private socket: WebSocket | null = null
  private sharedKey: Uint8Array | null = null
  private rpcMux: CloudRpcMultiplexer | null = null
  private closeListener: ((code: number, reason: string) => void) | null = null

  constructor(options: CloudConnectOptions) {
    this.options = options
    this.fetchImpl = options.fetchImpl ?? fetch
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
  deviceKeyPair(): { publicKey: Uint8Array; secretKey: Uint8Array } {
    return this.deviceKeys
  }

  async login(
    username: string,
    password: string
  ): Promise<{ displayName: string; permissions: string[] }> {
    const res = await this.fetchImpl(`${this.options.apiUrl}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username,
        password,
        devicePubKey: this.devicePubKeyB64,
        deviceName: 'orca-desktop'
      })
    })
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
    this.accessToken = accessToken
    this.deviceId = deviceId
    return { displayName, permissions }
  }

  async listProjects(): Promise<CloudProject[]> {
    const res = await this.fetchImpl(`${this.options.apiUrl}/v1/projects`, {
      headers: { authorization: `Bearer ${this.accessToken}` }
    })
    if (!res.ok) {
      throw new Error(`list projects failed: ${res.status}`)
    }
    const projects = parseProjectList(await res.json())
    if (projects === null) {
      throw new Error('list projects response malformed')
    }
    return projects
  }

  async requestTicket(projectId: string): Promise<CloudConnectTicket> {
    const res = await this.fetchImpl(`${this.options.apiUrl}/v1/projects/${projectId}/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.accessToken}` },
      body: JSON.stringify({
        deviceId: this.deviceId,
        devicePubKey: this.devicePubKeyB64,
        clientVersion: '1.5.0'
      })
    })
    if (!res.ok) {
      const code = readString(readField(await res.json().catch(() => null), 'error'), 'code')
      throw Object.assign(new Error(code ?? `connect failed: ${res.status}`), { code })
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
    const probeTimeout = this.options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
    const choice = await chooseRoute(
      ticket.endpoints,
      (url) => probeEndpoint(url, probeTimeout),
      this.options.maxDirectAddrs ?? DEFAULT_MAX_DIRECT
    )
    if (!choice) {
      throw Object.assign(new Error('no reachable endpoint'), { code: 'ENDPOINT_UNREACHABLE' })
    }
    return { route: choice.route, ticket, endpoint: choice.endpoint }
  }

  /** Probe → one ticket → upgrade → E2EE. A failed upgrade needs a fresh ticket. */
  async openProject(
    projectId: string
  ): Promise<{ route: 'direct' | 'relay'; ticket: CloudConnectTicket }> {
    const prepared = await this.prepareProjectLink(projectId)
    await this.upgrade({ endpoint: prepared.endpoint, route: prepared.route }, prepared.ticket)
    return { route: prepared.route, ticket: prepared.ticket }
  }

  private upgrade(choice: RouteChoice, ticket: CloudConnectTicket): Promise<void> {
    const { endpoint } = choice
    const wsOptions: WebSocket.ClientOptions = {
      headers: { 'x-orca-device-pubkey': this.devicePubKeyB64 },
      rejectUnauthorized: this.options.tlsRejectUnauthorized ?? true
    }
    if (choice.route === 'relay' && endpoint.sni) {
      // ws forwards unknown options to tls.connect, where SNI is `servername`.
      Object.assign(wsOptions, { servername: endpoint.sni })
    }
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(
        endpoint.url,
        ['orca-runtime', `orca-cred.${ticket.credential}`],
        wsOptions
      )
      ws.once('unexpected-response', (_req, res) => {
        reject(
          Object.assign(new Error(`upgrade rejected: ${res.statusCode}`), {
            code: res.headers['x-orca-reject'] ?? 'UPGRADE_REJECTED',
            statusCode: res.statusCode
          })
        )
        ws.terminate()
      })
      ws.once('error', reject)
      ws.once('message', (readyRaw) => {
        const ready = parseJsonText(readyRaw.toString())
        if (readString(ready, 'type') !== 'e2ee_ready') {
          reject(new Error(`expected e2ee_ready, got ${JSON.stringify(ready)}`))
          ws.terminate()
          return
        }
        // The platform hands the host's E2EE key to the client with the ticket.
        const hostKey = Uint8Array.from(Buffer.from(ticket.host.e2eePublicKeyB64, 'base64'))
        if (hostKey.length !== 32) {
          // A host that has not reported its key yet cannot be talked to. Failing
          // here is honest; deriving with a short key throws inside ws's listener.
          reject(
            Object.assign(new Error('host E2EE key missing or malformed'), {
              code: 'HOST_KEY_INVALID'
            })
          )
          ws.terminate()
          return
        }
        this.sharedKey = deriveSharedKey(this.deviceKeys.secretKey, hostKey)
        ws.once('message', (authRaw) => {
          const auth = parseJsonText(decrypt(authRaw.toString(), this.sharedKey!) ?? '{}')
          if (readString(auth, 'type') !== 'e2ee_authenticated') {
            reject(new Error(`expected e2ee_authenticated, got ${JSON.stringify(auth)}`))
            ws.terminate()
            return
          }
          this.socket = ws
          this.rpcMux = new CloudRpcMultiplexer(ws, this.sharedKey!)
          resolve()
        })
        const claims = readTicketClaims(ticket.credential)
        ws.send(
          encrypt(
            JSON.stringify({ type: 'e2ee_auth', deviceToken: claims?.deviceToken }),
            this.sharedKey
          )
        )
      })
      ws.once('open', () => {
        ws.send(
          JSON.stringify({
            type: 'e2ee_hello',
            publicKeyB64: Buffer.from(this.deviceKeys.publicKey).toString('base64')
          })
        )
      })
      ws.once('close', (code, reason) => this.closeListener?.(code, reason.toString()))
    })
  }

  onClose(listener: (code: number, reason: string) => void): void {
    this.closeListener = listener
  }

  rpc(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 5000
  ): Promise<CloudRpcResult> {
    const mux = this.rpcMux
    if (!mux) {
      return Promise.resolve({ ok: false, code: 'NOT_CONNECTED' })
    }
    return mux.call(method, params, timeoutMs)
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
    return this.rpcMux?.subscribe(method, params, onEvent, timeoutMs) ?? null
  }

  /** Stops delivering a stream locally; the host is told separately. */
  forgetSubscription(requestId: string): void {
    this.rpcMux?.forget(requestId)
  }

  close(): void {
    this.rpcMux?.close()
    this.rpcMux = null
    this.socket?.close()
    this.socket = null
    this.sharedKey = null
  }
}
