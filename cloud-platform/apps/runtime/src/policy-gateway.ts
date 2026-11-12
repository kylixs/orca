import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises'
import { dirname, normalize, sep } from 'node:path'
import { assertInsideRoot } from './path-containment.ts'
import {
  decideMethod,
  isInsideRoot,
  requiresWritePath
} from '../../../packages/contract/src/permissions.ts'
import { verifyCredential, type CredentialPayload } from '../../../packages/contract/src/credential.ts'

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
  private revokedJtis = new Set<string>()

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
  }

  /** `since` is epoch ms; credentials issued before it are rejected. */
  setRevocations(input: {
    projects?: { id: string; since: number }[]
    users?: { id: string; since: number }[]
    jtis?: string[]
  }): void {
    this.revokedProjects = new Map((input.projects ?? []).map((p) => [p.id, p.since]))
    this.revokedUsers = new Map((input.users ?? []).map((u) => [u.id, u.since]))
    this.revokedJtis = new Set(input.jtis ?? [])
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
    if (revokedSince !== undefined && payload.iat * 1000 <= revokedSince) {
      return { ok: false, code: 'project_revoked', message: '项目权限已收回。' }
    }
    const userRevokedSince = this.revokedUsers.get(payload.sub.replace(/^user:/, ''))
    if (userRevokedSince !== undefined && payload.iat * 1000 <= userRevokedSince) {
      return { ok: false, code: 'user_revoked', message: '用户权限已收回。' }
    }
    // jti revocation wins over the local "already used" cache.
    if (this.revokedJtis.has(payload.jti)) {
      return { ok: false, code: 'jti_revoked', message: '该连接凭证已被吊销。' }
    }
    // Bind the ticket to the device that presents it (AC-30).
    if (declaredDevicePubKey && payload.devicePubKey && declaredDevicePubKey !== payload.devicePubKey) {
      return { ok: false, code: 'device_mismatch', message: '凭证与请求设备不匹配。' }
    }
    // Bind the workspace root to the project root so a forged credential cannot widen scope.
    if (!payload.workspaceRoot.startsWith(`${payload.projectRoot}${sep}`)) {
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
    const effective =
      policy.projectOverrides[payload.project] ?? policy.downloadDefault ?? 'deny'
    const decision = decideMethod(method, payload.perms, effective)
    if (!decision.allow) {
      return { ok: false, code: decision.code, message: '该操作不被当前权限允许。' }
    }
    const target = typeof params.path === 'string' ? params.path : null
    if (!target) return { ok: true }
    const root = requiresWritePath(method) ? payload.workspaceRoot : payload.projectRoot
    if (!isInsideRoot(root, target)) {
      return { ok: false, code: 'PATH_OUTSIDE_ROOT', message: '路径超出项目或工作区范围。' }
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
    await mkdir(dirname(target), { recursive: true })
    // Resolve after mkdir so symlinked parents are caught before the write.
    const resolved = await assertInsideRoot(root, target)
    await writeFile(resolved, content, 'utf8')
  }
}
