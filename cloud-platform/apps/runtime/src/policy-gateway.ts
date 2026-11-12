import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises'
import { dirname, normalize, sep } from 'node:path'
import { assertInsideRoot } from './path-containment.ts'
import {
  decideMethod,
  isInsideRoot,
  requiresWritePath,
  MULTI_PATH_WRITE_PARAMS
} from '../../../packages/contract/src/permissions.ts'
import { verifyCredential, type CredentialPayload } from '../../../packages/contract/src/credential.ts'

/** Milliseconds since issue; `iat` alone is whole seconds and cannot settle a same-second revoke+regrant. */
const issuedAtMs = (payload: CredentialPayload): number => payload.iatMs ?? payload.iat * 1000

export type GatewayPolicy = {
  downloadDefault: 'deny' | 'allow'
  projectOverrides: Record<string, 'deny' | 'allow'>
}

export type GatewayDecision = { ok: true } | { ok: false; code: string; message: string }

export class PolicyGateway {
  private jwks = new Map<string, string>()
  private usedJtis = new Map<string, number>()
  private revokedProjects = new Map<string, number>()
  private revokedUsers = new Map<string, number>()
  private revokedJtis = new Map<string, number>()
  private revokedDevices = new Map<string, number>()
  private jwksFetchedAt: number | null = null
  private static readonly JWKS_TTL_MS = 5 * 60_000

  private readonly options: {
    hostId: string
    hostName: string
    sandboxRoot: string
    now?: () => number
  }

  constructor(options: {
    hostId: string
    hostName: string
    sandboxRoot: string
    now?: () => number
  }) {
    this.options = options
  }

  setJwks(keys: { kid: string; publicKeyPem: string }[]): void {
    this.jwks = new Map(keys.map((k) => [k.kid, k.publicKeyPem]))
    this.jwksFetchedAt = (this.options.now ?? Date.now)()
  }

  /** Refuses to verify against keys older than the TTL (platform unreachable too long). */
  private jwksUsable(): boolean {
    if (this.jwksFetchedAt === null) return this.jwks.size > 0
    return (this.options.now ?? Date.now)() - this.jwksFetchedAt <= PolicyGateway.JWKS_TTL_MS
  }

  /** `since` is epoch ms; credentials issued before it are rejected. */
  setRevocations(input: {
    projects?: { id: string; since: number }[]
    users?: { id: string; since: number }[]
    jtis?: string[]
    devices?: { id: string; since: number }[]
  }): void {
    this.revokedProjects = new Map((input.projects ?? []).map((p) => [p.id, p.since]))
    this.revokedUsers = new Map((input.users ?? []).map((u) => [u.id, u.since]))
    const jtiExpiry = Date.now() + 10 * 60_000
    this.revokedJtis = new Map((input.jtis ?? []).map((jti) => [jti, jtiExpiry]))
    this.revokedDevices = new Map((input.devices ?? []).map((d) => [d.id, d.since]))
  }

  /**
   * Re-checks an *established* session against the current revocation snapshot.
   * Admission only ran once at upgrade time, so a revoked device would otherwise
   * keep its socket forever (review-06 N2, AC-25).
   */
  revocationReason(payload: CredentialPayload): string | null {
    const nowMs = (this.options.now ?? Date.now)()
    const projectSince = this.revokedProjects.get(payload.project)
    if (projectSince !== undefined && issuedAtMs(payload) <= projectSince) return 'project_revoked'
    const userSince = this.revokedUsers.get(payload.sub.replace(/^user:/, ''))
    if (userSince !== undefined && issuedAtMs(payload) <= userSince) return 'user_revoked'
    const deviceSince = this.revokedDevices.get(payload.deviceId)
    if (deviceSince !== undefined && issuedAtMs(payload) <= deviceSince) return 'device_revoked'
    const jtiExpiry = this.revokedJtis.get(payload.jti)
    if (jtiExpiry !== undefined && jtiExpiry > nowMs) return 'jti_revoked'
    return null
  }

  private pruneJtis(nowSeconds: number): void {
    for (const [jti, expiresAt] of this.usedJtis) {
      if (expiresAt <= nowSeconds) this.usedJtis.delete(jti)
    }
  }

  /** Maps a project-absolute path onto the simulator sandbox. */
  localPath(absolute: string): string {
    const root = normalize(this.options.sandboxRoot)
    const rel = normalize(absolute).replace(/^([A-Za-z]:)?[\\/]+/, '')
    return `${root}${sep}${rel}`
  }

