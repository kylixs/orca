import { createServer as createHttpServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { mkdir, realpath } from 'node:fs/promises'
import { assertInsideRoot } from './path-containment.ts'
import { resolveFileRequestPath } from './file-request-paths.ts'
import { WebSocketServer } from 'ws'
import { isInsideRoot } from '../../../packages/contract/src/permissions.ts'
import { mtlsFetch } from '../../../packages/contract/src/internal-fetch.ts'
import type { CredentialPayload } from '../../../packages/contract/src/credential.ts'
import { PolicyGateway, type GatewayPolicy } from './policy-gateway.ts'

export type RuntimeSimOptions = {
  hostId: string
  hostName: string
  port: number
  /** Control-plane URL for internal routes; HTTPS enables mTLS there. */
  apiUrl: string
  /** Public API URL used for JWKS (public endpoint, no client cert needed). */
  publicApiUrl?: string
  /** Timeout for each control-plane request; a hanging platform must not stall polling. */
  controlTimeoutMs?: number
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

function isDownloadPolicy(value: unknown): value is 'deny' | 'allow' {
  return value === 'deny' || value === 'allow'
}

/**
 * A version-skewed platform may answer 200 with a different shape. Only a
 * fully valid body may replace the last good policy — a malformed override
 * value (e.g. `123`) must not read as "not deny" and silently allow exports
 * (review-06 N1).
 */
function parsePolicy(value: unknown): (GatewayPolicy & { version?: number }) | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  if (!isDownloadPolicy(candidate.downloadDefault)) return null
  const overrides = candidate.projectOverrides
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return null
  const entries = Object.entries(overrides as Record<string, unknown>)
  if (!entries.every(([, v]) => isDownloadPolicy(v))) return null
  return {
    downloadDefault: candidate.downloadDefault,
    projectOverrides: Object.fromEntries(entries) as Record<string, 'deny' | 'allow'>,
    version: typeof candidate.version === 'number' ? candidate.version : undefined
  }
}

type RevocationSnapshot = {
  projects: { id: string; since: number }[]
  users: { id: string; since: number }[]
  devices: { id: string; since: number }[]
  jtis: string[]
}

/**
 * Returns null for anything structurally wrong, so the caller keeps the previous
 * snapshot. An empty-looking body (`{}`, `{"error":...}`) must never be read as
 * "nothing is revoked" — that would re-admit a revoked ticket (review-07 F2).
 * A single malformed entry is also fatal for the snapshot: dropping it silently
 * would drop that revocation (F4).
 */
function parseRevocations(value: unknown): RevocationSnapshot | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  const entries = (key: 'projects' | 'users' | 'devices'): { id: string; since: number }[] | null => {
    const raw = candidate[key]
    if (!Array.isArray(raw)) return null
    const parsed: { id: string; since: number }[] = []
    for (const item of raw) {
      if (!item || typeof item !== 'object') return null
      const record = item as Record<string, unknown>
      if (typeof record.id !== 'string' || typeof record.since !== 'number') return null
      parsed.push({ id: record.id, since: record.since })
    }
    return parsed
  }
  const projects = entries('projects')
  const users = entries('users')
  const devices = entries('devices')
  const rawJtis = candidate.jtis
  if (!projects || !users || !devices || !Array.isArray(rawJtis)) return null
  if (!rawJtis.every((jti): jti is string => typeof jti === 'string')) return null
  return { projects, users, devices, jtis: rawJtis }
}

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
  let lastPolicyVersion: number | null = null
  const POLICY_STALE_MS = 5 * 60_000
  const activeSessions = new Set<{ ws: import('ws').WebSocket; payload: CredentialPayload }>()
  const revocationRefresher = setInterval(() => {
    void refreshPolicy().catch(() => undefined)
  }, 1000)

  /**
   * Never throws: the platform may be down during an established session, and an
   * unhandled rejection here would kill the runtime process (breaking AC-20).
   * On failure we keep the last policy until it goes stale, then fail closed.
   */
  let refreshInFlight: Promise<void> | null = null

  async function refreshPolicy(): Promise<void> {
    // Single-flight: a hanging platform must not pile up one request per tick.
    if (refreshInFlight) return refreshInFlight
    refreshInFlight = refreshPolicyOnce().finally(() => {
      refreshInFlight = null
    })
    return refreshInFlight
  }

  async function refreshPolicyOnce(): Promise<void> {
    // Each request gets its own signal: a shared one would abort the healthy
    // responses when a single endpoint hangs (review-07 F1). The abort is what
    // actually frees a socket against a platform that never answers (review-06 N3).
    const accepted = await fetchPolicyFromPlatform().catch(() => false)
    // A malformed 200 is a normal return, so freshness must only advance when
    // a valid policy was accepted; otherwise the deny fallback never kicks in
    // (review-06 N4).
    if (accepted) policyFreshAt = Date.now()
    // Outside any try: one failing endpoint must not stop revocation from
    // reaching established sessions (review-07 F1).
    closeRevokedSessions()
    if (Date.now() - policyFreshAt > POLICY_STALE_MS) {
      policy = { downloadDefault: 'deny', projectOverrides: {} }
    }
  }

  /** Server-initiated close for sessions whose device/user/project was revoked. */
  function closeRevokedSessions(): void {
    for (const session of [...activeSessions]) {
      const reason = gateway.revocationReason(session.payload)
      if (!reason) continue
      activeSessions.delete(session)
      session.ws.close(4403, reason)
      // Do not rely on the peer completing the close handshake.
      setTimeout(() => session.ws.terminate(), 1000).unref()
    }
  }

  async function fetchPolicyFromPlatform(): Promise<boolean> {
    const timeoutMs = options.controlTimeoutMs ?? 3000
    const timeout = (): AbortSignal => AbortSignal.timeout(timeoutMs)
    const control = {
      internalUrl: options.apiUrl,
      token: options.internalToken,
      keyPath: options.keyPath,
      certPath: options.certPath,
      caPath: options.caPath
    }
    const publicUrl = options.publicApiUrl ?? options.apiUrl
    // Independent outcomes: a hung or broken policy endpoint must not discard a
    // healthy JWKS or revocation set, and vice versa (review-07 F1).
    const [jwksRes, policyRes, revokedRes] = await Promise.allSettled([
      // JWKS is public and may be served by the public listener only.
      fetch(`${publicUrl}/v1/jwks`, { signal: timeout() }),
      mtlsFetch(control, '/v1/internal/policy', { signal: timeout() }),
      mtlsFetch(control, '/v1/internal/revocations', { signal: timeout() })
    ]).then((results) => results.map((result) => (result.status === 'fulfilled' ? result.value : null)))

    if (jwksRes?.ok) {
      try {
        const body = (await jwksRes.json()) as { keys: { kid: string; publicKeyPem: string }[] }
        if (Array.isArray(body.keys)) gateway.setJwks(body.keys)
      } catch {
        // Keep the previous keys.
      }
    }
    let accepted = false
    if (policyRes?.ok) {
      try {
        const parsed = parsePolicy(await policyRes.json())
        if (parsed) {
          policy = {
            downloadDefault: parsed.downloadDefault,
            projectOverrides: parsed.projectOverrides
          }
          if (typeof parsed.version === 'number') lastPolicyVersion = parsed.version
          accepted = true
        }
      } catch {
        // Keep the previous policy.
      }
    }
    if (policyRes?.ok && revokedRes?.ok && lastPolicyVersion !== null) {
      console.log(`[runtime-sim] policy synced v=${lastPolicyVersion}`)
    }
    if (revokedRes?.ok) {
      try {
        const parsed = parseRevocations(await revokedRes.json())
        // null means the body is untrustworthy; keeping the old set is the only
        // fail-closed option (F2).
        if (parsed) gateway.setRevocations(parsed)
      } catch {
        // Keep the previous revocation set.
      }
    }
    return accepted
  }

  // Why not awaited: a hung platform must not delay listening (review-07 F1), and
  // the first poll is bounded by the same abort signal.
  void refreshPolicy()

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
      const session = { ws, payload }
      activeSessions.add(session)
      ws.on('close', () => activeSessions.delete(session))
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
    try {
      // Why: revocation closes the socket, but the 1s terminate grace must not be a
      // free window for more RPCs (review-07 F5).
      const revokedReason = gateway.revocationReason(payload)
      if (revokedReason) {
        ws.send(
          JSON.stringify({ id: request.id, error: { code: 'PERMISSION_DENIED', message: '会话已失效。' } })
        )
        ws.close(4403, revokedReason)
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
      const filePath = (mode: 'read' | 'write') =>
        resolveFileRequestPath(
          { projectRoot: payload.projectRoot, workspaceRoot: payload.workspaceRoot },
          request.params ?? {},
          mode
        )
      if (request.method === 'files.read' || request.method === 'files.readDir') {
        const resolved = filePath('read')
        if (!resolved.ok) {
          ws.send(
            JSON.stringify({ id: request.id, error: { code: resolved.code, message: resolved.message } })
          )
          return
        }
        const result =
          request.method === 'files.read'
            ? { content: await gateway.executeRead(payload, resolved.absolute) }
            : { entries: await gateway.executeReadDir(payload, resolved.absolute) }
        ws.send(JSON.stringify({ id: request.id, result }))
        return
      }
      if (request.method === 'files.write') {
        const resolved = filePath('write')
        if (!resolved.ok) {
          ws.send(
            JSON.stringify({ id: request.id, error: { code: resolved.code, message: resolved.message } })
          )
          return
        }
        const content = String(request.params?.content ?? '')
        await gateway.executeWrite(payload, resolved.absolute, content)
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
        // Reject instead of rewriting: silently mapping ".." to "branch" could collide
        // two different branches onto one directory and one idempotency key.
        const cleaned = branch.replace(/[^A-Za-z0-9._-]+/g, '-')
        // A name of pure separators sanitizes to dashes and would become a real
        // directory with no relation to any branch.
        if (!/[A-Za-z0-9]/.test(cleaned) || cleaned.startsWith('.') || cleaned.includes('..')) {
          ws.send(JSON.stringify({ id: request.id, error: { code: 'BAD_REQUEST', message: '分支名不合法' } }))
          return
        }
        const sanitized = cleaned
        // Client-supplied keys are namespaced so one device cannot probe or suppress
        // another device's worktree creation.
        const key = `${payload.project}:${payload.deviceId}:${idempotencyKey || sanitized}`
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
        for (const session of activeSessions) session.ws.terminate()
        activeSessions.clear()
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
    controlTimeoutMs: process.env.CONTROL_TIMEOUT_MS ? Number(process.env.CONTROL_TIMEOUT_MS) : undefined,
    internalToken:
      process.env.INTERNAL_TOKEN ?? process.env.ORCA_CLOUD_INTERNAL_TOKEN ?? 'internal-test-token',
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
