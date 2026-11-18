import { generateKeyPairSync, randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { selectRoute, type Endpoint, type SelectionResult } from './route-selector.ts'

export type ConnectResponse = {
  credential: string
  expiresIn: number
  host: {
    id: string
    name: string
    fingerprint: string
    tlsFingerprint: string
    e2eePublicKeyB64: string
    capabilities: string[]
  }
  endpoints: { direct: Endpoint[]; relay: Endpoint[] }
  workspace: {
    projectRoot: string
    workspaceRoot: string
    defaultBranch: string
    existingWorktreeId: string | null
  }
  clientVersionCheck: { min: string; ok: boolean }
}

export type RpcResult = { ok: true; result: unknown } | { ok: false; code: string; message?: string }

let rpcId = 0

export class CloudClient {
  private accessToken = ''
  private deviceId = ''
  private readonly deviceKey: string
  private socket: WebSocket | null = null

  private readonly apiUrl: string
  private readonly options: { tlsRejectUnauthorized?: boolean }

  constructor(apiUrl: string, options: { tlsRejectUnauthorized?: boolean } = {}) {
    this.apiUrl = apiUrl
    this.options = options
    const { publicKey } = generateKeyPairSync('x25519')
    this.deviceKey = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  }

  async login(
    username: string,
    password: string
  ): Promise<{ displayName: string; permissions: string[]; deviceId: string }> {
    const res = await fetch(`${this.apiUrl}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password, devicePubKey: this.deviceKey, deviceName: 'e2e-client' })
    })
    const body = (await res.json()) as Record<string, unknown>
    if (!res.ok) throw new Error(`login failed: ${(body.error as { code: string }).code}`)
    this.accessToken = String(body.accessToken)
    this.deviceId = (body.device as { id: string }).id
    const user = body.user as { displayName: string; permissions: string[] }
    return { displayName: user.displayName, permissions: user.permissions, deviceId: this.deviceId }
  }

  /** Revokes the device this client is logged in as (AC-25 producer side). */
  async revokeCurrentDevice(): Promise<void> {
    const res = await this.api(`/v1/me/devices/${this.deviceId}`, { method: 'DELETE' })
    if (!res.ok) throw new Error(`device revoke failed: ${res.status}`)
  }

  /** Observes the server-initiated close so tests can assert the 4403 revocation code. */
  onClose(listener: (code: number, reason: string) => void): void {
    this.socket?.on('close', (code: number, data: Buffer) => listener(code, data.toString()))
  }

  async listProjects(): Promise<{ id: string; name: string; hostStatus: string; permissions: string[] }[]> {
    const res = await this.api('/v1/projects')
    const body = (await res.json()) as { projects: { id: string; name: string; hostStatus: string; permissions: string[] }[] }
    return body.projects
  }

  async requestConnect(projectId: string): Promise<ConnectResponse> {
    const res = await this.api(`/v1/projects/${projectId}/connect`, {
      method: 'POST',
      body: JSON.stringify({ deviceId: this.deviceId, devicePubKey: this.deviceKey, clientVersion: '1.5.0' })
    })
    if (!res.ok) {
      const body = (await res.json()) as { error: { code: string } }
      throw Object.assign(new Error(body.error.code), { code: body.error.code })
    }
    return (await res.json()) as ConnectResponse
  }

  async openProject(
    projectId: string,
    options: { probeTimeoutMs?: number; maxDirectAddrs?: number; failoverBudget?: number } = {}
  ): Promise<{ route: 'direct' | 'relay'; selection: SelectionResult; connect: ConnectResponse }> {
    const failoverBudget = options.failoverBudget ?? 1
    let attempts = 0
    for (;;) {
      const connect = await this.requestConnect(projectId)
      const selection = await selectRoute({
        direct: connect.endpoints.direct,
        relay: connect.endpoints.relay,
        probeTimeoutMs: options.probeTimeoutMs,
        maxDirectAddrs: options.maxDirectAddrs
      })
      if (!selection.chosen || !selection.route) {
        const directFailed = selection.probes.filter((p) => !p.ok && p.endpoint.url in connect.endpoints.direct)
        const relayFailed = selection.probes.filter((p) => !p.ok).length === selection.probes.length
        throw Object.assign(new Error('no reachable endpoint'), {
          code: relayFailed ? 'RELAY_UNREACHABLE' : directFailed ? 'DIRECT_TIMEOUT' : 'CONNECT_TIMEOUT',
          probes: selection.probes
        })
      }
      try {
        await this.upgrade(selection.chosen, selection.route, connect.credential)
        return { route: selection.route, selection, connect }
      } catch (err) {
        // The credential was consumed by the failed upgrade; retry with a fresh one.
        if (attempts >= failoverBudget) throw err
        attempts += 1
      }
    }
  }

  private upgrade(endpoint: Endpoint, route: 'direct' | 'relay', credential: string): Promise<void> {
    const url = new URL(endpoint.url)
    // `servername` is a TLS option ws passes through but does not declare.
    const options: WebSocket.ClientOptions & { servername?: string } = {}
    if (url.protocol === 'wss:') {
      options.headers = { 'x-orca-device-pubkey': this.deviceKey }
      options.rejectUnauthorized = this.options.tlsRejectUnauthorized ?? false
      if (route === 'relay' && endpoint.sni) options.servername = endpoint.sni
    }
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(endpoint.url, ['orca-runtime', `orca-cred.${credential}`], options)
      ws.once('open', () => {
        this.socket = ws
        resolve()
      })
      ws.once('error', (err) => reject(err))
      ws.once('unexpected-response', (_req, res) => {
        reject(Object.assign(new Error(`upgrade rejected: ${res.statusCode}`), { statusCode: res.statusCode }))
      })
    })
  }

  rpc(method: string, params: Record<string, unknown> = {}, timeoutMs = 3000): Promise<RpcResult> {
    const socket = this.socket
    if (!socket) return Promise.resolve({ ok: false, code: 'NOT_CONNECTED' })
    const id = ++rpcId
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, code: 'RPC_TIMEOUT' }), timeoutMs)
      const onMessage = (raw: WebSocket.RawData): void => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>
        if (message.id !== id) return
        clearTimeout(timer)
        socket.off('message', onMessage)
        if (message.error) {
          const err = message.error as { code: string; message?: string }
          resolve({ ok: false, code: err.code, message: err.message })
        } else {
          resolve({ ok: true, result: message.result })
        }
      }
      socket.on('message', onMessage)
      socket.send(JSON.stringify({ id, method, params }))
    })
  }

  close(): void {
    this.socket?.close()
    this.socket = null
  }

  private api(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${this.apiUrl}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.accessToken}`,
        'x-trace-id': randomUUID(),
        ...(init.headers ?? {})
      }
    })
  }
}
