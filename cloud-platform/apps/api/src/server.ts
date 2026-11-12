import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { validateProjectPath } from '../../../packages/contract/src/project-path.ts'
import {
  generateSigningKey,
  newDeviceToken,
  newJti,
  signCredential,
  type CredentialPayload,
  type Permission,
  type PublicKeyEntry,
  type SigningKey
} from '../../../packages/contract/src/credential.ts'
import { AuditChain } from './audit.ts'
import { startInternalChannel } from './internal-channel.ts'
import { ldapProfile, MockLdapAdapter, type LdapAdapter } from './ldap.ts'
import { Store, type Host, type Project, type User } from './store.ts'

const ACCESS_TTL_MS = 30 * 60_000
const REFRESH_TTL_MS = 12 * 60 * 60_000
const CREDENTIAL_TTL_S = 60
const HOST_OFFLINE_MS = 60_000
const WEB_ROOT = new URL('../../web/', import.meta.url).pathname

export type ApiConfig = {
  port: number
  ldap?: LdapAdapter
  now?: () => number
  internalToken?: string
  /** Enables the dedicated mTLS listener for platform → relay/runtime control traffic. */
  internalTls?: {
    port: number
    keyPath: string
    certPath: string
    caPath: string
    allowedCNs?: string[]
  }
}

export type ApiHandle = {
  store: Store
  audit: AuditChain
  signingKey: SigningKey
  listen: () => Promise<number>
  close: () => Promise<void>
  setRelayPort: (port: number) => void
  /** Port of the mTLS control listener, when enabled. */
  internalPort: () => number | null
}

type AuthedRequest = { user: User; sessionId: string }

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(payload)
}

