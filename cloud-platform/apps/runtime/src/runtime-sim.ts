import { createServer as createHttpServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { mkdir, realpath } from 'node:fs/promises'
import { assertInsideRoot } from './path-containment.ts'
import { WebSocketServer } from 'ws'
import { isInsideRoot } from '../../../packages/contract/src/permissions.ts'
import { mtlsFetch } from '../../../packages/contract/src/internal-fetch.ts'
import { PolicyGateway, type GatewayPolicy } from './policy-gateway.ts'

export type RuntimeSimOptions = {
  hostId: string
  hostName: string
  port: number
  /** Control-plane URL for internal routes; HTTPS enables mTLS there. */
  apiUrl: string
  /** Public API URL used for JWKS (public endpoint, no client cert needed). */
  publicApiUrl?: string
  internalToken: string
  keyPath?: string
  certPath?: string
  caPath?: string
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
  let policyFreshAt = Date.now()
  const POLICY_STALE_MS = 5 * 60_000
  const revocationRefresher = setInterval(() => {
    void refreshPolicy().catch(() => undefined)
  }, 1000)

  /**
   * Never throws: the platform may be down during an established session, and an
   * unhandled rejection here would kill the runtime process (breaking AC-20).
   * On failure we keep the last policy until it goes stale, then fail closed.
   */
  async function refreshPolicy(): Promise<void> {
    try {
      await fetchPolicyFromPlatform()
      policyFreshAt = Date.now()
    } catch {
      if (Date.now() - policyFreshAt > POLICY_STALE_MS) {
        policy = { downloadDefault: 'deny', projectOverrides: {} }
      }
    }
  }

  async function fetchPolicyFromPlatform(): Promise<void> {
    const control = {
      internalUrl: options.apiUrl,
      token: options.internalToken,
      keyPath: options.keyPath,
      certPath: options.certPath,
      caPath: options.caPath
    }
    const publicUrl = options.publicApiUrl ?? options.apiUrl
    const [jwksRes, policyRes, revokedRes] = await Promise.all([
      // JWKS is public and may be served by the public listener only.
      fetch(`${publicUrl}/v1/jwks`),
      mtlsFetch(control, '/v1/internal/policy'),
      mtlsFetch(control, '/v1/internal/revocations')
    ])
    if (jwksRes.ok) {
      const body = (await jwksRes.json()) as { keys: { kid: string; publicKeyPem: string }[] }
      gateway.setJwks(body.keys)
    }
    if (policyRes.ok) {
      policy = (await policyRes.json()) as GatewayPolicy
    }
    if (policyRes.ok && revokedRes.ok) {
      console.log(`[runtime-sim] policy synced v=${policy.version}`)
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
        // Reject dot-only segments: `..` must not survive sanitisation.
        const sanitized = branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^\.+$/, 'branch')
        if (!sanitized || sanitized.startsWith('.')) {
          ws.send(JSON.stringify({ id: request.id, error: { code: 'BAD_REQUEST', message: '分支名不合法' } }))
          return
        }
        const key = idempotencyKey || `${payload.project}:${payload.deviceId}:${sanitized}`
        const existing = worktrees.get(key)
        if (existing) {
          ws.send(JSON.stringify({ id: request.id, result: { worktreeId: key, path: existing.path } }))
          return
        }
        // nestWorkspaces=false: the worktree sits directly under workspaceRoot.
        const worktreePath = `${payload.workspaceRoot}/${sanitized}`
        if (!isInsideRoot(payload.workspaceRoot, worktreePath)) {
          ws.send(JSON.stringify({ id: request.id, error: { code: 'PATH_OUTSIDE_ROOT' } }))
          return
        }
        try {
          // Same containment path as file writes: validate before creating, then re-resolve.
          // workspaceRoot is validated to sit inside projectRoot at admit(), so creating it is safe.
          const rootPath = gateway.localProjectPath(payload, payload.workspaceRoot)
          await mkdir(rootPath, { recursive: true })
          const root = await realpath(rootPath)
          const target = gateway.localProjectPath(payload, worktreePath)
          await assertInsideRoot(root, target)
          await mkdir(target, { recursive: true })
          await assertInsideRoot(root, target)
        } catch (err) {
          const code = (err as { code?: string }).code ?? 'WORKSPACE_CREATE_FAILED'
          ws.send(JSON.stringify({ id: request.id, error: { code } }))
          return
        }
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
    publicApiUrl: process.env.PUBLIC_API_URL,
    internalToken: process.env.INTERNAL_TOKEN ?? 'internal-test-token',
    keyPath: process.env.INTERNAL_TLS_KEY,
    certPath: process.env.INTERNAL_TLS_CERT,
    caPath: process.env.INTERNAL_TLS_CA,
    sandboxRoot: process.env.SANDBOX_ROOT ?? '/tmp/orca-cloud-sandbox',
    tls: process.env.TLS_KEY
      ? { key: process.env.TLS_KEY, cert: process.env.TLS_CERT ?? '' }
      : undefined
  })
  console.log(`[runtime-sim] ${process.env.HOST_NAME ?? 'dev-001'} listening on :${runtime.port}`)
}
