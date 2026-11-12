import { createServer as createHttpServer } from 'node:http'
import { mkdirSync, readFileSync } from 'node:fs'
import { sep } from 'node:path'
import { WebSocketServer } from 'ws'
import { PolicyGateway, type GatewayPolicy } from './policy-gateway.ts'

export type RuntimeSimOptions = {
  hostId: string
  hostName: string
  port: number
  apiUrl: string
  internalToken: string
  sandboxRoot: string
  tls?: { key: string; cert: string }
}

export type RuntimeSim = {
  port: number
  close: () => Promise<void>
  refreshJwks: () => Promise<void>
}

type RpcRequest = { id: number; method: string; params?: Record<string, unknown> }

function readCredentialFromProtocol(header: string | undefined): string | null {
  if (!header) return null
  for (const part of header.split(',')) {
    const value = part.trim()
    if (value.startsWith('orca-cred.')) return value.slice('orca-cred.'.length)
  }
  return null
}

export async function startRuntimeSim(options: RuntimeSimOptions): Promise<RuntimeSim> {
  const worktrees = new Map<string, { path: string; branch: string }>()
  const gateway = new PolicyGateway({
    hostId: options.hostId,
    hostName: options.hostName,
    sandboxRoot: options.sandboxRoot
  })
  let policy: GatewayPolicy = { downloadDefault: 'deny', projectOverrides: {} }
  const revocationRefresher = setInterval(() => void refreshPolicy(), 1000)

  async function refreshPolicy(): Promise<void> {
    const [jwksRes, policyRes, revokedRes] = await Promise.all([
      fetch(`${options.apiUrl}/v1/jwks`),
      fetch(`${options.apiUrl}/v1/internal/policy`, {
        headers: { 'x-internal-token': options.internalToken }
      }),
      fetch(`${options.apiUrl}/v1/internal/revocations`, {
        headers: { 'x-internal-token': options.internalToken }
      })
    ])
    if (jwksRes.ok) {
      const body = (await jwksRes.json()) as { keys: { kid: string; publicKeyPem: string }[] }
      gateway.setJwks(body.keys)
    }
    if (policyRes.ok) {
      policy = (await policyRes.json()) as GatewayPolicy
    }
    if (revokedRes.ok) {
      const body = (await revokedRes.json()) as {
        projects: { id: string; since: number }[]
        users: { id: string; since: number }[]
        jtis: string[]
      }
      gateway.setRevocations(body)
    }
  }

  await refreshPolicy()

  const httpServer = options.tls
    ? (await import('node:https')).createServer({
        key: readFileSync(options.tls.key),
        cert: readFileSync(options.tls.cert)
      })
    : createHttpServer()

  const wss = new WebSocketServer({ noServer: true })

  httpServer.on('upgrade', (req, socket, head) => {
    const header = req.headers['sec-websocket-protocol']
    const credential = readCredentialFromProtocol(header)
    if (!credential) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    const declaredDevicePubKey = req.headers['x-orca-device-pubkey']?.toString()
    const admission = gateway.admit(credential, declaredDevicePubKey)
    if (!admission.ok || !admission.payload) {
      socket.write(`HTTP/1.1 401 Unauthorized\r\nx-orca-reject: ${admission.code}\r\n\r\n`)
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const payload = admission.payload!
      ws.send(
        JSON.stringify({
          type: 'e2ee_ready',
          hostFingerprint: options.hostName,
          deviceToken: payload.deviceToken
        })
      )
      ws.on('message', (raw) => {
        void handleRpc(ws, payload, raw.toString())
      })
    })
  })

  async function handleRpc(
    ws: import('ws').WebSocket,
    payload: NonNullable<ReturnType<PolicyGateway['admit']>['payload']>,
    raw: string
  ): Promise<void> {
    let request: RpcRequest
    try {
      request = JSON.parse(raw) as RpcRequest
    } catch {
      ws.send(JSON.stringify({ id: 0, error: { code: 'BAD_REQUEST' } }))
      return
    }
    const authorized = gateway.authorize(payload, request.method, request.params ?? {}, policy)
    if (!authorized.ok) {
      ws.send(
        JSON.stringify({
          id: request.id,
          error: { code: authorized.code, message: authorized.message }
        })
      )
      return
    }
    try {
      if (request.method === 'files.read') {
        const path = String(request.params?.path ?? '')
        const content = await gateway.executeRead(payload, path)
        ws.send(JSON.stringify({ id: request.id, result: { content } }))
        return
      }
      if (request.method === 'files.write') {
        const path = String(request.params?.path ?? '')
        const content = String(request.params?.content ?? '')
        await gateway.executeWrite(payload, path, content)
        ws.send(JSON.stringify({ id: request.id, result: { ok: true } }))
        return
      }
      if (request.method === 'worktree.createManaged') {
        const branch = String(request.params?.branchName ?? request.params?.branchNameOverride ?? '')
        const idempotencyKey = String(request.params?.idempotencyKey ?? '')
        if (!branch) {
          ws.send(JSON.stringify({ id: request.id, error: { code: 'BAD_REQUEST', message: '缺少分支名' } }))
          return
        }
        const sanitized = branch.replace(/[^A-Za-z0-9._-]+/g, '-')
        const key = idempotencyKey || `${payload.project}:${payload.deviceId}:${sanitized}`
        const existing = worktrees.get(key)
        if (existing) {
          ws.send(JSON.stringify({ id: request.id, result: { worktreeId: key, path: existing.path } }))
          return
        }
        // nestWorkspaces=false: the worktree sits directly under workspaceRoot.
        const worktreePath = `${payload.workspaceRoot}/${sanitized}`
        if (!worktreePath.startsWith(`${payload.workspaceRoot}${sep}`)) {
          ws.send(JSON.stringify({ id: request.id, error: { code: 'PATH_OUTSIDE_ROOT' } }))
          return
        }
        mkdirSync(gateway.localProjectPath(payload, worktreePath), { recursive: true })
        worktrees.set(key, { path: worktreePath, branch })
        ws.send(JSON.stringify({ id: request.id, result: { worktreeId: key, path: worktreePath } }))
        return
      }
      if (request.method === 'workspace.info') {
        ws.send(
          JSON.stringify({
            id: request.id,
            result: {
              projectRoot: payload.projectRoot,
              workspaceRoot: payload.workspaceRoot,
              perms: payload.perms
            }
          })
        )
        return
      }
      if (request.method === 'sessions.whoami') {
        ws.send(JSON.stringify({ id: request.id, result: { sub: payload.sub, project: payload.project } }))
        return
      }
      ws.send(JSON.stringify({ id: request.id, error: { code: 'NOT_IMPLEMENTED' } }))
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'INTERNAL_ERROR'
      ws.send(JSON.stringify({ id: request.id, error: { code, message: String(err) } }))
    }
  }

  await new Promise<void>((resolve) => httpServer.listen(options.port, '127.0.0.1', () => resolve()))
  const address = httpServer.address()
  const port = typeof address === 'object' && address ? address.port : options.port

  return {
    port,
    refreshJwks: refreshPolicy,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(revocationRefresher)
        wss.close()
        httpServer.close(() => resolve())
      })
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const runtime = await startRuntimeSim({
    hostId: process.env.HOST_ID ?? 'host_dev001',
    hostName: process.env.HOST_NAME ?? 'dev-001',
    port: Number(process.env.PORT ?? 16768),
    apiUrl: process.env.API_URL ?? 'http://127.0.0.1:18787',
    internalToken: process.env.INTERNAL_TOKEN ?? 'internal-test-token',
    sandboxRoot: process.env.SANDBOX_ROOT ?? '/tmp/orca-cloud-sandbox',
    tls: process.env.TLS_KEY
      ? { key: process.env.TLS_KEY, cert: process.env.TLS_CERT ?? '' }
      : undefined
  })
  console.log(`[runtime-sim] ${process.env.HOST_NAME ?? 'dev-001'} listening on :${runtime.port}`)
}