  /**
   * Validates the upgrade-time credential. Called before any E2EE handshake,
   * mirroring design.md §4.3.4 step 1.
   */
  admit(
    token: string,
    declaredDevicePubKey?: string
  ): GatewayDecision & { payload?: CredentialPayload; deviceToken?: string } {
    const nowS = Math.floor((this.options.now ?? Date.now)() / 1000)
    this.pruneJtis(nowS)
    const result = verifyCredential(token, this.jwks, nowS)
    if (!result.ok) {
      return { ok: false, code: result.reason, message: '连接凭证校验失败。' }
    }
    const payload = result.payload
    if (payload.host !== this.options.hostId || payload.aud !== `host:${this.options.hostName}`) {
      return { ok: false, code: 'host_mismatch', message: '凭证与主机不匹配。' }
    }
    if (this.usedJtis.has(payload.jti)) {
      return { ok: false, code: 'replayed', message: '凭证已被使用。' }
    }
    const revokedSince = this.revokedProjects.get(payload.project)
    if (revokedSince !== undefined && issuedAtMs(payload) <= revokedSince) {
      return { ok: false, code: 'project_revoked', message: '项目权限已收回。' }
    }
    const userRevokedSince = this.revokedUsers.get(payload.sub.replace(/^user:/, ''))
    if (userRevokedSince !== undefined && issuedAtMs(payload) <= userRevokedSince) {
      return { ok: false, code: 'user_revoked', message: '用户权限已收回。' }
    }
    // jti revocation wins over the local "already used" cache.
    if (!this.jwksUsable()) {
      return { ok: false, code: 'jwks_stale', message: '签名公钥已过期，暂时无法建立新连接。' }
    }
    const deviceRevokedSince = this.revokedDevices.get(payload.deviceId)
    if (deviceRevokedSince !== undefined && issuedAtMs(payload) <= deviceRevokedSince) {
      return { ok: false, code: 'device_revoked', message: '该设备已被吊销。' }
    }
    const revokedJtiExpiry = this.revokedJtis.get(payload.jti)
    if (revokedJtiExpiry !== undefined && revokedJtiExpiry > Date.now()) {
      return { ok: false, code: 'jti_revoked', message: '该连接凭证已被吊销。' }
    }
    // Bind the ticket to the device that presents it (AC-30). Fail closed: omitting the
    // header must not bypass the check, otherwise a copied credential upgrades freely.
    if (!declaredDevicePubKey) {
      return { ok: false, code: 'device_pubkey_missing', message: '缺少设备公钥。' }
    }
    if (!payload.devicePubKey || declaredDevicePubKey !== payload.devicePubKey) {
      return { ok: false, code: 'device_mismatch', message: '凭证与请求设备不匹配。' }
    }
    // Bind the workspace root to the project root so a forged credential cannot widen scope.
    // isInsideRoot handles both POSIX and Windows separators and rejects cross-drive paths.
    if (!isInsideRoot(payload.projectRoot, payload.workspaceRoot)) {
      return { ok: false, code: 'workspace_root_invalid', message: '工作区根不在项目范围内。' }
    }
    this.usedJtis.set(payload.jti, nowS + 120)
    return { ok: true, payload }
  }

  /** Method-level authorisation + path boundary, mirroring §7.3. */
  authorize(
    payload: CredentialPayload,
    method: string,
    params: Record<string, unknown>,
    policy: GatewayPolicy
  ): GatewayDecision {
    // Defensive: a malformed policy must never take down the runtime.
    const overrides = policy?.projectOverrides ?? {}
    const effective = overrides[payload.project] ?? policy?.downloadDefault ?? 'deny'
    const decision = decideMethod(method, payload.perms, effective)
    if (!decision.allow) {
      return { ok: false, code: decision.code, message: '该操作不被当前权限允许。' }
    }
    const root = requiresWritePath(method) ? payload.workspaceRoot : payload.projectRoot
    const candidates: string[] = []
    if (typeof params.path === 'string') candidates.push(params.path)
    for (const key of MULTI_PATH_WRITE_PARAMS[method] ?? []) {
      if (typeof params[key] === 'string') candidates.push(params[key] as string)
    }
    for (const candidate of candidates) {
      if (!isInsideRoot(root, candidate)) {
        return { ok: false, code: 'PATH_OUTSIDE_ROOT', message: '路径超出项目或工作区范围。' }
      }
    }
    return { ok: true }
  }

  localProjectPath(_payload: CredentialPayload, absolute: string): string {
    return this.localPath(absolute)
  }

  async executeRead(payload: CredentialPayload, path: string): Promise<string> {
    const resolved = await assertInsideRoot(await realpath(this.localPath(payload.projectRoot)), this.localPath(path))
    return readFile(resolved, 'utf8')
  }

  async executeWrite(payload: CredentialPayload, path: string, content: string): Promise<void> {
    const root = await realpath(this.localPath(payload.workspaceRoot)).catch(async () => {
      const created = this.localPath(payload.workspaceRoot)
      await mkdir(created, { recursive: true })
      return realpath(created)
    })
    const target = this.localPath(path)
    // Check containment before creating anything: mkdir on an escaping path would
    // leave directories outside the root.
    await assertInsideRoot(root, target)
    await mkdir(dirname(target), { recursive: true })
    // Re-check after mkdir to narrow the check-then-write window.
    const resolved = await assertInsideRoot(root, target)
    await writeFile(resolved, content, 'utf8')
  }
}