function error(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  traceId?: string,
  details?: Record<string, unknown>
): void {
  json(res, status, { error: { code, message, traceId, details } })
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

const ROLE_PERMISSIONS: Record<string, string[]> = {
  'platform:admin': ['platform:admin'],
  'platform:auditor': ['platform:auditor'],
  developer: []
}

function isAdmin(user: User): boolean {
  return user.roles.includes('platform:admin')
}

export function createApp(config: ApiConfig): ApiHandle {
  const now = config.now ?? (() => Date.now())
  const store = new Store()
  const audit = new AuditChain(store)
  const signingKey = generateSigningKey(`kid-${now()}`)
  const jwks: Map<string, PublicKeyEntry> = new Map([
    [signingKey.kid, { kid: signingKey.kid, publicKeyPem: signingKey.publicKeyPem }]
  ])
  // Production must inject a secret; the fallback exists only for local tests.
  const internalToken =
    config.internalToken ??
    process.env.INTERNAL_TOKEN ??
    process.env.ORCA_CLOUD_INTERNAL_TOKEN ??
    'internal-test-token'

  const accounts = new Map<string, { password: string; profile: ReturnType<typeof ldapProfile> }>([
    [
      'zhangsan',
      {
        password: 'Passw0rd!',
        profile: ldapProfile({ username: 'zhangsan', displayName: '张伟', dept: '支付研发部' })
      }
    ],
    [
      'admin',
      {
        password: 'Adm1n!',
        profile: ldapProfile({
          username: 'admin',
          displayName: '李静',
          dept: '平台工程部',
          groups: ['platform-admins']
        })
      }
    ]
  ])
  const ldap = config.ldap ?? new MockLdapAdapter(accounts)

  // Seed: admin, developer, host, project, grants.
  const admin = store.seedUser({
    username: 'admin',
    displayName: '李静',
    dept: '平台工程部',
    email: 'admin@example.com',
    groups: ['platform-admins'],
    roles: ['platform:admin', 'developer'],
    status: 'active'
  })
  const dev = store.seedUser({
    username: 'zhangsan',
    displayName: '张伟',
    dept: '支付研发部',
    email: 'zhangsan@example.com',
    groups: ['developers', 'team-payment'],
    roles: ['developer'],
    status: 'active'
  })
  const host: Host = {
    id: 'host_dev001',
    name: 'dev-001',
    fingerprint: 'sha256:hostfingerprint001',
    tlsFingerprint: 'sha256:hosttls001',
    e2eePublicKey: 'MCowBQYDK2VuAyEAhostpublickeyplaceholder0000000000=',
    orcaVersion: '1.5.0',
    protocolVersion: 3,
    zone: 'intranet',
    directAddrs: ['127.0.0.1:16768'],
    relayRoute: 'dev-001',
    capabilities: ['pty', 'files', 'git', 'managed-credential'],
    status: 'online',
    maintenanceReason: null,
    lastHeartbeatAt: now(),
    credentialHash: null
  }
  store.hosts.set(host.id, host)
  store.hostsByName.set(host.name, host)

  const project: Project = {
    id: 'proj_payment',
    key: 'payment-service',
    name: 'payment-service',
    repoUrl: 'git@git.example.com:pay/payment-service.git',
    hostId: host.id,
    path: '/srv/work/payment-service',
    defaultBranch: 'main',
    downloadPolicy: 'deny',
    status: 'ready',
    createdAt: now()
  }
  store.projects.set(project.id, project)
  store.projectsByKey.set(project.key, project)
  store.grants.push({
    projectId: project.id,
    subjectType: 'group',
    subjectId: 'team-payment',
    permissions: ['open', 'terminal', 'agent', 'file:read', 'file:write']
  })
  store.relayRoutes.set('dev-001', {
    routeKey: 'dev-001',
    hostId: host.id,
    target: '127.0.0.1:16768',
    version: 1
  })

  function resolveToken(req: IncomingMessage): AuthedRequest | null {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) return null
    const token = header.slice(7)
    const entry = store.accessTokens.get(token)
    if (!entry) return null
    if (entry.expiresAt < now()) {
      store.accessTokens.delete(token)
      return null
    }
    const session = store.sessions.get(entry.sessionId)
    if (!session || session.revokedAt || session.epoch !== entry.epoch) return null
    const user = store.users.get(entry.userId)
    if (!user || user.status !== 'active') return null
    return { user, sessionId: session.id }
  }

  function issueSession(user: User, deviceId: string): { accessToken: string; refreshToken: string } {
    const accessToken = randomBytes(32).toString('base64url')
    const refreshToken = randomBytes(32).toString('base64url')
    const session = {
      id: `sess_${randomUUID()}`,
      userId: user.id,
      deviceId,
      epoch: 1,
      refreshHash: hashToken(refreshToken),
      refreshExpiresAt: now() + REFRESH_TTL_MS,
      revokedAt: null
    }
    store.sessions.set(session.id, session)
    store.accessTokens.set(accessToken, {
      sessionId: session.id,
      userId: user.id,
      epoch: session.epoch,
      expiresAt: now() + ACCESS_TTL_MS
    })
    store.refreshTokens.set(refreshToken, session.id)
    return { accessToken, refreshToken }
  }

  function bumpEpoch(sessionId: string): void {
    const session = store.sessions.get(sessionId)
    if (session) session.epoch += 1
  }

  function projectView(p: Project, user: User): Record<string, unknown> {
    const permissions = store.effectivePermissions(p.id, user)
    return {
      id: p.id,
      key: p.key,
      name: p.name,
      repoUrl: p.repoUrl,
      hostId: p.hostId,
      hostName: store.hosts.get(p.hostId)?.name ?? null,
      hostStatus: store.hosts.get(p.hostId)?.status ?? 'offline',
      path: p.path,
      defaultBranch: p.defaultBranch,
      downloadPolicy: p.downloadPolicy,
      status: p.status,
      createdAt: p.createdAt,
      permissions
    }
  }

  function visibleProject(projectId: string, user: User): Project | null {
    const p = store.projects.get(projectId)
    if (!p || p.status === 'archived') return null
    const permissions = store.effectivePermissions(p.id, user)
    if (!permissions.includes('open')) return null
    return p
  }

  function hostOnline(h: Host): boolean {
    return h.status === 'online' && now() - h.lastHeartbeatAt <= HOST_OFFLINE_MS
  }

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    fromInternalChannel = false
  ): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    const traceId = req.headers['x-trace-id']?.toString() ?? randomUUID()

    // Second line of defence behind the WAF allowlist: once a dedicated mTLS
    // channel exists, control-plane reads are only served there (review-06 N6).
    // Without one (local dev / tests), the public listener is the control channel.
    if (
      !fromInternalChannel &&
      config.internalTls &&
      path.startsWith('/v1/internal/') &&
      path !== '/v1/internal/relay-endpoint'
    ) {
      return error(res, 404, 'NOT_FOUND', '接口不存在。', traceId)
    }

    if (path === '/health') return json(res, 200, { ok: true, time: now() })

    if (req.method === 'GET' && !path.startsWith('/v1/') && path !== '/health') {
      return serveStatic(path, res)
    }

    // ---- auth ----
    if (req.method === 'POST' && path === '/v1/auth/login') {
      const body = await readJson(req)
      const username = String(body.username ?? '')
      const password = String(body.password ?? '')
      if (store.isLocked(username, now())) {
        audit.append({
          eventType: 'login',
          actor: username,
          targetType: 'session',
          targetId: null,
          result: 'failure',
          traceId,
          metadata: { reason: 'locked' }
        })
        return error(res, 423, 'ACCOUNT_LOCKED', '账号已锁定，请 15 分钟后再试。', traceId)
      }
      const result = await ldap.authenticate(username, password)
      if (!result.ok) {
        const failure = store.recordLoginFailure(username, now())
        audit.append({
          eventType: 'login',
          actor: username,
          targetType: 'session',
          targetId: null,
          result: 'failure',
          traceId,
          metadata: { reason: result.reason, locked: failure.locked }
        })
        if (failure.locked) {
          return error(res, 423, 'ACCOUNT_LOCKED', '连续 5 次失败，账号已锁定 15 分钟。', traceId)
        }
        return error(res, 401, 'INVALID_CREDENTIALS', '账号或密码错误。', traceId)
      }
      store.clearLoginFailures(username)
      let user = store.usersByName.get(username)
      if (!user) {
        user = store.seedUser({
          username,
          displayName: result.profile.displayName,
          dept: result.profile.dept,
          email: result.profile.email,
          groups: result.profile.groups,
          roles: result.profile.groups.includes('platform-admins')
            ? ['platform:admin', 'developer']
            : ['developer'],
          status: 'active'
        })
      }
      user.groups = [...new Set([...user.groups, ...result.profile.groups])]
      const devicePubKey = String(body.devicePubKey ?? '')
      const deviceName = String(body.deviceName ?? 'unknown')
      const existingDevice = body.deviceId ? store.devices.get(String(body.deviceId)) : undefined
      const device =
        existingDevice && existingDevice.userId === user.id && !existingDevice.revokedAt
          ? existingDevice
          : store.createDevice(user.id, deviceName, devicePubKey)
      const tokens = issueSession(user, device.id)
      audit.append({
        eventType: 'login',
        actor: user.username,
        targetType: 'session',
        targetId: device.id,
        result: 'success',
        traceId
      })
      const permissions = user.roles.flatMap((r) => ROLE_PERMISSIONS[r] ?? [])
      return json(res, 200, {
        ...tokens,
        user: {
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          dept: user.dept,
          roles: user.roles,
          permissions
        },
        device: { id: device.id, name: device.name }
      })
    }

    if (req.method === 'POST' && path === '/v1/auth/refresh') {
      const body = await readJson(req)
      const token = String(body.refreshToken ?? '')
      const sessionId = store.refreshTokens.get(token)
      const session = sessionId ? store.sessions.get(sessionId) : undefined
      if (!session || session.revokedAt || session.refreshExpiresAt < now()) {
        return error(res, 401, 'SESSION_EXPIRED', '会话已失效，请重新登录。', traceId)
      }
      if (!safeEqual(session.refreshHash, hashToken(token))) {
        session.revokedAt = now()
        return error(res, 401, 'SESSION_EXPIRED', '会话已失效，请重新登录。', traceId)
      }
      store.refreshTokens.delete(token)
      const accessToken = randomBytes(32).toString('base64url')
      const refreshToken = randomBytes(32).toString('base64url')
      session.refreshHash = hashToken(refreshToken)
      session.refreshExpiresAt = now() + REFRESH_TTL_MS
      store.accessTokens.set(accessToken, {
        sessionId: session.id,
        userId: session.userId,
        epoch: session.epoch,
        expiresAt: now() + ACCESS_TTL_MS
      })
      store.refreshTokens.set(refreshToken, session.id)
      return json(res, 200, { accessToken, refreshToken })
    }

    if (req.method === 'POST' && path === '/v1/auth/logout') {
      const auth = resolveToken(req)
      if (auth) {
        const session = store.sessions.get(auth.sessionId)
        if (session) {
          session.revokedAt = now()
          bumpEpoch(session.id)
        }
        audit.append({
          eventType: 'logout',
          actor: auth.user.username,
          targetType: 'session',
          targetId: auth.sessionId,
          result: 'success',
          traceId
        })
      }
      return json(res, 200, { ok: true })
    }

    const auth = resolveToken(req)
    const requireAuth = (): AuthedRequest | null => {
      if (!auth) error(res, 401, 'SESSION_EXPIRED', '登录已过期，请重新登录。', traceId)
      return auth
    }

    if (req.method === 'GET' && path === '/v1/me') {
      const authed = requireAuth()
      if (!authed) return
      return json(res, 200, {
        user: {
          id: authed.user.id,
          username: authed.user.username,
          displayName: authed.user.displayName,
          dept: authed.user.dept,
          roles: authed.user.roles,
          permissions: authed.user.roles.flatMap((r) => ROLE_PERMISSIONS[r] ?? [])
        }
      })
    }

    if (req.method === 'GET' && path === '/v1/me/devices') {
      const authed = requireAuth()
      if (!authed) return
      const devices = [...store.devices.values()].filter((d) => d.userId === authed.user.id)
      return json(res, 200, {
        devices: devices.map((d) => ({ id: d.id, name: d.name, revokedAt: d.revokedAt }))
      })
    }

    const deviceRevoke = path.match(/^\/v1\/me\/devices\/([\w-]+)$/)
    if (req.method === 'DELETE' && deviceRevoke) {
      const authed = requireAuth()
      if (!authed) return
      const device = store.devices.get(deviceRevoke[1])
      if (!device || device.userId !== authed.user.id) {
        return error(res, 404, 'NOT_FOUND', '设备不存在。', traceId)
      }
      device.revokedAt = now()
      for (const session of store.sessions.values()) {
        if (session.deviceId === device.id && !session.revokedAt) {
          session.revokedAt = now()
          bumpEpoch(session.id)
        }
      }
      // Established WSS sessions bypass the platform, so revocation must reach hosts too.
      appendRevocation('device', device.id, 'device_revoked')
      audit.append({
        eventType: 'device_revoke',
        actor: authed.user.username,
        targetType: 'device',
        targetId: device.id,
        result: 'success',
        traceId
      })
      return json(res, 200, { ok: true })
    }

    if (req.method === 'GET' && path === '/v1/client/config') {
      return json(res, 200, {
        managed: true,
        minClientVersion: '1.5.0',
        supportsDirect: true,
        failoverBudget: 1
      })
    }

    if (req.method === 'GET' && path === '/v1/jwks') {
      return json(res, 200, { keys: [...jwks.values()] })
    }

    // ---- projects ----
    if (req.method === 'GET' && path === '/v1/projects') {
      const authed = requireAuth()
      if (!authed) return
      const visible = [...store.projects.values()]
        .filter(
          (p) =>
            p.status !== 'archived' &&
            (isAdmin(authed.user) || store.effectivePermissions(p.id, authed.user).includes('open'))
        )
        .map((p) => projectView(p, authed.user))
      return json(res, 200, { projects: visible })
    }

    if (req.method === 'POST' && path === '/v1/projects') {
      const authed = requireAuth()
      if (!authed) return
      if (!isAdmin(authed.user)) {
        audit.append({
          eventType: 'project_create',
          actor: authed.user.username,
          targetType: 'project',
          targetId: null,
          result: 'denied',
          traceId
        })
        return error(res, 403, 'PERMISSION_DENIED', '需要平台管理权限。', traceId)
      }
      const body = await readJson(req)
      const hostId = String(body.hostId ?? '')
      const target = store.hosts.get(hostId)
      if (!target) return error(res, 400, 'HOST_NOT_FOUND', '主机不存在。', traceId)
      const key = String(body.key ?? '')
      if (store.projectsByKey.has(key)) {
        return error(res, 409, 'PROJECT_EXISTS', '项目 Key 已存在。', traceId)
      }
      // A signed root carrying `..` would grant a directory nobody chose: the host
      // normalises the same way, so `/srv/a/../../etc` becomes `/etc` for everyone.
      const pathVerdict = validateProjectPath(body.path)
      if (!pathVerdict.ok) {
        audit.append({
          eventType: 'project_create',
          actor: authed.user.username,
          targetType: 'project',
          targetId: null,
          result: 'denied',
          traceId,
          metadata: { reason: pathVerdict.code, path: String(body.path ?? '') }
        })
        return error(res, 400, pathVerdict.code, pathVerdict.message, traceId)
      }
      const created: Project = {
        id: `proj_${randomBytes(4).toString('hex')}`,
        key,
        name: String(body.name ?? key),
        repoUrl: String(body.repoUrl ?? ''),
        hostId,
        path: pathVerdict.path,
        defaultBranch: String(body.defaultBranch ?? 'main'),
        downloadPolicy: body.downloadPolicy === 'allow' ? 'allow' : 'deny',
        status: 'ready',
        createdAt: now()
      }
      store.projects.set(created.id, created)
      store.projectsByKey.set(created.key, created)
      audit.append({
        eventType: 'project_create',
        actor: authed.user.username,
        targetType: 'project',
        targetId: created.id,
        result: 'success',
        traceId,
        metadata: { key: created.key, path: created.path }
      })
      return json(res, 201, projectView(created, authed.user))
    }

    const projectPath = path.match(/^\/v1\/projects\/([\w-]+)(\/[a-z]+)?$/)
    if (projectPath) {
      const authed = requireAuth()
      if (!authed) return
      const projectId = projectPath[1]
      const action = projectPath[2] ?? ''
      const found = store.projects.get(projectId)
      // 404 for both unknown and unauthorised: never leak existence.
      const adminAccess = isAdmin(authed.user) || authed.user.roles.includes('platform:auditor')
      if (!found || (!adminAccess && !store.effectivePermissions(found.id, authed.user).includes('open'))) {
        audit.append({
          eventType: 'project_access',
          actor: authed.user.username,
          targetType: 'project',
          targetId: projectId,
          result: 'denied',
          traceId
        })
        return error(res, 404, 'PROJECT_NOT_FOUND', '项目不存在或无权访问。', traceId)
      }

      if (req.method === 'GET' && action === '') return json(res, 200, projectView(found, authed.user))

      if (req.method === 'POST' && action === '/connect') {
        return handleConnect(req, res, authed.user, found, traceId)
      }

      if (req.method === 'GET' && action === '/grants') {
        const grants = store.grants.filter((g) => g.projectId === projectId)
        return json(res, 200, { grants })
      }

      if (req.method === 'PUT' && action === '/grants') {
        if (!isAdmin(authed.user) && !authed.user.roles.includes('project:owner')) {
          return error(res, 403, 'PERMISSION_DENIED', '需要平台管理权限。', traceId)
        }
        const body = await readJson(req)
        const subjectType = body.subjectType === 'group' ? 'group' : 'user'
        const subjectId = String(body.subjectId ?? '')
        const permissions = Array.isArray(body.permissions) ? (body.permissions as Permission[]) : []
        store.grants = store.grants.filter(
          (g) => !(g.projectId === projectId && g.subjectType === subjectType && g.subjectId === subjectId)
        )
        if (permissions.length > 0) {
          store.grants.push({ projectId, subjectType, subjectId, permissions })
        }
        revokeProjectCredentials(projectId, 'grant_changed')
        audit.append({
          eventType: 'grant_update',
          actor: authed.user.username,
          targetType: 'project',
          targetId: projectId,
          result: 'success',
          traceId,
          metadata: { subjectType, subjectId, permissions }
        })
        return json(res, 200, { ok: true })
      }

      if (req.method === 'POST' && (action === '/archive' || action === '/restore')) {
        if (!isAdmin(authed.user)) {
          return error(res, 403, 'PERMISSION_DENIED', '需要平台管理权限。', traceId)
        }
        found.status = action === '/archive' ? 'archived' : 'ready'
        audit.append({
          eventType: action === '/archive' ? 'project_archive' : 'project_restore',
          actor: authed.user.username,
          targetType: 'project',
          targetId: projectId,
          result: 'success',
          traceId
        })
        return json(res, 200, projectView(found, authed.user))
      }

      if (req.method === 'GET' && action === '/policy') {
        return json(res, 200, {
          downloadPolicy: found.downloadPolicy,
          effective: found.downloadPolicy,
          globalDefault: store.policies.downloadDefault,
          version: store.policies.version
        })
      }

      if (req.method === 'PUT' && action === '/policy') {
        if (!isAdmin(authed.user)) {
          return error(res, 403, 'PERMISSION_DENIED', '需要平台管理权限。', traceId)
        }
        const body = await readJson(req)
        found.downloadPolicy = body.downloadPolicy === 'allow' ? 'allow' : 'deny'
        store.policies.version += 1
        audit.append({
          eventType: 'policy_update',
          actor: authed.user.username,
          targetType: 'project',
          targetId: projectId,
          result: 'success',
          traceId,
          metadata: { downloadPolicy: found.downloadPolicy, version: store.policies.version }
        })
        return json(res, 200, { downloadPolicy: found.downloadPolicy, version: store.policies.version })
      }
    }

    // ---- hosts ----
    if (req.method === 'GET' && path === '/v1/hosts') {
      const authed = requireAuth()
      if (!authed) return
      if (!isAdmin(authed.user)) {
        return error(res, 403, 'PERMISSION_DENIED', '需要平台管理权限。', traceId)
      }
      return json(res, 200, {
        hosts: [...store.hosts.values()].map((h) => ({
          ...h,
          credentialHash: undefined,
          online: hostOnline(h)
        }))
      })
    }

    if (req.method === 'POST' && path === '/v1/hosts/tokens') {
      const authed = requireAuth()
      if (!authed) return
      if (!isAdmin(authed.user)) {
        return error(res, 403, 'PERMISSION_DENIED', '需要平台管理权限。', traceId)
      }
      const token = randomBytes(24).toString('base64url')
      store.hostTokens.push({ tokenHash: hashToken(token), expiresAt: now() + 24 * 60 * 60_000, usedAt: null })
      audit.append({
        eventType: 'host_token_create',
        actor: authed.user.username,
        targetType: 'host',
        targetId: null,
        result: 'success',
        traceId
      })
      return json(res, 201, { token, expiresIn: 86400 })
    }

    if (req.method === 'POST' && path === '/v1/hosts/register') {
      const bearer = req.headers.authorization?.slice(7) ?? ''
      const entry = store.hostTokens.find((t) => safeEqual(t.tokenHash, hashToken(bearer)))
      if (!entry || entry.usedAt || entry.expiresAt < now()) {
        return error(res, 401, 'HOST_TOKEN_INVALID', '注册令牌无效或已使用。', traceId)
      }
      const body = await readJson(req)
      entry.usedAt = now()
      const name = String(body.name ?? '')
      const existing = store.hostsByName.get(name)
      const credential = randomBytes(32).toString('base64url')
      const target: Host = existing ?? {
        id: `host_${randomBytes(4).toString('hex')}`,
        name,
        fingerprint: '',
        tlsFingerprint: null,
        e2eePublicKey: '',
        orcaVersion: '',
        protocolVersion: 3,
        zone: 'intranet',
        directAddrs: [],
        relayRoute: null,
        capabilities: [],
        status: 'online',
        maintenanceReason: null,
        lastHeartbeatAt: now(),
        credentialHash: null
      }
      target.fingerprint = String(body.fingerprint ?? '')
      target.tlsFingerprint = String(body.tlsFingerprint ?? '') || null
      target.e2eePublicKey = String(body.e2eePublicKeyB64 ?? '')
      target.orcaVersion = String(body.orcaVersion ?? '')
      target.protocolVersion = Number(body.protocolVersion ?? 3)
      target.zone = String(body.networkZone ?? 'intranet')
      target.directAddrs = Array.isArray(body.directAddrs) ? (body.directAddrs as string[]) : []
      target.relayRoute = String(body.relayRoute ?? '') || null
      target.capabilities = Array.isArray(body.runtimeCapabilities)
        ? (body.runtimeCapabilities as string[])
        : []
      target.status = 'online'
      target.lastHeartbeatAt = now()
      target.credentialHash = hashToken(credential)
      store.hosts.set(target.id, target)
      store.hostsByName.set(target.name, target)
      const relayTarget = String(body.relayTarget ?? '')
      const routeTarget = relayTarget || target.directAddrs[0]
      if (target.relayRoute && routeTarget) {
        store.relayRoutes.set(target.relayRoute, {
          routeKey: target.relayRoute,
          hostId: target.id,
          target: routeTarget,
          version: store.policies.version
        })
      }
      audit.append({
        eventType: 'host_register',
        actor: 'agent',
        targetType: 'host',
        targetId: target.id,
        result: 'success',
        traceId,
        metadata: { name, zone: target.zone }
      })
      return json(res, 201, {
        hostId: target.id,
        credential,
        policyVersion: store.policies.version
      })
    }

    const hostAction = path.match(/^\/v1\/hosts\/([\w-]+)(\/[a-z]+)?$/)
    if (hostAction) {
      const authed = resolveToken(req)
      const hostId = hostAction[1]
      const action = hostAction[2] ?? ''
      const target = store.hosts.get(hostId)
      if (!target) return error(res, 404, 'HOST_NOT_FOUND', '主机不存在。', traceId)

      if (req.method === 'POST' && action === '/heartbeat') {
        const bearer = req.headers.authorization?.slice(7) ?? ''
        if (!target.credentialHash || !safeEqual(target.credentialHash, hashToken(bearer))) {
          return error(res, 401, 'HOST_CREDENTIAL_INVALID', '主机凭证无效。', traceId)
        }
        const body = await readJson(req)
        if (Array.isArray(body.directAddrs) && body.directAddrs.length > 0) {
          target.directAddrs = body.directAddrs as string[]
        }
        // A host learns its own E2EE key only once its runtime has started, so the
        // heartbeat is where it first becomes reportable.
        if (typeof body.e2eePublicKeyB64 === 'string' && body.e2eePublicKeyB64.length > 0) {
          target.e2eePublicKey = body.e2eePublicKeyB64
        }
        if (typeof body.status === 'string' && target.status !== 'maintenance') {
          target.status = body.status === 'online' ? 'online' : 'offline'
        }
        target.lastHeartbeatAt = now()
        const revoked = store.revocations.filter((r) => r.targetType !== 'jti')
        return json(res, 200, {
          policyVersion: store.policies.version,
          policies: {
            downloadDefault: store.policies.downloadDefault,
            projectOverrides: Object.fromEntries(
              [...store.projects.values()].map((p) => [p.id, p.downloadPolicy])
            )
          },
          revoked: {
            users: revoked
              .filter((r) => r.targetType === 'user')
              .map((r) => ({ id: r.targetId, since: r.at })),
            projects: revoked
              .filter((r) => r.targetType === 'project')
              .map((r) => ({ id: r.targetId, since: r.at })),
            devices: revoked
              .filter((r) => r.targetType === 'device')
              .map((r) => ({ id: r.targetId, since: r.at })),
            jtis: store.revocations.filter((r) => r.targetType === 'jti').map((r) => r.targetId)
          },
          maintenance: target.status === 'maintenance' ? { reason: target.maintenanceReason } : null,
          serverTime: now()
        })
      }

      if (req.method === 'POST' && action === '/maintenance') {
        if (!authed || !isAdmin(authed.user)) {
          return error(res, 403, 'PERMISSION_DENIED', '需要平台管理权限。', traceId)
        }
        const body = await readJson(req)
        target.status = body.enabled === false ? 'online' : 'maintenance'
        target.maintenanceReason = body.reason ? String(body.reason) : '计划维护'
        audit.append({
          eventType: 'host_maintenance',
          actor: authed.user.username,
          targetType: 'host',
          targetId: hostId,
          result: 'success',
          traceId,
          metadata: { enabled: target.status === 'maintenance', reason: target.maintenanceReason }
        })
        return json(res, 200, { status: target.status })
      }

      if (req.method === 'DELETE' && action === '') {
        if (!authed || !isAdmin(authed.user)) {
          return error(res, 403, 'PERMISSION_DENIED', '需要平台管理权限。', traceId)
        }
        target.status = 'offline'
        target.credentialHash = null
        if (target.relayRoute) store.relayRoutes.delete(target.relayRoute)
        for (const p of store.projects.values()) {
          if (p.hostId === hostId) revokeProjectCredentials(p.id, 'host_revoked')
        }
        audit.append({
          eventType: 'host_revoke',
          actor: authed.user.username,
          targetType: 'host',
          targetId: hostId,
          result: 'success',
          traceId
        })
        return json(res, 200, { ok: true })
      }
    }

    // ---- audit ----
    if (req.method === 'GET' && path === '/v1/audit/events') {
      const authed = requireAuth()
      if (!authed) return
      if (!isAdmin(authed.user) && !authed.user.roles.includes('platform:auditor')) {
        return error(res, 403, 'PERMISSION_DENIED', '需要审计权限。', traceId)
      }
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 200)
      const sinceParam = url.searchParams.get('since')
      const since = sinceParam ? Date.parse(sinceParam) : undefined
      if (since && now() - since > 31 * 24 * 60 * 60_000) {
        return error(res, 400, 'TIME_WINDOW_TOO_LARGE', '查询时间窗最大 31 天。', traceId)
      }
      const page = audit.query({
        actor: url.searchParams.get('actor') ?? undefined,
        eventType: url.searchParams.get('eventType') ?? undefined,
        result: url.searchParams.get('result') ?? undefined,
        since,
        limit,
        cursor: url.searchParams.get('cursor') ? Number(url.searchParams.get('cursor')) : undefined
      })
      return json(res, 200, page)
    }

    // ---- policies ----
    if (path === '/v1/policies/download') {
      const authed = requireAuth()
      if (!authed) return
      if (req.method === 'GET') {
        return json(res, 200, {
          downloadDefault: store.policies.downloadDefault,
          version: store.policies.version
        })
      }
      if (req.method === 'PUT') {
        if (!isAdmin(authed.user)) return error(res, 403, 'PERMISSION_DENIED', '需要平台管理权限。', traceId)
        const body = await readJson(req)
        store.policies.downloadDefault = body.downloadDefault === 'allow' ? 'allow' : 'deny'
        store.policies.version += 1
        audit.append({
          eventType: 'policy_update',
          actor: authed.user.username,
          targetType: 'policy',
          targetId: 'download',
          result: 'success',
          traceId,
          metadata: { downloadDefault: store.policies.downloadDefault }
        })
        return json(res, 200, { downloadDefault: store.policies.downloadDefault, version: store.policies.version })
      }
    }

    if (path === '/v1/internal/relay-endpoint' && req.method === 'POST') {
      const token = req.headers['x-internal-token']
      if (token !== internalToken) {
        return error(res, 401, 'INTERNAL_TOKEN_INVALID', '内部令牌无效。', traceId)
      }
      const body = await readJson(req)
      relayPort = Number(body.port)
      return json(res, 200, { ok: true, relayPort })
    }

    if (path === '/v1/internal/revocations' && req.method === 'GET') {
      const token = req.headers['x-internal-token']
      if (token !== internalToken) {
        return error(res, 401, 'INTERNAL_TOKEN_INVALID', '内部令牌无效。', traceId)
      }
      return json(res, 200, {
        projects: store.revocations
          .filter((r) => r.targetType === 'project')
          .map((r) => ({ id: r.targetId, since: r.at })),
        users: store.revocations
          .filter((r) => r.targetType === 'user')
          .map((r) => ({ id: r.targetId, since: r.at })),
        devices: store.revocations
          .filter((r) => r.targetType === 'device')
          .map((r) => ({ id: r.targetId, since: r.at })),
        jtis: store.revocations.filter((r) => r.targetType === 'jti').map((r) => r.targetId)
      })
    }

    if (path === '/v1/internal/policy' && req.method === 'GET') {
      const token = req.headers['x-internal-token']
      if (token !== internalToken) {
        return error(res, 401, 'INTERNAL_TOKEN_INVALID', '内部令牌无效。', traceId)
      }
      return json(res, 200, {
        version: store.policies.version,
        downloadDefault: store.policies.downloadDefault,
        projectOverrides: Object.fromEntries(
          [...store.projects.values()].map((p) => [p.id, p.downloadPolicy])
        )
      })
    }

    // ---- relay routes (internal) ----
    if (path === '/v1/internal/relay-routes') {
      const token = req.headers['x-internal-token']
      if (token !== internalToken) {
        return error(res, 401, 'INTERNAL_TOKEN_INVALID', '内部令牌无效。', traceId)
      }
      if (req.method === 'GET') {
        return json(res, 200, {
          version: store.policies.version,
          routes: [...store.relayRoutes.values()]
        })
      }
    }

    return error(res, 404, 'NOT_FOUND', '接口不存在。', traceId)
  }

  async function handleConnect(
    req: IncomingMessage,
    res: ServerResponse,
    user: User,
    project: Project,
    traceId: string
  ): Promise<void> {
    const body = await readJson(req)
    const host = store.hosts.get(project.hostId)
    if (!host) return error(res, 404, 'HOST_NOT_FOUND', '主机不存在。', traceId)
    if (host.status === 'maintenance') {
      return error(res, 409, 'HOST_MAINTENANCE', '主机维护中，暂时无法打开项目。', traceId, {
        reason: host.maintenanceReason
      })
    }
    if (!hostOnline(host)) {
      return error(res, 409, 'HOST_OFFLINE', '开发机已离线，暂时无法打开项目。', traceId, {
        lastHeartbeatAt: new Date(host.lastHeartbeatAt).toISOString()
      })
    }
    const minClientVersion = '1.5.0'
    const offeredVersion = String(body.clientVersion ?? '0.0.0')
    const compareVersions = (a: string, b: string): number => {
      const pa = a.split('.').map((n) => Number(n) || 0)
      const pb = b.split('.').map((n) => Number(n) || 0)
      for (let i = 0; i < 3; i++) {
        if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
      }
      return 0
    }
    const clientVersionCheck = {
      min: minClientVersion,
      offered: offeredVersion,
      ok: compareVersions(offeredVersion, minClientVersion) >= 0
    }
    if (!clientVersionCheck.ok) {
      audit.append({
        eventType: 'project_connect',
        actor: user.username,
        targetType: 'project',
        targetId: project.id,
        result: 'denied',
        traceId,
        metadata: { reason: 'VERSION_UNSUPPORTED', offered: offeredVersion, min: minClientVersion }
      })
      return error(res, 426, 'VERSION_UNSUPPORTED', '客户端版本过低，请升级后重试。', traceId, {
        min: minClientVersion,
        offered: offeredVersion
      })
    }
    const permissions = store.effectivePermissions(project.id, user)
    const devicePubKey = String(body.devicePubKey ?? '')
    const deviceId = String(body.deviceId ?? '')
    const device = store.devices.get(deviceId)
    if (!device || device.userId !== user.id || device.revokedAt) {
      return error(res, 401, 'DEVICE_NOT_REGISTERED', '设备未登记，请重新登录。', traceId)
    }
    if (devicePubKey && device.publicKey && device.publicKey !== devicePubKey) {
      return error(res, 401, 'DEVICE_KEY_MISMATCH', '设备公钥与登记信息不一致。', traceId)
    }
    const jti = newJti()
    const nowS = Math.floor(now() / 1000)
    const payload: CredentialPayload = {
      v: 1,
      jti,
      sub: `user:${user.username}`,
      aud: `host:${host.name}`,
      host: host.id,
      project: project.id,
      projectRoot: project.path,
      workspaceRoot: `${project.path}/.orca-worktrees/${user.username}`,
      deviceId: device.id,
      devicePubKey: device.publicKey || devicePubKey,
      deviceToken: newDeviceToken(),
      perms: permissions,
      iat: nowS,
      iatMs: now(),
      exp: nowS + CREDENTIAL_TTL_S
    }
    const credential = signCredential(payload, signingKey)
    audit.append({
      eventType: 'project_connect',
      actor: user.username,
      targetType: 'project',
      targetId: project.id,
      result: 'success',
      traceId,
      metadata: { hostId: host.id, jti }
    })
    return json(res, 200, {
      credential,
      expiresIn: CREDENTIAL_TTL_S,
      host: {
        id: host.id,
        name: host.name,
        fingerprint: host.fingerprint,
        tlsFingerprint: host.tlsFingerprint ?? host.fingerprint,
        e2eePublicKeyB64: host.e2eePublicKey,
        capabilities: host.capabilities
      },
      endpoints: {
        direct: host.directAddrs.map((url, index) => ({
          priority: index + 1,
          url: `wss://${url}`
        })),
        relay: host.relayRoute
          ? [
              {
                priority: 99,
                url: `wss://127.0.0.1:${relayPort}/`,
                routeKey: host.relayRoute,
                sni: `${host.relayRoute}.relay.local`
              }
            ]
          : []
      },
      workspace: {
        projectRoot: project.path,
        workspaceRoot: `${project.path}/.orca-worktrees/${user.username}`,
        defaultBranch: project.defaultBranch,
        existingWorktreeId: null
      },
      clientVersionCheck: clientVersionCheck
    })
  }

  /** Bounded by distinct targets: re-revoking refreshes the timestamp instead of growing the list. */
  function appendRevocation(
    targetType: 'project' | 'device' | 'user' | 'jti',
    targetId: string,
    reason: string
  ): void {
    const existing = store.revocations.find(
      (r) => r.targetType === targetType && r.targetId === targetId
    )
    if (existing) {
      existing.at = now()
      existing.reason = reason
      return
    }
    store.revocations.push({ targetType, targetId, reason, at: now() })
  }

  function revokeProjectCredentials(projectId: string, reason: string): void {
    appendRevocation('project', projectId, reason)
  }

  let relayPort = 18080

  async function serveStatic(path: string, res: ServerResponse): Promise<void> {
    const rel = path === '/' ? 'index.html' : decodeURIComponent(path).replace(/^\//, '')
    const target = join(WEB_ROOT, normalize(rel).replace(/^(\.\.[/\\])+/, ''))
    try {
      const data = await readFile(target)
      const type =
        extname(target) === '.css'
          ? 'text/css; charset=utf-8'
          : extname(target) === '.js'
            ? 'text/javascript; charset=utf-8'
            : 'text/html; charset=utf-8'
      res.writeHead(200, { 'content-type': type })
      res.end(data)
    } catch {
      res.writeHead(404)
      res.end('not found')
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      error(res, 500, 'INTERNAL_ERROR', err instanceof Error ? err.message : 'unknown error')
    })
  })

  const isInternalPath = (path: string): boolean => path.startsWith('/v1/internal/')
  let internalChannel: { port: number; close: () => Promise<void> } | null = null

  return {
    setRelayPort(port: number) {
      relayPort = port
    },
    internalPort: () => internalChannel?.port ?? null,
    store,
    audit,
    signingKey,
    close: async () => {
      await internalChannel?.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
    listen: async () => {
      if (config.internalTls) {
        internalChannel = await startInternalChannel({
          ...config.internalTls,
          handler: (req, res) => {
            const path = new URL(req.url ?? '/', 'https://internal').pathname
            if (!isInternalPath(path)) {
              res.writeHead(404, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ error: { code: 'NOT_FOUND' } }))
              return Promise.resolve()
            }
            // mTLS already authenticated the peer; the bearer token check still applies.
            return handle(req, res, true)
          }
        })
      }
      return new Promise<number>((resolve) => {
        server.listen(config.port, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
      })
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = createApp({
    port: Number(process.env.PORT ?? 18787),
    internalTls:
      process.env.INTERNAL_TLS_KEY && process.env.INTERNAL_TLS_CERT && process.env.INTERNAL_TLS_CA
        ? {
            port: Number(process.env.INTERNAL_TLS_PORT ?? 0),
            keyPath: process.env.INTERNAL_TLS_KEY,
            certPath: process.env.INTERNAL_TLS_CERT,
            caPath: process.env.INTERNAL_TLS_CA,
            allowedCNs: (process.env.INTERNAL_TLS_ALLOWED_CNS ?? '').split(',').filter(Boolean)
          }
        : undefined
  })
  app.setRelayPort(Number(process.env.RELAY_PORT ?? 18080))
  const port = await app.listen()
  const internal = app.internalPort()
  if (internal) {
    console.log(`[api] ready public=${port} internal=${internal}`)
  } else {
    console.log(`[api] ready public=${port} internal=none`)
  }
  console.log(`[api] listening on http://127.0.0.1:${port} (kid=${app.signingKey.kid})`)
  if (internal) console.log(`[api] internal mTLS on https://127.0.0.1:${internal}`)
}
