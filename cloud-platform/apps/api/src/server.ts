import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { validateProjectPath } from '../../../packages/contract/src/project-path.ts'
import { validateProjectRepoUrl } from '../../../packages/contract/src/repo-url.ts'
import { validateProjectDefaultBranch } from '../../../packages/contract/src/branch-name.ts'
import {
  projectKeyFromName,
  validateProjectKey
} from '../../../packages/contract/src/project-key.ts'
import {
  SELF_SERVICE_PROJECT_LIMIT,
  countActiveProjectsCreatedBy,
  joinProjectPath,
  parseProjectDirs,
  selectSelfServiceHost,
  validateProjectDir
} from './project-self-service.ts'
import { isProjectCreator, projectKeyTaken, projectPathTaken } from './project-occupancy.ts'
import {
  newDeviceToken,
  newJti,
  signCredential,
  type CredentialPayload,
  type Permission,
  type SigningKey
} from '../../../packages/contract/src/credential.ts'
import { AuditChain } from './audit.ts'
import { createRemoteAudit, type AuditSink } from './audit-writer-client.ts'
import { createSigningKeyRing } from './signing-key-ring.ts'
import type { AuditEventInput } from './store.ts'
import { openAuditLogFile } from './audit-log-file.ts'
import { startInternalChannel } from './internal-channel.ts'
import { ldapProfile, MockLdapAdapter, type LdapAdapter } from './ldap.ts'
import { Store, type Device, type Host, type Project, type User } from './store.ts'
import { parseReadRate } from './policy-rate.ts'
import { appendHostAuditReports, parseHostAuditReports } from './host-audit-ingest.ts'
import {
  createWebReleaseStore,
  MIN_WEB_CONTRACT_VERSION,
  WEB_CONTRACT_VERSION
} from './web-release.ts'
import { checkWebContract, readWebContract } from './web-contract.ts'
import {
  createRelayNodeRegistry,
  parseRelayRegistration,
  routeKeyFromDirectAddrs,
  BROWSER_ROUTE_KEY_PATTERN,
  RELAY_ALIVE_DEFAULT_MS
} from './relay-nodes.ts'
import {
  createRemoteLoginLockout,
  lockoutUnavailable,
  type LoginLockout,
  type LockoutState
} from './login-lockout-client.ts'

const ACCESS_TTL_MS = 30 * 60_000
const REFRESH_TTL_MS = 12 * 60 * 60_000
const CREDENTIAL_TTL_S = 60
const HOST_OFFLINE_DEFAULT_MS = 60_000
/** U37: per-beat cap on the heartbeat's provision kick; the rest waits for the next beat. */
const MAX_PROVISION_ASSIGNMENTS_PER_BEAT = 16
const HANDOFF_TTL_MS = 60_000
const WEB_ROOT = new URL('../../web/', import.meta.url).pathname

export type ApiConfig = {
  port: number
  ldap?: LdapAdapter
  now?: () => number
  internalToken?: string
  /** Access-token lifetime; tests shrink it to exercise expiry. */
  accessTtlMs?: number
  /** Refresh-token lifetime; tests shrink it to exercise expiry. */
  refreshTtlMs?: number
  /** How long a host stays "online" without a heartbeat; tests shrink it to observe the flip. */
  hostOfflineMs?: number
  /** One-time web-handoff code lifetime (FR-3.10); tests shrink it to exercise expiry. */
  handoffTtlMs?: number
  /** Append-only audit log; absent keeps the chain in memory (tests). */
  auditLogPath?: string
  /** Single audit writer shared by replicas; absent keeps the local chain. */
  auditWriterUrl?: string
  /** Leader first, then standbys; replicas fail over on their own. */
  auditWriterUrls?: string[]
  /** Shared login-lockout counter; absent counts in this process only. */
  loginLockoutUrl?: string
  /** Frontend directory; tests point this at a copy to simulate a new release. */
  webRoot?: string
  /** Where superseded frontend builds are kept so cached old pages still load. */
  webReleaseArchiveDir?: string
  /** Enables the dedicated mTLS listener for platform → relay/runtime control traffic. */
  internalTls?: {
    port: number
    keyPath: string
    certPath: string
    caPath: string
    allowedCNs?: string[]
  }
  /**
   * Optional TLS on the public listener (U41): when set, the public port speaks
   * HTTPS with the same routes and handler — a pure transport swap, so an HTTPS
   * host page can call this API without Mixed Content blocking. Absent keeps HTTP.
   */
  publicTls?: { certPath: string; keyPath: string }
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

function e2eeKeyFingerprint(e2eePublicKeyB64: string): string {
  const digest = createHash('sha256').update(Buffer.from(e2eePublicKeyB64, 'base64')).digest('hex')
  return `sha256:${digest.slice(0, 16)}`
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** The audit records a handoff code's fingerprint, never the code itself (FR-3.10). */
function codeFingerprint(code: string): string {
  return `sha256:${createHash('sha256').update(code).digest('hex').slice(0, 16)}`
}

/**
 * A direct address must be a bare `host[:port]` (IPv6 bracketed), because it is
 * spliced verbatim into `https://<addr>/web-index.html`: a scheme, path, or
 * unbracketed IPv6 would move the handoff code onto a different origin or path.
 */
function isDirectAddrForm(addr: string): boolean {
  const match = addr.match(/^(\[[0-9A-Fa-f:]+\]|[^:[\]/?#\s]+)(?::(\d{1,5}))?$/)
  if (!match) return false
  const port = match[2]
  return port === undefined || (Number(port) >= 1 && Number(port) <= 65535)
}

/**
 * The platform origin as the caller's browser sees it (proxy scheme + request
 * Host): a link the platform hands out must reach the platform the caller is
 * actually talking to, which a configured constant cannot know.
 */
function requestOrigin(req: IncomingMessage): string {
  const forwardedScheme = req.headers['x-forwarded-proto']?.toString().split(',')[0]?.trim()
  // When this listener terminates TLS itself (U41) there is no proxy to announce
  // the scheme, so the encrypted socket is the only signal.
  const ownScheme = 'encrypted' in req.socket && req.socket.encrypted === true ? 'https' : 'http'
  return `${forwardedScheme ?? ownScheme}://${
    req.headers.host ?? `127.0.0.1:${req.socket.localPort ?? 0}`
  }`
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * FR-4.11: the payload behind the wizard's one-liner. It writes the env file the
 * target machine needs and prints the follow-up commands; it never prompts, so
 * `bash <(curl …)` stays unattended-safe.
 */
function hostInstallScript(input: { platformUrl: string; token: string }): string {
  return `#!/usr/bin/env bash
# Orca Cloud 开发机接入脚本（平台生成；内嵌一次性注册令牌，注册一次后失效）
set -euo pipefail

ORCA_ENV_FILE="\${ORCA_ENV_FILE:-\$HOME/.orca-cloud/host.env}"
mkdir -p "\$(dirname "\$ORCA_ENV_FILE")"
umask 077

echo ">> 写入环境配置 \$ORCA_ENV_FILE"
ORCA_HOST_NAME="\$(hostname -s 2>/dev/null || hostname)"
ORCA_ADVERTISE="\${ADVERTISE_HOST:-\$(hostname -I 2>/dev/null | awk '{print \$1}')}"
{
  # ORCA_CLOUD_* is what the host binary reads; the bare aliases stay for env
  # files and docs written before the rename (same family as U38).
  echo "ORCA_CLOUD_API_URL=${input.platformUrl}"
  echo "ORCA_CLOUD_HOST_TOKEN=${input.token}"
  echo "ORCA_CLOUD_HOST_NAME=\$ORCA_HOST_NAME"
  echo "ORCA_CLOUD_ADVERTISE_HOST=\$ORCA_ADVERTISE"
  echo "ORCA_CLOUD_PROJECTS_ROOT=\${PROJECTS_ROOT:-/srv/work}"
  echo "HOST_TOKEN=${input.token}"
  echo "HOST_NAME=\$ORCA_HOST_NAME"
  echo "ADVERTISE_HOST=\$ORCA_ADVERTISE"
  echo "PROJECTS_ROOT=\${PROJECTS_ROOT:-/srv/work}"
} > "\$ORCA_ENV_FILE"

ORCA_TLS_CERT="\${ORCA_TLS_CERT:-\$HOME/.orca-cloud/tls/host.crt}"
ORCA_TLS_KEY="\${ORCA_TLS_KEY:-\$HOME/.orca-cloud/tls/host.key}"
if [ ! -s "\$ORCA_TLS_CERT" ] || [ ! -s "\$ORCA_TLS_KEY" ]; then
  echo ">> 生成自签 TLS 证书（openssl）"
  mkdir -p "\$(dirname "\$ORCA_TLS_CERT")"
  openssl req -x509 -newkey rsa:2048 -nodes -days 365 \\
    -keyout "\$ORCA_TLS_KEY" -out "\$ORCA_TLS_CERT" \\
    -subj "/CN=\$(hostname -s 2>/dev/null || hostname)" \\
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" >/dev/null 2>&1
  printf 'ORCA_CLOUD_TLS_CERT_PATH=%s\\nORCA_CLOUD_TLS_KEY_PATH=%s\\n' "\$ORCA_TLS_CERT" "\$ORCA_TLS_KEY" >> "\$ORCA_ENV_FILE"
fi

echo ">> 平台连通性检查"
curl -fsS "\$ORCA_CLOUD_API_URL/health" > /dev/null
echo ">> 环境已就绪：\$ORCA_ENV_FILE"

cat <<'ORCA_NEXT'

后续命令在开发机上执行：
1) 前台启动 Orca 宿主模式（调试，注册并开始心跳）：
   set -a; . "\$ORCA_ENV_FILE"; set +a
   orca --host-mode
2) systemd 用户单元（开机自启）：
   mkdir -p ~/.config/systemd/user
   cat > ~/.config/systemd/user/orca-host.service <<'UNIT'
[Unit]
Description=Orca Cloud 宿主代理
[Service]
EnvironmentFile=%h/.orca-cloud/host.env
ExecStart=/usr/bin/orca --host-mode
Restart=on-failure
[Install]
WantedBy=default.target
UNIT
   systemctl --user daemon-reload
   systemctl --user enable --now orca-host.service
ORCA_NEXT
`
}

function relayInstallScript(input: { platformUrl: string; internalToken: string }): string {
  return `#!/usr/bin/env bash
# Orca Cloud 中继接入脚本（平台生成；内嵌内部控制令牌，仅管理员可见）
set -euo pipefail

ORCA_ENV_FILE="\${ORCA_ENV_FILE:-\$HOME/.orca-cloud/relay.env}"
mkdir -p "\$(dirname "\$ORCA_ENV_FILE")"
umask 077

echo ">> 写入环境配置 \$ORCA_ENV_FILE"
{
  echo "ORCA_CLOUD_API_URL=${input.platformUrl}"
  echo "ORCA_CLOUD_INTERNAL_TOKEN=${input.internalToken}"
  echo "PORT=\${PORT:-18443}"
  echo "RELAY_PUBLIC_HOST=\${RELAY_PUBLIC_HOST:-}"
} > "\$ORCA_ENV_FILE"

echo ">> 平台连通性检查"
curl -fsS "\$ORCA_CLOUD_API_URL/health" > /dev/null
echo ">> 环境已就绪：\$ORCA_ENV_FILE"

cat <<'ORCA_NEXT'

后续命令在中继机上执行：
1) 前台启动中继（调试；需要仓库代码）：
   set -a; . "\$ORCA_ENV_FILE"; set +a
   node cloud-platform/apps/relay/src/relay.ts
2) systemd 用户单元（开机自启）：
   mkdir -p ~/.config/systemd/user
   cat > ~/.config/systemd/user/orca-relay.service <<'UNIT'
[Unit]
Description=Orca Cloud 中继
[Service]
EnvironmentFile=%h/.orca-cloud/relay.env
ExecStart=/usr/bin/env node /opt/orca-cloud/cloud-platform/apps/relay/src/relay.ts
Restart=on-failure
[Install]
WantedBy=default.target
UNIT
   systemctl --user daemon-reload
   systemctl --user enable --now orca-relay.service

说明：RELAY_PUBLIC_HOST 填客户端可达地址（NAT/跨网段必填）；缺省时平台记录注册来源 IP。
ORCA_NEXT
`
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
  const accessTtlMs = config.accessTtlMs ?? ACCESS_TTL_MS
  const refreshTtlMs = config.refreshTtlMs ?? REFRESH_TTL_MS
  const hostOfflineMs =
    config.hostOfflineMs ??
    Number(process.env.ORCA_CLOUD_HOST_OFFLINE_MS ?? HOST_OFFLINE_DEFAULT_MS)
  const handoffTtlMs = config.handoffTtlMs ?? HANDOFF_TTL_MS
  const expiresInSeconds = Math.ceil(accessTtlMs / 1000)
  const auditLogPath = config.auditLogPath ?? process.env.AUDIT_LOG_PATH ?? null
  const store = new Store()
  // Production must inject a secret; the fallback exists only for local tests.
  const internalToken =
    config.internalToken ??
    process.env.INTERNAL_TOKEN ??
    process.env.ORCA_CLOUD_INTERNAL_TOKEN ??
    'internal-test-token'

  const loginLockoutUrl = config.loginLockoutUrl ?? process.env.ORCA_CLOUD_LOGIN_LOCKOUT_URL ?? null
  const sharedLockout = loginLockoutUrl
    ? createRemoteLoginLockout({ url: loginLockoutUrl, internalToken })
    : null
  const auditWriterUrls = auditWriterEndpoints(config)
  // Why the writer wins: with several replicas, only one process may assign
  // `seq`/`prevHash`, otherwise the chain forks (AC-26).
  const audit: AuditSink =
    auditWriterUrls.length > 0
      ? createRemoteAudit({ urls: auditWriterUrls, internalToken: internalToken })
      : localAudit()
  /** Single URL and list are both supported; blank entries are dropped. */
  function auditWriterEndpoints(cfg: ApiConfig): string[] {
    const listed = cfg.auditWriterUrls ?? (cfg.auditWriterUrl ? [cfg.auditWriterUrl] : [])
    return listed.map((url) => url.trim()).filter(Boolean)
  }
  function localAudit(): AuditChain {
    const auditLog = auditLogPath ? openAuditLogFile(auditLogPath) : null
    const chain = new AuditChain(store, auditLog?.append, now)
    if (auditLog) {
      // Why before serving: a chain continued from a tampered tail would launder it.
      chain.restore(auditLog.load())
    }
    return chain
  }
  /**
   * Sensitive control-plane mutations gate on audit health (design §13.2): a full
   * disk or a tampered chain must stop grants from being minted unrecorded.
   * Reads, login, and liveness stay available so the platform can be diagnosed.
   */
  function auditAllowsMutations(res: ServerResponse, traceId: string): boolean {
    const health = audit.getHealth()
    // A broken chain stays refused until the log is repaired and the process
    // restarts. A write failure is transient: the request is let through so the
    // append can be attempted (and health cleared) once the disk is writable again.
    if (health.ok || health.reason === 'write_failed') {
      return true
    }
    error(res, 503, 'AUDIT_CHAIN_BROKEN', '审计链已损坏（可能被篡改），敏感操作已停止。', traceId, {
      reason: health.reason
    })
    return false
  }

  /**
   * AC-18: a refusal at a privileged endpoint is a 403 *and* an audit event, so
   * "who tried to reach the console" is answerable instead of invisible.
   *
   * Why best effort: the caller is already refused, and a broken log must not
   * turn a 403 into a 500 — audit health has its own fail-closed gate for the
   * mutations that must not proceed unrecorded.
   */
  function denyPrivileged(
    res: ServerResponse,
    traceId: string,
    user: User,
    input: {
      eventType: string
      targetType: string
      targetId?: string | null
      /** Exactly the role that was missing, so the event reads on its own. */
      permission: 'platform:admin' | 'platform:auditor'
    }
  ): void {
    audit.appendBestEffort({
      eventType: input.eventType,
      actor: user.username,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      result: 'denied',
      traceId,
      metadata: { reason: 'PERMISSION_DENIED', requiredPermission: input.permission }
    })
    error(
      res,
      403,
      'PERMISSION_DENIED',
      input.permission === 'platform:admin' ? '需要平台管理权限。' : '需要审计权限。',
      traceId
    )
  }

  /**
   * Writes the event first and only then lets the caller mutate (write-ahead
   * audit). If the write fails the mutation never happens, which is what
   * fail-closed means; the reverse order would leave a change on disk that no
   * event records.
   */
  async function recordAudit(
    res: ServerResponse,
    input: AuditEventInput,
    traceId: string
  ): Promise<boolean> {
    try {
      await audit.append(input)
      return true
    } catch {
      const health = audit.getHealth()
      const code = health.ok
        ? 'AUDIT_UNAVAILABLE'
        : health.reason === 'chain_broken'
          ? 'AUDIT_CHAIN_BROKEN'
          : 'AUDIT_UNAVAILABLE'
      error(res, 503, code, '审计日志不可写，敏感操作已停止。', traceId)
      return false
    }
  }

  /**
   * AC-02 counts failures per account, not per replica: with a shared counter the
   * fifth wrong password locks the account wherever the attempts landed.
   */
  async function loginLockState(username: string): Promise<LockoutState | null> {
    if (sharedLockout) {
      const state = await sharedLockout.isLocked(username)
      return lockoutUnavailable(state) ? null : state
    }
    return store.isLocked(username, now())
      ? { locked: true, remaining: 0, lockedUntil: 0 }
      : { locked: false, remaining: 5, lockedUntil: 0 }
  }

  async function recordLoginFailure(username: string): Promise<LockoutState | null> {
    if (sharedLockout) {
      try {
        return await sharedLockout.recordFailure(username)
      } catch {
        return null
      }
    }
    return store.recordLoginFailure(username, now())
  }

  async function clearLoginFailures(username: string): Promise<void> {
    if (!sharedLockout) {
      store.clearLoginFailures(username)
      return
    }
    // A stale counter must not block a user who just proved the password.
    await sharedLockout.clear(username).catch(() => undefined)
  }

  const signingKeys = createSigningKeyRing(now)
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
    ],
    [
      'lisi',
      {
        password: 'Passw0rd!',
        profile: ldapProfile({ username: 'lisi', displayName: '李四', dept: '风控研发部' })
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
    projectsRoot: null,
    projectDirs: [],
    status: 'online',
    maintenanceReason: null,
    lastHeartbeatAt: now(),
    credentialHash: null,
    revokedAt: null
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

  function issueSession(
    user: User,
    deviceId: string
  ): { accessToken: string; refreshToken: string } {
    const accessToken = randomBytes(32).toString('base64url')
    const refreshToken = randomBytes(32).toString('base64url')
    const session = {
      id: `sess_${randomUUID()}`,
      userId: user.id,
      deviceId,
      epoch: 1,
      refreshHash: hashToken(refreshToken),
      refreshExpiresAt: now() + refreshTtlMs,
      revokedAt: null
    }
    store.sessions.set(session.id, session)
    store.accessTokens.set(accessToken, {
      sessionId: session.id,
      userId: user.id,
      epoch: session.epoch,
      expiresAt: now() + accessTtlMs
    })
    store.refreshTokens.set(refreshToken, session.id)
    return { accessToken, refreshToken }
  }

  /**
   * One device plus one session, shared by password login and the web handoff
   * exchange (FR-3.10): a browser enters with exactly the session a desktop gets.
   * A foreign or revoked device id is ignored, not adopted.
   */
  function issueDeviceSession(
    user: User,
    body: Record<string, unknown>
  ): { device: Device; tokens: { accessToken: string; refreshToken: string } } {
    const devicePubKey = String(body.devicePubKey ?? '')
    const deviceName = String(body.deviceName ?? 'unknown')
    const existingDevice = body.deviceId ? store.devices.get(String(body.deviceId)) : undefined
    const device =
      existingDevice && existingDevice.userId === user.id && !existingDevice.revokedAt
        ? existingDevice
        : store.createDevice(user.id, deviceName, devicePubKey)
    return { device, tokens: issueSession(user, device.id) }
  }

  function bumpEpoch(sessionId: string): void {
    const session = store.sessions.get(sessionId)
    if (session) session.epoch += 1
  }

  /**
   * Every live relay, in registration order (AC-23). A dead relay is dropped from
   * the list rather than being handed to a client that would only time out on it;
   * if none has checked in recently, the last known one is still offered so a
   * brief control-plane blip does not leave clients with no relay at all.
   */
  function relayEndpointsFor(routeKey: string): Record<string, unknown>[] {
    const nowMs = now()
    const live = relayNodes.healthy(nowMs, relayAliveMs)
    const chosen = live.length > 0 ? live : relayNodes.all().slice(-1)
    return chosen.map((node, index) => ({
      priority: 99 + index,
      url: `wss://${node.host}:${node.port}/`,
      routeKey,
      sni: `${routeKey}.relay.local`
    }))
  }

  /**
   * The browser-mode entry for one host route: the first live relay that
   * announced a browser edge serves `/h/<routeKey>/`. Empty rather than broken —
   * no announcing relay, no route, or a key the relay's `/h/` parser refuses
   * (it drops dotted keys) must not hand out a URL no browser can load.
   */
  function browserEntryUrlFor(routeKey: string | null): string {
    if (!routeKey || !BROWSER_ROUTE_KEY_PATTERN.test(routeKey)) return ''
    // Why no last-known fallback, unlike relayEndpointsFor: a desktop client
    // probes its endpoints and can fail over to a direct address, a browser
    // cannot — a dead relay's URL is only an error page. Accepted cost: a
    // control-plane blip hides the entry for one announce cycle (<=2s).
    const edge = relayNodes.healthy(now(), relayAliveMs).find((node) => node.browserHost !== '')
    return edge ? `https://${edge.browserHost}/h/${routeKey}/web-index.html` : ''
  }

  /**
   * The origins the platform itself hands browser pages out on: the hosts' TLS
   * direct addresses serve cloud-admin.html / web-index.html, and a relay browser
   * edge serves the same pages under /h/<routeKey>/. Exactly these pages call
   * this API from another origin, so exactly these may read replies cross-origin
   * (W7b CORS) — any other page gets no header and the browser blocks it.
   */
  function browserPageOrigins(): Set<string> {
    const origins = new Set<string>()
    for (const host of store.hosts.values()) {
      for (const addr of host.directAddrs) {
        if (isDirectAddrForm(addr)) origins.add(`https://${addr}`)
      }
    }
    for (const node of relayNodes.all()) {
      if (node.browserHost !== '') origins.add(`https://${node.browserHost}`)
    }
    return origins
  }

  /**
   * The request's Origin when it is one of those page origins, else null. Exact
   * match, never a wildcard: a bearer token rides the Authorization header,
   * which CORS does not protect — this only decides who may read the reply.
   */
  function corsAllowOriginFor(req: IncomingMessage): string | null {
    const origin = req.headers.origin?.toString().trim() ?? ''
    return origin !== '' && browserPageOrigins().has(origin) ? origin : null
  }

  /**
   * Per-project admin entry (FR-3.8): the host's first TLS direct address serves
   * `cloud-admin.html`. Empty rather than dangling — no dialable TLS address
   * means no URL a browser could load. Offline stays out of the decision: the
   * entry must still render (greyed) while the host is down.
   *
   * The page is served by the host, so it cannot learn the platform address from
   * its own origin: `?api=` carries it along (searchParams keeps a later query
   * joinable and percent-encodes the origin).
   */
  function sessionPageUrlFor(h: Host | undefined, platformOrigin: string): string {
    const addr = h?.directAddrs[0]
    if (!h || !addr || !h.tlsFingerprint || !isDirectAddrForm(addr)) {
      return ''
    }
    const page = new URL(`https://${addr}/cloud-admin.html`)
    page.searchParams.set('api', platformOrigin)
    return page.toString()
  }

  function projectView(p: Project, user: User, platformOrigin: string): Record<string, unknown> {
    const permissions = store.effectivePermissions(p.id, user)
    const host = store.hosts.get(p.hostId)
    return {
      id: p.id,
      key: p.key,
      name: p.name,
      repoUrl: p.repoUrl,
      hostId: p.hostId,
      hostName: host?.name ?? null,
      hostStatus: hostStatusView(host),
      sessionPageUrl: sessionPageUrlFor(host, platformOrigin),
      browserEntryUrl: browserEntryUrlFor(host?.relayRoute ?? null),
      // Why here: the workbench can only explain a maintenance window it can see.
      ...(host?.maintenanceReason ? { hostMaintenanceReason: host.maintenanceReason } : {}),
      path: p.path,
      defaultBranch: p.defaultBranch,
      downloadPolicy: p.downloadPolicy,
      // Additive optional read field: lets the console tell a pinned override
      // from a project following the global default; old peers ignore it.
      downloadPolicyExplicit: p.downloadPolicyExplicit === true,
      status: p.status,
      ...(p.provisioningError ? { provisioningError: p.provisioningError } : {}),
      createdAt: p.createdAt,
      permissions
    }
  }

  /**
   * Applies the host's provisioning outcomes from one heartbeat. A malformed entry
   * is ignored on its own; it must not fail the heartbeat's other fields.
   */
  function applyProjectProvisionReports(hostId: string, reports: unknown, traceId: string): void {
    if (!Array.isArray(reports)) {
      return
    }
    for (const raw of reports.slice(0, 50)) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        continue
      }
      const projectId =
        'projectId' in raw && typeof raw.projectId === 'string' ? raw.projectId : null
      const ok = 'ok' in raw && typeof raw.ok === 'boolean' ? raw.ok : null
      if (projectId === null || projectId === '' || ok === null) {
        continue
      }
      const project = store.projects.get(projectId)
      if (!project || project.hostId !== hostId || project.status === 'archived') {
        continue
      }
      const error = 'error' in raw && typeof raw.error === 'string' ? raw.error.slice(0, 500) : ''
      if (ok) {
        project.status = 'ready'
        delete project.provisioningError
      } else {
        project.status = 'failed'
        project.provisioningError = error || 'PROVISION_FAILED'
      }
      audit.appendBestEffort({
        eventType: 'project_provision',
        actor: null,
        targetType: 'project',
        targetId: project.id,
        result: ok ? 'success' : 'failure',
        traceId,
        metadata: { hostId, ...(error ? { error } : {}) }
      })
    }
  }

  /**
   * U37: the heartbeat downlink's provision kick. A repo-ful `provisioning`
   * project has no path to a ticket (connect is gated on ready), so each beat
   * re-derives the host's own pending set from the store — state-driven, so a
   * dropped or ignored assignment only costs one beat of latency. Derived, not
   * stored: no new store field.
   */
  function pendingProvisionAssignments(hostId: string) {
    return [...store.projects.values()]
      .filter((p) => p.hostId === hostId && p.status === 'provisioning' && p.repoUrl !== '')
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, MAX_PROVISION_ASSIGNMENTS_PER_BEAT)
      .map((p) => ({
        projectId: p.id,
        path: p.path,
        repoUrl: p.repoUrl,
        defaultBranch: p.defaultBranch
      }))
  }

  function visibleProject(projectId: string, user: User): Project | null {
    const p = store.projects.get(projectId)
    if (!p || p.status === 'archived') return null
    const permissions = store.effectivePermissions(p.id, user)
    if (!permissions.includes('open')) return null
    return p
  }

  /**
   * What a client may act on, not what the host last reported: a host on which
   * the heartbeat window has lapsed is offline even if its last beat said online
   * (AC-08). Maintenance stays distinct so the workbench can explain it.
   */
  function hostStatusView(h: Host | undefined): string {
    if (!h || h.revokedAt !== null) return 'offline'
    if (h.status === 'maintenance') return 'maintenance'
    return hostOnline(h) ? 'online' : 'offline'
  }

  function hostOnline(h: Host): boolean {
    return (
      h.revokedAt === null && h.status === 'online' && now() - h.lastHeartbeatAt <= hostOfflineMs
    )
  }

  /**
   * A bad root is ignored on its own; it must not fail registration or a heartbeat.
   * Returns false when the reported root was refused. A change of root is refused
   * while the host still owns non-archived projects: their recorded paths — and
   * every ticket minted from them — point at the old root, so silently moving it
   * presents each project as not-prepared with nothing to explain why. Rewriting
   * those paths across roots is a guess about an operator's intent, so refusing
   * and saying so is the safe minimal semantics.
   */
  function applyProjectsRoot(target: Host, value: unknown, traceId: string): boolean {
    if (value === undefined) {
      return true
    }
    if (value === '' || value === null) {
      return commitProjectsRoot(target, null, traceId)
    }
    const verdict = validateProjectPath(value)
    if (!verdict.ok) {
      audit.appendBestEffort({
        eventType: 'host_projects_root_rejected',
        actor: 'agent',
        targetType: 'host',
        targetId: target.id,
        result: 'failure',
        traceId,
        metadata: { reason: verdict.code }
      })
      return true
    }
    return commitProjectsRoot(target, verdict.path, traceId)
  }

  /** Applies a validated root unless live projects still hang off the current one. */
  function commitProjectsRoot(target: Host, nextRoot: string | null, traceId: string): boolean {
    if (nextRoot === target.projectsRoot) {
      return true
    }
    const conflicts = [...store.projects.values()].filter(
      (p) => p.hostId === target.id && p.status !== 'archived'
    )
    if (conflicts.length > 0) {
      audit.appendBestEffort({
        eventType: 'projects_root_change',
        actor: 'agent',
        targetType: 'host',
        targetId: target.id,
        result: 'denied',
        traceId,
        metadata: {
          reason: 'PROJECTS_ROOT_CONFLICT',
          requested: nextRoot,
          current: target.projectsRoot,
          conflictCount: conflicts.length,
          sampleKeys: conflicts.slice(0, 3).map((p) => p.key)
        }
      })
      return false
    }
    target.projectsRoot = nextRoot
    return true
  }

  /**
   * A derived `ip-…` route key follows the address the host advertises, so a
   * machine that changes networks keeps a label clients can still dial; an
   * explicitly configured key never moves. Same address ⇒ no-op, so beats and
   * re-registrations cannot churn the route table.
   */
  function syncHostRoute(target: Host): void {
    const currentKey = target.relayRoute
    if (!currentKey || !currentKey.startsWith('ip-')) {
      return
    }
    const nextKey = routeKeyFromDirectAddrs(target.directAddrs, currentKey)
    if (nextKey === currentKey) {
      return
    }
    // Carry the upstream over: the heartbeat reports no relay target, and the
    // address the host listens on has not changed with its label.
    const current = store.relayRoutes.get(currentKey)
    if (current) store.relayRoutes.delete(currentKey)
    target.relayRoute = nextKey
    const routeTarget = current?.target ?? target.directAddrs[0]
    if (routeTarget) {
      store.relayRoutes.set(nextKey, {
        routeKey: nextKey,
        hostId: target.id,
        target: routeTarget,
        version: store.policies.version
      })
    }
  }

  /**
   * A host enrols before anything listens on it, so registration can name a key
   * with no address behind it; the beat is where that address first appears, and
   * an explicitly named (non-`ip-`) key gets no rename from syncHostRoute.
   */
  function ensureHostRoute(target: Host): void {
    const routeTarget = target.directAddrs[0]
    if (!target.relayRoute || !routeTarget) return
    // Registration's explicit relayTarget stays authoritative; only fill the gap.
    if (store.relayRoutes.has(target.relayRoute)) return
    store.relayRoutes.set(target.relayRoute, {
      routeKey: target.relayRoute,
      hostId: target.id,
      target: routeTarget,
      version: store.policies.version
    })
  }

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    fromInternalChannel = false
  ): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    const traceId = req.headers['x-trace-id']?.toString() ?? randomUUID()
    // Where every link this response hands out should point the caller back to.
    const platformOrigin = requestOrigin(req)

    // Host-served pages (W3 `?api=`, W7b handoff) call this API from another
    // origin, so a listed origin reads replies and anything else gets no header
    // at all — the browser then refuses the request before it is sent. Internal
    // routes have no browser caller, so they stay out of the handshake.
    const corsOrigin = path.startsWith('/v1/internal/') ? null : corsAllowOriginFor(req)
    if (corsOrigin !== null) {
      res.setHeader('access-control-allow-origin', corsOrigin)
      // Why vary: the headers differ per Origin, so a shared cache must not hand
      // one origin's reply to another.
      res.setHeader('vary', 'Origin')
    }
    if (req.method === 'OPTIONS' && path.startsWith('/v1/')) {
      if (corsOrigin !== null) {
        // Only what the browser pages send: a bearer token and a JSON body.
        res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
        res.setHeader('access-control-allow-headers', 'authorization, content-type')
        res.setHeader('access-control-max-age', '600')
      }
      res.writeHead(204)
      res.end()
      return
    }

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

    // ---- frontend release (AC-19): public, a console bootstraps before it has a token ----
    if (req.method === 'GET' && path === '/v1/web/release') {
      const release = webReleases.current()
      return json(res, 200, {
        contract: WEB_CONTRACT_VERSION,
        minContract: MIN_WEB_CONTRACT_VERSION,
        build: release.build,
        assets: Object.fromEntries(
          [...release.files.keys()]
            .filter((name) => name !== 'index.html')
            .map((name) => [
              name,
              {
                path: webReleases.assetPath(release.build, name),
                sha256: release.files.get(name)?.sha256
              }
            ])
        )
      })
    }

    if (path.startsWith('/v1/')) {
      const contract = checkWebContract(readWebContract(req.headers))
      if (!contract.ok) {
        return error(
          res,
          426,
          'WEB_CONTRACT_UNSUPPORTED',
          '前端版本过旧或过新，请刷新页面获取最新版本。',
          traceId,
          {
            offered: contract.offered,
            minContract: contract.min,
            maxContract: contract.max
          }
        )
      }
    }

    // /install/*.sh is gated below (after session resolution), never served as a file.
    if (
      req.method === 'GET' &&
      !path.startsWith('/v1/') &&
      !path.startsWith('/install/') &&
      path !== '/health'
    ) {
      return serveStatic(path, res)
    }

    // ---- auth ----
    if (req.method === 'POST' && path === '/v1/auth/login') {
      const body = await readJson(req)
      const username = String(body.username ?? '')
      const password = String(body.password ?? '')
      const lockState = await loginLockState(username)
      if (lockState === null) {
        return error(res, 503, 'PLATFORM_UNAVAILABLE', '平台暂不可用，请稍后再试。', traceId)
      }
      if (lockState.locked) {
        audit.appendBestEffort({
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
        const failure = await recordLoginFailure(username)
        if (failure === null) {
          return error(res, 503, 'PLATFORM_UNAVAILABLE', '平台暂不可用，请稍后再试。', traceId)
        }
        audit.appendBestEffort({
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
      await clearLoginFailures(username)
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
      const { device, tokens } = issueDeviceSession(user, body)
      // Why best-effort: an operator must still be able to sign in and diagnose a
      // full audit disk; mutations are what fail closed, not authentication.
      audit.appendBestEffort({
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
        expiresIn: expiresInSeconds,
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
      // Why kept: a replayed old token must still identify this session, so the
      // hash mismatch below can revoke it instead of reading as an unknown token.
      const accessToken = randomBytes(32).toString('base64url')
      const refreshToken = randomBytes(32).toString('base64url')
      session.refreshHash = hashToken(refreshToken)
      session.refreshExpiresAt = now() + refreshTtlMs
      store.accessTokens.set(accessToken, {
        sessionId: session.id,
        userId: session.userId,
        epoch: session.epoch,
        expiresAt: now() + accessTtlMs
      })
      store.refreshTokens.set(refreshToken, session.id)
      return json(res, 200, { accessToken, refreshToken, expiresIn: expiresInSeconds })
    }

    // ---- web handoff (FR-3.10): a browser trades its one-time code for a session ----
    // Deliberately before token resolution: the caller has no session yet.
    if (req.method === 'POST' && path === '/v1/web/handoff') {
      const body = await readJson(req)
      const code = String(body.code ?? '')
      const fingerprint = codeFingerprint(code)
      const deny = async (
        status: number,
        errorCode: string,
        message: string,
        reason: string,
        actor: string | null,
        target: { targetType: 'session' | 'project'; targetId: string | null } = {
          targetType: 'session',
          targetId: null
        }
      ): Promise<void> => {
        audit.appendBestEffort({
          eventType: 'web_handoff',
          actor,
          targetType: target.targetType,
          targetId: target.targetId,
          result: 'denied',
          traceId,
          metadata: { reason, codeFingerprint: fingerprint }
        })
        // Why the reason is exposed: the web client falls back to the login form
        // either way, and an operator reading the console sees which case it was.
        error(res, status, errorCode, message, traceId, { reason })
      }
      const consumed = store.consumeWebHandoff(code, now())
      if (!consumed.ok) {
        const expired = consumed.reason === 'expired'
        await deny(
          410,
          'HANDOFF_GONE',
          expired ? '交接码已过期，请重新获取。' : '交接码无效或已使用。',
          expired ? 'code_expired' : 'code_invalid',
          null
        )
        return
      }
      const user = store.users.get(consumed.entry.userId)
      const project = store.projects.get(consumed.entry.projectId)
      if (!user || user.status !== 'active' || !project || project.status === 'archived') {
        await deny(
          410,
          'HANDOFF_GONE',
          '交接码无效或已使用。',
          user && project ? 'project_archived' : 'subject_gone',
          user?.username ?? null
        )
        return
      }
      // The code is bound to a user, not a permission: a grant pulled between
      // issue and redeem must still stop the entry here.
      if (!store.effectivePermissions(project.id, user).includes('open')) {
        await deny(
          403,
          'PROJECT_FORBIDDEN',
          '项目无权限，无法打开。',
          'permission_lost',
          user.username,
          { targetType: 'project', targetId: project.id }
        )
        return
      }
      const { device, tokens } = issueDeviceSession(user, body)
      // Same shape as a login event, so an auditor reads a handoff as a sign-in.
      audit.appendBestEffort({
        eventType: 'web_handoff',
        actor: user.username,
        targetType: 'session',
        targetId: device.id,
        result: 'success',
        traceId,
        metadata: { projectId: project.id, codeFingerprint: fingerprint }
      })
      const permissions = user.roles.flatMap((r) => ROLE_PERMISSIONS[r] ?? [])
      return json(res, 200, {
        ...tokens,
        expiresIn: expiresInSeconds,
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

    if (req.method === 'POST' && path === '/v1/auth/logout') {
      const auth = resolveToken(req)
      if (auth) {
        const session = store.sessions.get(auth.sessionId)
        if (session) {
          session.revokedAt = now()
          bumpEpoch(session.id)
        }
        await audit.append({
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

    // ---- install wizard (FR-4.11): admin-only, the script embeds secrets ----
    // Sits beside the /v1/relays admin gate and after session resolution; the
    // static fallback above skips /install/ so a plain GET still reaches here.
    if (req.method === 'GET' && (path === '/install/host.sh' || path === '/install/relay.sh')) {
      const authed = requireAuth()
      if (!authed) return
      if (!isAdmin(authed.user)) {
        return denyPrivileged(res, traceId, authed.user, {
          eventType: 'install_script',
          targetType: 'install_script',
          targetId: path,
          permission: 'platform:admin'
        })
      }
      const kind = path === '/install/host.sh' ? 'host' : 'relay'
      // The operator pastes this command on the target machine, so the embedded
      // address must be the one the wizard page saw.
      const platformUrl = requestOrigin(req)
      let script: string
      let tokenEmbedded = false
      if (kind === 'host') {
        const token = url.searchParams.get('token') ?? ''
        if (!token) {
          return error(res, 400, 'INSTALL_TOKEN_REQUIRED', '缺少一次性注册令牌。', traceId)
        }
        const entry = store.hostTokens.find((t) => safeEqual(t.tokenHash, hashToken(token)))
        if (!entry || entry.usedAt || entry.expiresAt < now()) {
          return error(res, 401, 'HOST_TOKEN_INVALID', '注册令牌无效或已使用。', traceId)
        }
        tokenEmbedded = true
        script = hostInstallScript({ platformUrl, token })
      } else {
        script = relayInstallScript({ platformUrl, internalToken })
      }
      // Why no token in metadata: the audit log must not become a second copy of the secret.
      audit.appendBestEffort({
        eventType: 'install_script',
        actor: authed.user.username,
        targetType: 'install_script',
        targetId: `${kind}.sh`,
        result: 'success',
        traceId,
        metadata: { type: kind, tokenEmbedded, platformUrl }
      })
      res.writeHead(200, { 'content-type': 'text/x-shellscript; charset=utf-8' })
      res.end(script)
      return
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
      if (!auditAllowsMutations(res, traceId)) return
      const device = store.devices.get(deviceRevoke[1])
      if (!device || device.userId !== authed.user.id) {
        return error(res, 404, 'NOT_FOUND', '设备不存在。', traceId)
      }
      if (
        !(await recordAudit(
          res,
          {
            eventType: 'device_revoke',
            actor: authed.user.username,
            targetType: 'device',
            targetId: device.id,
            result: 'success',
            traceId
          },
          traceId
        ))
      ) {
        return
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
      return json(res, 200, { keys: signingKeys.publicKeys() })
    }

    // ---- signing-key rotation (AC-31): old public keys stay published for 60 days ----
    if (req.method === 'POST' && path === '/v1/admin/signing-keys/rotate') {
      const authed = requireAuth()
      if (!authed) return
      if (!isAdmin(authed.user)) {
        return denyPrivileged(res, traceId, authed.user, {
          eventType: 'signing_key_rotate',
          targetType: 'signing_key',
          permission: 'platform:admin'
        })
      }
      if (!auditAllowsMutations(res, traceId)) return
      const rotated = signingKeys.rotate()
      if (
        !(await recordAudit(
          res,
          {
            eventType: 'signing_key_rotate',
            actor: authed.user.username,
            targetType: 'signing_key',
            targetId: rotated.current.kid,
            result: 'success',
            traceId,
            metadata: {
              previousKid: rotated.retired.kid,
              retiredKids: signingKeys.retired().length
            }
          },
          traceId
        ))
      ) {
        return
      }
      return json(res, 200, {
        kid: rotated.current.kid,
        previousKid: rotated.retired.kid,
        publishedKids: signingKeys.publicKeys().map((entry) => entry.kid)
      })
    }

    // ---- projects ----
    if (req.method === 'GET' && path === '/v1/projects') {
      const authed = requireAuth()
      if (!authed) return
      // Why opt-in: archived rows are history; the admin console asks for them to
      // restore, while a signed-in desktop must never treat one as a live project.
      const includeArchived =
        url.searchParams.get('includeArchived') === '1' && isAdmin(authed.user)
      const visible = [...store.projects.values()]
        .filter(
          (p) =>
            (includeArchived || p.status !== 'archived') &&
            (isAdmin(authed.user) || store.effectivePermissions(p.id, authed.user).includes('open'))
        )
        .map((p) => projectView(p, authed.user, platformOrigin))
      return json(res, 200, { projects: visible })
    }

    if (req.method === 'POST' && path === '/v1/projects') {
      const authed = requireAuth()
      if (!authed) return
      if (!isAdmin(authed.user)) {
        await audit.append({
          eventType: 'project_create',
          actor: authed.user.username,
          targetType: 'project',
          targetId: null,
          result: 'denied',
          traceId,
          metadata: { reason: 'PERMISSION_DENIED', requiredPermission: 'platform:admin' }
        })
        return error(res, 403, 'PERMISSION_DENIED', '需要平台管理权限。', traceId)
      }
      if (!auditAllowsMutations(res, traceId)) return
      const body = await readJson(req)
      const hostId = String(body.hostId ?? '')
      const target = store.hosts.get(hostId)
      if (!target) return error(res, 400, 'HOST_NOT_FOUND', '主机不存在。', traceId)
      // FR-3.2: a project born on an offline host can never be opened, so the
      // heartbeat decides at creation time, not at first connect.
      if (!hostOnline(target)) {
        await audit.append({
          eventType: 'project_create',
          actor: authed.user.username,
          targetType: 'project',
          targetId: null,
          result: 'denied',
          traceId,
          metadata: { reason: 'HOST_OFFLINE', hostId }
        })
        return error(res, 409, 'HOST_OFFLINE', '目标主机已离线，暂时无法登记项目。', traceId)
      }
      const keyVerdict = validateProjectKey(body.key)
      if (!keyVerdict.ok) {
        await audit.append({
          eventType: 'project_create',
          actor: authed.user.username,
          targetType: 'project',
          targetId: null,
          result: 'denied',
          traceId,
          metadata: { reason: keyVerdict.code, key: String(body.key ?? '') }
        })
        return error(res, 400, keyVerdict.code, keyVerdict.message, traceId)
      }
      const key = keyVerdict.key
      // Why fall back to the key: admins omitting a name keep the key as the label.
      const name = typeof body.name === 'string' ? body.name.trim() : key
      if (name === '' || name.length > 200) {
        await audit.append({
          eventType: 'project_create',
          actor: authed.user.username,
          targetType: 'project',
          targetId: null,
          result: 'denied',
          traceId,
          metadata: { reason: 'PROJECT_NAME_INVALID', key }
        })
        return error(
          res,
          400,
          'PROJECT_NAME_INVALID',
          '项目名称不能为空且不能超过 200 个字符。',
          traceId
        )
      }
      if (projectKeyTaken(store, key)) {
        return error(res, 409, 'PROJECT_EXISTS', '项目 Key 已存在。', traceId)
      }
      const pathVerdict = validateProjectPath(body.path)
      if (!pathVerdict.ok) {
        await audit.append({
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
      if (projectPathTaken(store, pathVerdict.path)) {
        return error(res, 409, 'PROJECT_PATH_TAKEN', '该主机目录下已存在同路径的项目。', traceId)
      }
      const repoUrlVerdict = validateProjectRepoUrl(body.repoUrl)
      if (!repoUrlVerdict.ok) {
        await audit.append({
          eventType: 'project_create',
          actor: authed.user.username,
          targetType: 'project',
          targetId: null,
          result: 'denied',
          traceId,
          metadata: { reason: repoUrlVerdict.code }
        })
        return error(res, 400, repoUrlVerdict.code, repoUrlVerdict.message, traceId)
      }
      const branchVerdict = validateProjectDefaultBranch(body.defaultBranch)
      if (!branchVerdict.ok) {
        await audit.append({
          eventType: 'project_create',
          actor: authed.user.username,
          targetType: 'project',
          targetId: null,
          result: 'denied',
          traceId,
          metadata: { reason: branchVerdict.code }
        })
        return error(res, 400, branchVerdict.code, branchVerdict.message, traceId)
      }
      const created: Project = {
        id: `proj_${randomBytes(4).toString('hex')}`,
        key,
        name,
        repoUrl: repoUrlVerdict.repoUrl,
        hostId,
        path: pathVerdict.path,
        defaultBranch: branchVerdict.defaultBranch || 'main',
        downloadPolicy: body.downloadPolicy === 'allow' ? 'allow' : 'deny',
        // Why: a repo URL means the host must clone it before the first open.
        status: repoUrlVerdict.repoUrl ? 'provisioning' : 'ready',
        createdBy: authed.user.username,
        createdAt: now()
      }
      if (
        !(await recordAudit(
          res,
          {
            eventType: 'project_create',
            actor: authed.user.username,
            targetType: 'project',
            targetId: created.id,
            result: 'success',
            traceId,
            metadata: { key: created.key, path: created.path }
          },
          traceId
        ))
      ) {
        return
      }
      store.projects.set(created.id, created)
      store.projectsByKey.set(created.key, created)
      return json(res, 201, projectView(created, authed.user, platformOrigin))
    }

    if (req.method === 'POST' && path === '/v1/projects/self') {
      const authed = requireAuth()
      if (!authed) return
      if (!auditAllowsMutations(res, traceId)) return
      const body = await readJson(req)
      const deny = async (
        status: number,
        code: string,
        message: string,
        details?: Record<string, unknown>
      ): Promise<void> => {
        await audit.append({
          eventType: 'project_create',
          actor: authed.user.username,
          targetType: 'project',
          targetId: null,
          result: 'denied',
          traceId,
          metadata: { reason: code, selfService: true }
        })
        error(res, status, code, message, traceId, details)
      }
      // Why: the path is the platform's decision; accepting one would let a
      // developer name any directory on a shared host.
      if ('path' in body) {
        return await deny(400, 'PROJECT_PATH_FORBIDDEN', '项目路径由平台推导，不能指定。')
      }
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (name === '' || name.length > 200) {
        return await deny(400, 'PROJECT_NAME_INVALID', '项目名称不能为空且不能超过 200 个字符。')
      }
      // FR-3.7: the developer names the directory under the host's root; the key
      // only identifies the project, it no longer decides where the project lives.
      const dirVerdict = validateProjectDir(body.dir)
      if (!dirVerdict.ok) {
        return await deny(400, dirVerdict.code, dirVerdict.message)
      }
      const keyVerdict = validateProjectKey(
        body.key === undefined ? projectKeyFromName(name) : body.key
      )
      if (!keyVerdict.ok) {
        return await deny(400, keyVerdict.code, keyVerdict.message)
      }
      const repoVerdict = validateProjectRepoUrl(body.repoUrl)
      if (!repoVerdict.ok) {
        return await deny(400, repoVerdict.code, repoVerdict.message)
      }
      const branchVerdict = validateProjectDefaultBranch(body.defaultBranch)
      if (!branchVerdict.ok) {
        return await deny(400, branchVerdict.code, branchVerdict.message)
      }
      const selection = selectSelfServiceHost({
        hosts: store.hosts.values(),
        hostId: typeof body.hostId === 'string' ? body.hostId : '',
        isOnline: hostOnline
      })
      if (!selection.ok) {
        return await deny(selection.status, selection.code, selection.message, selection.details)
      }
      const key = keyVerdict.key
      if (projectKeyTaken(store, key)) {
        return await deny(409, 'PROJECT_KEY_TAKEN', '项目 Key 已被占用，请更换。')
      }
      const root = selection.host.projectsRoot
      const projectPath = root === null ? null : joinProjectPath(root, dirVerdict.dir)
      if (projectPath === null) {
        return await deny(400, 'PATH_OUTSIDE_ROOT', '项目目录不在主机项目根目录内。')
      }
      if (projectPathTaken(store, projectPath)) {
        return await deny(409, 'PROJECT_PATH_TAKEN', '该主机目录下已存在同路径的项目。')
      }
      if (
        countActiveProjectsCreatedBy(store.projects.values(), authed.user.username) >=
        SELF_SERVICE_PROJECT_LIMIT
      ) {
        return await deny(
          429,
          'PROJECT_LIMIT_REACHED',
          `自助创建的项目数量已达上限（${SELF_SERVICE_PROJECT_LIMIT} 个）。`
        )
      }
      const created: Project = {
        id: `proj_${randomBytes(4).toString('hex')}`,
        key,
        name,
        repoUrl: repoVerdict.repoUrl,
        hostId: selection.host.id,
        path: projectPath,
        defaultBranch: branchVerdict.defaultBranch || 'main',
        downloadPolicy: 'deny',
        status: repoVerdict.repoUrl ? 'provisioning' : 'ready',
        createdBy: authed.user.username,
        createdAt: now()
      }
      if (
        !(await recordAudit(
          res,
          {
            eventType: 'project_create',
            actor: authed.user.username,
            targetType: 'project',
            targetId: created.id,
            result: 'success',
            traceId,
            metadata: { key, selfService: true, hostId: created.hostId }
          },
          traceId
        ))
      ) {
        return
      }
      store.projects.set(created.id, created)
      store.projectsByKey.set(created.key, created)
      store.grants.push({
        projectId: created.id,
        subjectType: 'user',
        subjectId: authed.user.id,
        // Why no download: self-service projects keep the platform default policy.
        permissions: ['open', 'terminal', 'agent', 'file:read', 'file:write']
      })
      return json(res, 201, projectView(created, authed.user, platformOrigin))
    }

    // Hyphenated actions share the guard block below; the common ones are
    // /connect and /web-handoff (FR-3.10).
    const projectPath = path.match(/^\/v1\/projects\/([\w-]+)(\/[a-z-]+)?$/)
    if (projectPath) {
      const authed = requireAuth()
      if (!authed) return
      const projectId = projectPath[1]
      const action = projectPath[2] ?? ''
      const found = store.projects.get(projectId)
      // 404 for both unknown and unauthorised: never leak existence.
      const adminAccess = isAdmin(authed.user) || authed.user.roles.includes('platform:auditor')
      if (
        !found ||
        (!adminAccess && !store.effectivePermissions(found.id, authed.user).includes('open'))
      ) {
        await audit.append({
          eventType: 'project_access',
          actor: authed.user.username,
          targetType: 'project',
          targetId: projectId,
          result: 'denied',
          traceId
        })
        return error(res, 404, 'PROJECT_NOT_FOUND', '项目不存在或无权访问。', traceId)
      }

      const archiveAction =
        req.method === 'POST' && (action === '/archive' || action === '/restore')
      // Why: an archived project is history; only archive/restore may still see it.
      if (found.status === 'archived' && !archiveAction) {
        return error(res, 404, 'PROJECT_NOT_FOUND', '项目不存在或无权访问。', traceId)
      }

      if (req.method === 'GET' && action === '')
        return json(res, 200, projectView(found, authed.user, platformOrigin))

      if (req.method === 'PUT' && action === '') {
        if (!isAdmin(authed.user)) {
          await audit.append({
            eventType: 'project_update',
            actor: authed.user.username,
            targetType: 'project',
            targetId: projectId,
            result: 'denied',
            traceId,
            metadata: { reason: 'PERMISSION_DENIED', requiredPermission: 'platform:admin' }
          })
          return error(res, 403, 'PERMISSION_DENIED', '需要平台管理权限。', traceId)
        }
        if (!auditAllowsMutations(res, traceId)) return
        if (found.status === 'archived') {
          // Same payload as unknown/unreadable: an archived project is not editable.
          return error(res, 404, 'PROJECT_NOT_FOUND', '项目不存在或无权访问。', traceId)
        }
        const body = await readJson(req)
        if ('path' in body || 'hostId' in body) {
          return error(res, 400, 'PROJECT_FIELD_IMMUTABLE', '项目路径与主机不允许修改。', traceId)
        }
        let nextRepoUrl = found.repoUrl
        if ('repoUrl' in body) {
          const verdict = validateProjectRepoUrl(body.repoUrl)
          if (!verdict.ok) {
            await audit.append({
              eventType: 'project_update',
              actor: authed.user.username,
              targetType: 'project',
              targetId: projectId,
              result: 'denied',
              traceId,
              metadata: { reason: verdict.code }
            })
            return error(res, 400, verdict.code, verdict.message, traceId)
          }
          nextRepoUrl = verdict.repoUrl
        }
        let nextBranch = found.defaultBranch
        if ('defaultBranch' in body) {
          const verdict = validateProjectDefaultBranch(body.defaultBranch)
          if (!verdict.ok) {
            await audit.append({
              eventType: 'project_update',
              actor: authed.user.username,
              targetType: 'project',
              targetId: projectId,
              result: 'denied',
              traceId,
              metadata: { reason: verdict.code }
            })
            return error(res, 400, verdict.code, verdict.message, traceId)
          }
          nextBranch = verdict.defaultBranch
        }
        const repoUrlChanged = nextRepoUrl !== found.repoUrl
        if (
          !(await recordAudit(
            res,
            {
              eventType: 'project_update',
              actor: authed.user.username,
              targetType: 'project',
              targetId: projectId,
              result: 'success',
              traceId,
              // Why no repoUrl value: it may embed credentials.
              metadata: { key: found.key, repoUrlChanged, hostId: found.hostId }
            },
            traceId
          ))
        ) {
          return
        }
        found.repoUrl = nextRepoUrl
        found.defaultBranch = nextBranch
        // A repo URL means the host must clone it before the next open.
        found.status = nextRepoUrl ? 'provisioning' : 'ready'
        delete found.provisioningError
        return json(res, 200, projectView(found, authed.user, platformOrigin))
      }

      if (req.method === 'POST' && action === '/connect') {
        return handleConnect(req, res, authed.user, found, traceId)
      }

      if (req.method === 'POST' && action === '/web-handoff') {
        return handleWebHandoff(res, authed.user, found, traceId, platformOrigin)
      }

      if (req.method === 'GET' && action === '/grants') {
        // User rows carry the username so the console can show who was granted
        // instead of an opaque id; a legacy username-keyed row has no user to name.
        const grants = store.grants
          .filter((g) => g.projectId === projectId)
          .map((g) => {
            if (g.subjectType !== 'user') {
              return g
            }
            const user = store.users.get(g.subjectId)
            return user ? { ...g, username: user.username } : g
          })
        return json(res, 200, { grants })
      }

      if (req.method === 'PUT' && action === '/grants') {
        if (!auditAllowsMutations(res, traceId)) return
        if (!isAdmin(authed.user) && !authed.user.roles.includes('project:owner')) {
          return error(res, 403, 'PERMISSION_DENIED', '需要平台管理权限。', traceId)
        }
        const body = await readJson(req)
        const subjectType = body.subjectType === 'group' ? 'group' : 'user'
        const submitted = String(body.subjectId ?? '').trim()
        const permissions = Array.isArray(body.permissions)
          ? (body.permissions as Permission[])
          : []
        // The ACL matches on the user id, so a username has to be resolved here:
        // storing it verbatim would mint a grant that reads as granted and never
        // fires (M116-QA-001). An unknown user is refused, not stored dead.
        let subjectId = submitted
        let username: string | null = null
        if (subjectType === 'user') {
          const user = store.users.get(submitted) ?? store.usersByName.get(submitted)
          if (!user) {
            return error(res, 400, 'USER_NOT_FOUND', '用户不存在。', traceId)
          }
          subjectId = user.id
          username = user.username
        }
        if (
          !(await recordAudit(
            res,
            {
              eventType: 'grant_update',
              actor: authed.user.username,
              targetType: 'project',
              targetId: projectId,
              result: 'success',
              traceId,
              metadata: { subjectType, subjectId, ...(username ? { username } : {}), permissions }
            },
            traceId
          ))
        ) {
          return
        }
        store.grants = store.grants.filter(
          (g) =>
            !(
              g.projectId === projectId &&
              g.subjectType === subjectType &&
              // A pre-fix row may still be keyed by the submitted username; a
              // re-grant retires it too, or the matrix keeps showing a dead
              // duplicate that matches nobody (M116-QA-001).
              (g.subjectId === subjectId || g.subjectId === submitted)
            )
        )
        if (permissions.length > 0) {
          store.grants.push({ projectId, subjectType, subjectId, permissions })
        }
        // Why scoped for users: the host cannot resolve group membership, so a
        // group edit has to close the project; a user's own edit must not
        // disconnect everyone else working on it (AC-12).
        const subject = subjectType === 'user' ? store.users.get(subjectId) : undefined
        if (subject) {
          revokeUserCredentials(subject.username, 'grant_changed')
        } else {
          revokeProjectCredentials(projectId, 'grant_changed')
        }
        return json(res, 200, { ok: true })
      }

      if (archiveAction) {
        const selfService = isProjectCreator(found, authed.user.username) && !isAdmin(authed.user)
        if (!isAdmin(authed.user) && !selfService) {
          // Same payload as unknown/unreadable: never leak the project's existence.
          return error(res, 404, 'PROJECT_NOT_FOUND', '项目不存在或无权访问。', traceId)
        }
        if (action === '/archive') {
          if (found.status !== 'archived') {
            if (
              !(await recordAudit(
                res,
                {
                  eventType: 'project_archive',
                  actor: authed.user.username,
                  targetType: 'project',
                  targetId: projectId,
                  result: 'success',
                  traceId,
                  metadata: { selfService }
                },
                traceId
              ))
            ) {
              return
            }
            found.status = 'archived'
            if (store.projectsByKey.get(found.key)?.id === found.id) {
              store.projectsByKey.delete(found.key)
            }
            // Why: live host sockets only learn about an archived project here.
            revokeProjectCredentials(projectId, 'project_archived')
          }
          return json(res, 200, projectView(found, authed.user, platformOrigin))
        }
        const conflict = projectKeyTaken(store, found.key, found.id)
          ? ('PROJECT_KEY_TAKEN' as const)
          : projectPathTaken(store, found.path, found.id)
            ? ('PROJECT_PATH_TAKEN' as const)
            : null
        if (conflict !== null) {
          if (
            !(await recordAudit(
              res,
              {
                eventType: 'project_restore',
                actor: authed.user.username,
                targetType: 'project',
                targetId: projectId,
                result: 'failure',
                traceId,
                metadata: { selfService, reason: conflict }
              },
              traceId
            ))
          ) {
            return
          }
          return error(
            res,
            409,
            conflict,
            conflict === 'PROJECT_KEY_TAKEN'
              ? '项目 Key 已被占用，无法恢复。'
              : '项目路径已被占用，无法恢复。',
            traceId
          )
        }
        if (
          !(await recordAudit(
            res,
            {
              eventType: 'project_restore',
              actor: authed.user.username,
              targetType: 'project',
              targetId: projectId,
              result: 'success',
              traceId,
              metadata: { selfService }
            },
            traceId
          ))
        ) {
          return
        }
        found.status = found.repoUrl ? 'provisioning' : 'ready'
        delete found.provisioningError
        store.projectsByKey.set(found.key, found)
        return json(res, 200, projectView(found, authed.user, platformOrigin))
      }

      if (req.method === 'GET' && action === '/policy') {
        const effective =
          found.downloadPolicyExplicit === true
            ? found.downloadPolicy
            : store.policies.downloadDefault
        return json(res, 200, {
          downloadPolicy: found.downloadPolicy,
          effective,
          globalDefault: store.policies.downloadDefault,
          readRatePerHour: found.readRatePerHour ?? store.policies.readRatePerHour,
          globalReadRatePerHour: store.policies.readRatePerHour,
          version: store.policies.version
        })
      }

      if (req.method === 'PUT' && action === '/policy') {
        if (!isAdmin(authed.user)) {
          return denyPrivileged(res, traceId, authed.user, {
            eventType: 'policy_update',
            targetType: 'project',
            targetId: found.id,
            permission: 'platform:admin'
          })
        }
        const body = await readJson(req)
        if (!auditAllowsMutations(res, traceId)) return
        // `inherit: true` is the only way back to following the global default:
        // it drops the explicit flag and ignores any downloadPolicy in the body.
        // Old clients never send it, so their requests take the pinned branch.
        const inherit = body.inherit === true
        const nextPolicy = body.downloadPolicy === 'allow' ? 'allow' : 'deny'
        const rate = parseReadRate(body.readRatePerHour)
        if (rate.kind === 'invalid') {
          return error(res, 400, 'POLICY_INVALID', '读取限速必须是大于 0 的 calls/bytes。', traceId)
        }
        // Why write-ahead: same rule as every other sensitive write (M32) — a policy
        // change that cannot be recorded must not take effect.
        if (
          !(await recordAudit(
            res,
            {
              eventType: 'policy_update',
              actor: authed.user.username,
              targetType: 'project',
              targetId: projectId,
              result: 'success',
              traceId,
              metadata: {
                // An inherit must not log the ignored downloadPolicy as if it applied.
                ...(inherit ? { inherited: true } : { downloadPolicy: nextPolicy }),
                ...(rate.kind === 'set' ? { readRatePerHour: rate.rate } : {}),
                ...(rate.kind === 'clear' ? { readRatePerHour: null } : {})
              }
            },
            traceId
          ))
        ) {
          return
        }
        if (inherit) {
          delete found.downloadPolicyExplicit
        } else {
          found.downloadPolicy = nextPolicy
          found.downloadPolicyExplicit = true
        }
        if (rate.kind === 'set') {
          found.readRatePerHour = rate.rate
        } else if (rate.kind === 'clear') {
          delete found.readRatePerHour
        }
        store.policies.version += 1
        return json(res, 200, {
          downloadPolicy: found.downloadPolicy,
          readRatePerHour: found.readRatePerHour ?? store.policies.readRatePerHour,
          version: store.policies.version
        })
      }
    }

    // ---- hosts ----
    // Relays are managed apart from dev hosts: their own page, own endpoint.
    if (req.method === 'GET' && path === '/v1/relays') {
      const authed = requireAuth()
      if (!authed) return
      if (!isAdmin(authed.user)) {
        return denyPrivileged(res, traceId, authed.user, {
          eventType: 'relay_list',
          targetType: 'relay',
          permission: 'platform:admin'
        })
      }
      return json(res, 200, {
        relays: relayNodes.all().map((node) => ({
          id: node.id,
          host: node.host,
          browserHost: node.browserHost,
          port: node.port,
          online: now() - node.lastSeenAt <= relayAliveMs,
          lastSeenAt: node.lastSeenAt
        }))
      })
    }

    if (req.method === 'GET' && path === '/v1/hosts') {
      const authed = requireAuth()
      if (!authed) return
      if (!isAdmin(authed.user)) {
        return denyPrivileged(res, traceId, authed.user, {
          eventType: 'host_list',
          targetType: 'host',
          permission: 'platform:admin'
        })
      }
      return json(res, 200, {
        hosts: [...store.hosts.values()].map((h) => ({
          ...h,
          credentialHash: undefined,
          online: hostOnline(h),
          browserEntryUrl: browserEntryUrlFor(h.relayRoute)
        }))
      })
    }

    if (req.method === 'GET' && path === '/v1/hosts/available') {
      const authed = requireAuth()
      if (!authed) return
      // Deliberately credential-free: developers may pick a host, not inspect one.
      return json(res, 200, {
        hosts: [...store.hosts.values()].map((h) => ({
          id: h.id,
          name: h.name,
          online: hostOnline(h),
          provisionable: Boolean(h.projectsRoot),
          projectDirs: h.projectDirs ?? []
        }))
      })
    }

    if (req.method === 'POST' && path === '/v1/hosts/tokens') {
      const authed = requireAuth()
      if (!authed) return
      if (!isAdmin(authed.user)) {
        return denyPrivileged(res, traceId, authed.user, {
          eventType: 'host_token_create',
          targetType: 'host',
          permission: 'platform:admin'
        })
      }
      if (!auditAllowsMutations(res, traceId)) return
      const token = randomBytes(24).toString('base64url')
      if (
        !(await recordAudit(
          res,
          {
            eventType: 'host_token_create',
            actor: authed.user.username,
            targetType: 'host',
            targetId: null,
            result: 'success',
            traceId
          },
          traceId
        ))
      ) {
        return
      }
      store.hostTokens.push({
        tokenHash: hashToken(token),
        expiresAt: now() + 24 * 60 * 60_000,
        usedAt: null
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
        projectsRoot: null,
        projectDirs: [],
        status: 'online',
        maintenanceReason: null,
        lastHeartbeatAt: now(),
        credentialHash: null,
        revokedAt: null
      }
      target.fingerprint = String(body.fingerprint ?? '')
      target.tlsFingerprint = String(body.tlsFingerprint ?? '') || null
      target.e2eePublicKey = String(body.e2eePublicKeyB64 ?? '')
      target.orcaVersion = String(body.orcaVersion ?? '')
      target.protocolVersion = Number(body.protocolVersion ?? 3)
      target.zone = String(body.networkZone ?? 'intranet')
      target.directAddrs = Array.isArray(body.directAddrs) ? (body.directAddrs as string[]) : []
      // An absent relayRoute means the host named none: derive it from the address
      // it advertises rather than the hostname (M114a). Explicit values are kept as is.
      const previousRoute = target.relayRoute
      target.relayRoute =
        String(body.relayRoute ?? '') || routeKeyFromDirectAddrs(target.directAddrs, name)
      target.capabilities = Array.isArray(body.runtimeCapabilities)
        ? (body.runtimeCapabilities as string[])
        : []
      applyProjectsRoot(target, body.projectsRoot, traceId)
      target.projectDirs = parseProjectDirs(body.projectDirs)
      target.status = 'online'
      target.lastHeartbeatAt = now()
      target.credentialHash = hashToken(credential)
      store.hosts.set(target.id, target)
      store.hostsByName.set(target.name, target)
      const relayTarget = String(body.relayTarget ?? '')
      const routeTarget = relayTarget || target.directAddrs[0]
      if (target.relayRoute && routeTarget) {
        // A re-registration that changed the key must not leave the old label resolving.
        if (
          previousRoute &&
          previousRoute !== target.relayRoute &&
          store.relayRoutes.get(previousRoute)?.hostId === target.id
        ) {
          store.relayRoutes.delete(previousRoute)
        }
        store.relayRoutes.set(target.relayRoute, {
          routeKey: target.relayRoute,
          hostId: target.id,
          target: routeTarget,
          version: store.policies.version
        })
      }
      await audit.append({
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
        // Why: a revoked host keeps its credential so this beat can deliver the
        // revocation; it must not look alive or accept any more reported state.
        // A refused root keeps the old one; the beat still answers so the host
        // can report why its own view of the root no longer matches.
        let projectsRootAccepted = true
        if (target.revokedAt === null) {
          if (Array.isArray(body.directAddrs) && body.directAddrs.length > 0) {
            target.directAddrs = body.directAddrs as string[]
            // A host that moved keeps its derived label resolvable (M114a).
            syncHostRoute(target)
            ensureHostRoute(target)
          }
          if (Array.isArray(body.projectDirs)) {
            target.projectDirs = parseProjectDirs(body.projectDirs)
          }
          // A host learns its own E2EE key only once its runtime has started, so the
          // heartbeat is where it first becomes reportable.
          if (typeof body.e2eePublicKeyB64 === 'string' && body.e2eePublicKeyB64.length > 0) {
            // Why audited: this key is handed to clients as the host's identity, so a
            // change is exactly what a substitution attempt would look like (AC-29).
            if (target.e2eePublicKey !== body.e2eePublicKeyB64) {
              const previous = target.e2eePublicKey
              audit.appendBestEffort({
                eventType: 'host_e2ee_key_changed',
                actor: null,
                targetType: 'host',
                targetId: target.id,
                result: 'success',
                traceId,
                metadata: {
                  ...(previous ? { previousFingerprint: e2eeKeyFingerprint(previous) } : {}),
                  fingerprint: e2eeKeyFingerprint(body.e2eePublicKeyB64)
                }
              })
            }
            target.e2eePublicKey = body.e2eePublicKeyB64
          }
          // The TLS certificate clients will see on the direct address. A change is
          // as much a substitution signal as an E2EE key change (design §5.3).
          if (typeof body.tlsFingerprint === 'string' && body.tlsFingerprint.length > 0) {
            if (target.tlsFingerprint !== body.tlsFingerprint) {
              audit.appendBestEffort({
                eventType: 'host_tls_fingerprint_changed',
                actor: null,
                targetType: 'host',
                targetId: target.id,
                result: 'success',
                traceId,
                metadata: {
                  ...(target.tlsFingerprint ? { previousFingerprint: target.tlsFingerprint } : {}),
                  fingerprint: body.tlsFingerprint
                }
              })
            }
            target.tlsFingerprint = body.tlsFingerprint
          }
          if (typeof body.status === 'string' && target.status !== 'maintenance') {
            target.status = body.status === 'online' ? 'online' : 'offline'
          }
          projectsRootAccepted = applyProjectsRoot(target, body.projectsRoot, traceId)
          applyProjectProvisionReports(target.id, body.provisioned, traceId)
          target.lastHeartbeatAt = now()
        }
        // Why outside the revoked guard: a host's last refusal before it is cut
        // off still belongs in the chain, and this never fails the beat.
        // Why outside the revoked guard: a host's last refusal before it is cut
        // off still belongs in the chain, and this never fails the beat.
        appendHostAuditReports(audit, target, parseHostAuditReports(body.audit), traceId)
        const revoked = store.revocations.filter((r) => r.targetType !== 'jti')
        // U37 downlink. Derived after the provision reports above are applied, so a
        // clone reported ok in this same beat is never re-assigned. Revoked hosts
        // must not look alive, and maintenance hosts take no new assignments (§8①)
        // — both resume with the next beat after restoration.
        const provisionAssignments =
          target.revokedAt === null && target.status !== 'maintenance'
            ? pendingProvisionAssignments(target.id)
            : []
        if (provisionAssignments.length > 0) {
          // One batched audit per non-empty beat (§8②), never one per assignment.
          audit.appendBestEffort({
            eventType: 'provision_assign',
            actor: null,
            targetType: 'host',
            targetId: target.id,
            result: 'success',
            traceId,
            metadata: {
              count: provisionAssignments.length,
              projectIds: provisionAssignments.map((a) => a.projectId)
            }
          })
        }
        return json(res, 200, {
          ...(target.revokedAt !== null ? { hostRevoked: true } : {}),
          // Optional so older hosts that ignore it stay on the wire untouched.
          ...(projectsRootAccepted ? {} : { projectsRootRejected: 'PROJECTS_ROOT_CONFLICT' }),
          // Same wire-additive guarantee as projectsRootRejected above (U21
          // precedent): an old host's sendHeartbeat whitelists the fields it knows
          // (cloud-host-enrollment.ts), so a key it has never heard of is structurally
          // invisible to it and its behaviour is byte-for-byte unchanged; the U37-B
          // executor picks it up via readField and parses it defensively.
          ...(provisionAssignments.length > 0 ? { provisionAssignments } : {}),
          policyVersion: store.policies.version,
          policies: {
            downloadDefault: store.policies.downloadDefault,
            projectOverrides: Object.fromEntries(
              [...store.projects.values()]
                .filter((p) => p.downloadPolicyExplicit === true)
                .map((p) => [p.id, p.downloadPolicy])
            ),
            readRatePerHour: store.policies.readRatePerHour,
            rateOverrides: Object.fromEntries(
              [...store.projects.values()]
                .filter((p) => p.readRatePerHour !== undefined)
                .map((p) => [p.id, p.readRatePerHour])
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
          maintenance:
            target.status === 'maintenance' ? { reason: target.maintenanceReason } : null,
          serverTime: now()
        })
      }

      if (req.method === 'POST' && action === '/maintenance') {
        if (!authed) {
          return error(res, 401, 'SESSION_EXPIRED', '登录已过期，请重新登录。', traceId)
        }
        if (!isAdmin(authed.user)) {
          return denyPrivileged(res, traceId, authed.user, {
            eventType: 'host_maintenance',
            targetType: 'host',
            targetId: hostId,
            permission: 'platform:admin'
          })
        }
        if (!auditAllowsMutations(res, traceId)) return
        // Revocation is terminal: maintenance would flip a dead host back to a
        // live-looking status (M116-QA-006).
        if (target.revokedAt !== null) {
          return error(res, 409, 'HOST_REVOKED', '主机已下线，不能再进入维护模式。', traceId)
        }
        const body = await readJson(req)
        const nextStatus = body.enabled === false ? 'online' : 'maintenance'
        const nextReason = body.reason ? String(body.reason) : '计划维护'
        if (
          !(await recordAudit(
            res,
            {
              eventType: 'host_maintenance',
              actor: authed.user.username,
              targetType: 'host',
              targetId: hostId,
              result: 'success',
              traceId,
              metadata: { enabled: nextStatus === 'maintenance', reason: nextReason }
            },
            traceId
          ))
        ) {
          return
        }
        target.status = nextStatus
        target.maintenanceReason = nextReason
        return json(res, 200, { status: target.status })
      }

      if (req.method === 'DELETE' && action === '') {
        if (!authed) {
          return error(res, 401, 'SESSION_EXPIRED', '登录已过期，请重新登录。', traceId)
        }
        if (!isAdmin(authed.user)) {
          return denyPrivileged(res, traceId, authed.user, {
            eventType: 'host_revoke',
            targetType: 'host',
            targetId: hostId,
            permission: 'platform:admin'
          })
        }
        const revokedAt = now()
        target.status = 'offline'
        target.revokedAt = revokedAt
        if (target.relayRoute) store.relayRoutes.delete(target.relayRoute)
        for (const p of store.projects.values()) {
          if (p.hostId === hostId) revokeProjectCredentials(p.id, 'host_revoked')
        }
        await audit.append({
          eventType: 'host_revoke',
          actor: authed.user.username,
          targetType: 'host',
          targetId: hostId,
          result: 'success',
          traceId,
          metadata: { revokedAt }
        })
        return json(res, 200, { ok: true })
      }
    }

    // ---- audit ----
    if (req.method === 'GET' && path === '/v1/audit/events') {
      const authed = requireAuth()
      if (!authed) return
      if (!isAdmin(authed.user) && !authed.user.roles.includes('platform:auditor')) {
        return denyPrivileged(res, traceId, authed.user, {
          eventType: 'audit_query',
          targetType: 'audit',
          permission: 'platform:auditor'
        })
      }
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 200)
      const sinceParam = url.searchParams.get('since')
      const since = sinceParam ? Date.parse(sinceParam) : undefined
      if (since && now() - since > 31 * 24 * 60 * 60_000) {
        return error(res, 400, 'TIME_WINDOW_TOO_LARGE', '查询时间窗最大 31 天。', traceId)
      }
      const page = await audit.query({
        actor: url.searchParams.get('actor') ?? undefined,
        eventType: url.searchParams.get('eventType') ?? undefined,
        result: url.searchParams.get('result') ?? undefined,
        traceId: url.searchParams.get('traceId') ?? undefined,
        since,
        limit,
        cursor: url.searchParams.get('cursor') ? Number(url.searchParams.get('cursor')) : undefined
      })
      return json(res, 200, page)
    }

    // ---- audit: write health ----
    if (req.method === 'GET' && path === '/v1/audit/status') {
      const authed = requireAuth()
      if (!authed) return
      if (!isAdmin(authed.user) && !authed.user.roles.includes('platform:auditor')) {
        return denyPrivileged(res, traceId, authed.user, {
          eventType: 'audit_query',
          targetType: 'audit',
          permission: 'platform:auditor'
        })
      }
      const health = audit.getHealth()
      return json(res, 200, { ...health, persisted: auditLogPath !== null })
    }

    // ---- audit: chain integrity ----
    if (req.method === 'GET' && path === '/v1/audit/verify') {
      const authed = requireAuth()
      if (!authed) return
      if (!isAdmin(authed.user) && !authed.user.roles.includes('platform:auditor')) {
        return denyPrivileged(res, traceId, authed.user, {
          eventType: 'audit_verify',
          targetType: 'audit',
          permission: 'platform:auditor'
        })
      }
      // Verify the chain as it stands, then record the attempt: the attempt itself
      // must be auditable, but it cannot be part of what it reports on.
      const verdict = await audit.verify()
      audit.appendBestEffort({
        eventType: 'audit_verify',
        actor: authed.user.username,
        targetType: 'audit',
        targetId: null,
        result: verdict.ok ? 'success' : 'denied',
        traceId,
        metadata: verdict.ok
          ? { checked: verdict.checked }
          : { checked: verdict.checked, brokenAtSeq: verdict.brokenAtSeq }
      })
      return json(res, verdict.ok ? 200 : 409, verdict)
    }

    // ---- policies ----
    if (path === '/v1/policies/download') {
      const authed = requireAuth()
      if (!authed) return
      if (req.method === 'GET') {
        return json(res, 200, {
          downloadDefault: store.policies.downloadDefault,
          readRatePerHour: store.policies.readRatePerHour,
          version: store.policies.version
        })
      }
      if (req.method === 'PUT') {
        if (!isAdmin(authed.user)) {
          return denyPrivileged(res, traceId, authed.user, {
            eventType: 'policy_update',
            targetType: 'policy',
            targetId: 'download',
            permission: 'platform:admin'
          })
        }
        if (!auditAllowsMutations(res, traceId)) return
        const body = await readJson(req)
        const nextDefault = body.downloadDefault === 'allow' ? 'allow' : 'deny'
        const rate = parseReadRate(body.readRatePerHour)
        if (rate.kind === 'invalid' || rate.kind === 'clear') {
          return error(res, 400, 'POLICY_INVALID', '读取限速必须是大于 0 的 calls/bytes。', traceId)
        }
        if (
          !(await recordAudit(
            res,
            {
              eventType: 'policy_update',
              actor: authed.user.username,
              targetType: 'policy',
              targetId: 'download',
              result: 'success',
              traceId,
              metadata: {
                downloadDefault: nextDefault,
                ...(rate.kind === 'set' ? { readRatePerHour: rate.rate } : {})
              }
            },
            traceId
          ))
        ) {
          return
        }
        store.policies.downloadDefault = nextDefault
        if (rate.kind === 'set') {
          store.policies.readRatePerHour = rate.rate
        }
        store.policies.version += 1
        return json(res, 200, {
          downloadDefault: store.policies.downloadDefault,
          readRatePerHour: store.policies.readRatePerHour,
          version: store.policies.version
        })
      }
    }

    if (path === '/v1/internal/relay-endpoint' && req.method === 'POST') {
      const token = req.headers['x-internal-token']
      if (token !== internalToken) {
        return error(res, 401, 'INTERNAL_TOKEN_INVALID', '内部令牌无效。', traceId)
      }
      const body = await readJson(req)
      const registration = parseRelayRegistration(body)
      if (!registration) {
        return error(res, 400, 'RELAY_PORT_INVALID', '中继端口无效。', traceId)
      }
      relayPort = registration.port
      // Where clients dial this relay: what it announced, else the address it
      // registered from. A co-located test relay keeps today's 127.0.0.1.
      const source = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '')
      const node = relayNodes.register(
        { ...registration, ...(registration.host ? {} : { host: source }) },
        now()
      )
      return json(res, 200, {
        ok: true,
        relayPort,
        id: node.id,
        healthyRelays: relayNodes.healthy(now(), relayAliveMs).length
      })
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
          [...store.projects.values()]
            .filter((p) => p.downloadPolicyExplicit === true)
            .map((p) => [p.id, p.downloadPolicy])
        ),
        readRatePerHour: store.policies.readRatePerHour,
        rateOverrides: Object.fromEntries(
          [...store.projects.values()]
            .filter((p) => p.readRatePerHour !== undefined)
            .map((p) => [p.id, p.readRatePerHour])
        )
      })
    }

    // ---- relay routes (internal) ----
    if (path === '/v1/internal/relays' && req.method === 'GET') {
      const token = req.headers['x-internal-token']
      if (token !== internalToken) {
        return error(res, 401, 'INTERNAL_TOKEN_INVALID', '内部令牌无效。', traceId)
      }
      return json(res, 200, {
        aliveMs: relayAliveMs,
        relays: relayNodes.all().map((node) => ({
          ...node,
          online: now() - node.lastSeenAt <= relayAliveMs
        }))
      })
    }

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

  /**
   * FR-3.10: mints the one-time code a browser trades at /v1/web/handoff, so no
   * access token ever rides in a URL. Only a caller who could redeem the code
   * may mint one, and the entry is a relay browser edge when one is alive (a
   * browser cannot fail over the way a desktop client probes its endpoints),
   * else the host's TLS direct address in its web-index form; anything short of
   * that gets a 4xx instead of handing the developer a dead or mispointed link.
   */
  function handleWebHandoff(
    res: ServerResponse,
    user: User,
    project: Project,
    traceId: string,
    platformOrigin: string
  ): void {
    // Same grant predicate as redemption: adminAccess only widens which projects
    // a caller can see, never the right to open one, so a code that could only
    // ever redeem 403 is refused here instead of minting a dead entry.
    if (!store.effectivePermissions(project.id, user).includes('open')) {
      audit.appendBestEffort({
        eventType: 'web_handoff',
        actor: user.username,
        targetType: 'project',
        targetId: project.id,
        result: 'denied',
        traceId,
        metadata: { reason: 'permission_lost' }
      })
      return error(res, 403, 'PROJECT_FORBIDDEN', '项目无权限，无法打开。', traceId, {
        reason: 'permission_lost'
      })
    }
    const host = store.hosts.get(project.hostId)
    if (!host) return error(res, 404, 'HOST_NOT_FOUND', '主机不存在。', traceId)
    if (host.revokedAt !== null) {
      return error(res, 409, 'HOST_REVOKED', '主机已被吊销，无法打开项目。', traceId)
    }
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
    // A live browser edge serves the page through the relay, so the host's own
    // direct address stops being a precondition (a relayed host may list none).
    const browserEntry = browserEntryUrlFor(host.relayRoute)
    const directAddr = host.directAddrs[0]
    if (browserEntry === '' && (!directAddr || !isDirectAddrForm(directAddr))) {
      audit.appendBestEffort({
        eventType: 'web_handoff',
        actor: user.username,
        targetType: 'project',
        targetId: project.id,
        result: 'denied',
        traceId,
        metadata: { reason: 'host_unavailable', hostId: host.id }
      })
      return error(res, 400, 'HOST_UNAVAILABLE', '开发机没有可直达的 Web 入口地址。', traceId)
    }
    store.pruneExpiredWebHandoffs(now())
    const code = randomBytes(32).toString('base64url')
    store.webHandoffs.set(code, {
      userId: user.id,
      projectId: project.id,
      expiresAt: now() + handoffTtlMs
    })
    audit.appendBestEffort({
      eventType: 'web_handoff',
      actor: user.username,
      targetType: 'project',
      targetId: project.id,
      result: 'success',
      traceId,
      metadata: {
        hostId: host.id,
        codeFingerprint: codeFingerprint(code),
        ttlSeconds: Math.ceil(handoffTtlMs / 1000)
      }
    })
    const entry = browserEntry !== '' ? browserEntry : `https://${directAddr}/web-index.html`
    const page = new URL(entry)
    // The page is served by the host or relay, so `?api=` is how it finds the
    // platform to trade the code on (same channel as the admin session page).
    page.searchParams.set('api', platformOrigin)
    return json(res, 201, {
      url: `${page.toString()}#handoff=${code}&project=${project.id}`,
      expiresIn: Math.ceil(handoffTtlMs / 1000)
    })
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
    if (host.revokedAt !== null) {
      return error(res, 409, 'HOST_REVOKED', '主机已被吊销，无法打开项目。', traceId)
    }
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
    // Why here: the host's provision reports are trustworthy (W12b-2), so a
    // non-ready project must fail at the platform, not at the host's provision RPC.
    if (project.status === 'failed') {
      await audit.append({
        eventType: 'project_connect',
        actor: user.username,
        targetType: 'project',
        targetId: project.id,
        result: 'denied',
        traceId,
        metadata: {
          reason: 'PROJECT_NOT_PREPARED',
          status: project.status,
          ...(project.provisioningError ? { error: project.provisioningError } : {})
        }
      })
      // Why the error travels: the project list already shows the same field.
      return error(res, 409, 'PROJECT_NOT_PREPARED', '项目准备失败，暂无法打开。', traceId, {
        status: project.status,
        ...(project.provisioningError ? { provisioningError: project.provisioningError } : {})
      })
    }
    if (project.status === 'provisioning') {
      return error(res, 409, 'PROJECT_PROVISIONING', '项目正在准备中，请稍后重试。', traceId, {
        status: project.status
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
      await audit.append({
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
      // Optional claims: the host provisions from the ticket, never from client params.
      repoUrl: project.repoUrl,
      defaultBranch: project.defaultBranch,
      deviceId: device.id,
      devicePubKey: device.publicKey || devicePubKey,
      deviceToken: newDeviceToken(),
      perms: permissions,
      iat: nowS,
      iatMs: now(),
      exp: nowS + CREDENTIAL_TTL_S
    }
    const credential = signCredential(payload, signingKeys.current())
    await audit.append({
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
        capabilities: host.capabilities,
        browserEntryUrl: browserEntryUrlFor(host.relayRoute)
      },
      endpoints: {
        direct: host.directAddrs.map((url, index) => ({
          priority: index + 1,
          url: `wss://${url}`
        })),
        relay: host.relayRoute ? relayEndpointsFor(host.relayRoute) : []
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

  /**
   * A ticket's `sub` is `user:<username>`, so a user-scoped revocation must carry
   * the username — the host compares against that claim, not the user id.
   */
  function revokeUserCredentials(username: string, reason: string): void {
    appendRevocation('user', username, reason)
  }

  let relayPort = 18080
  const relayNodes = createRelayNodeRegistry()
  const relayAliveMs = Number(process.env.ORCA_CLOUD_RELAY_ALIVE_MS ?? RELAY_ALIVE_DEFAULT_MS)

  const webReleases = createWebReleaseStore({
    webRoot: config.webRoot ?? WEB_ROOT,
    ...(config.webReleaseArchiveDir ? { archiveDir: config.webReleaseArchiveDir } : {})
  })
  webReleases.archive()

  /** Hashed assets are immutable; the hashed path is what makes an old page keep working. */
  function serveAsset(path: string, res: ServerResponse): boolean {
    const match = path.match(/^\/assets\/([0-9a-f]{6,32})\/([\w.-]+)$/)
    if (!match) {
      return false
    }
    const asset = webReleases.resolve(match[1], match[2])
    if (!asset) {
      return false
    }
    res.writeHead(200, {
      'content-type': asset.contentType,
      'cache-control': 'public, max-age=31536000, immutable',
      etag: `"${asset.sha256}"`
    })
    res.end(asset.bytes)
    return true
  }

  async function serveStatic(path: string, res: ServerResponse): Promise<void> {
    if (serveAsset(path, res)) {
      return
    }
    const rel = path === '/' ? 'index.html' : decodeURIComponent(path).replace(/^\//, '')
    const name = normalize(rel).replace(/^(\.\.[/\\])+/, '')
    const current = webReleases.current().files.get(name)
    if (current) {
      // Why no-store on the entry point and no-cache on legacy paths: a deploy
      // must be picked up, while an already-cached old page still resolves here.
      const isEntry = name === 'index.html'
      res.writeHead(200, {
        'content-type': current.contentType,
        'cache-control': isEntry ? 'no-store' : 'no-cache',
        etag: `"${current.sha256}"`,
        'x-orca-web-build': webReleases.current().build
      })
      res.end(isEntry ? webReleases.indexHtml() : current.bytes)
      return
    }
    try {
      const target = join(config.webRoot ?? WEB_ROOT, name)
      const data = await readFile(target)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(data)
    } catch {
      res.writeHead(404)
      res.end('not found')
    }
  }

  const requestListener = (req: IncomingMessage, res: ServerResponse): void => {
    handle(req, res).catch((err: unknown) => {
      error(res, 500, 'INTERNAL_ERROR', err instanceof Error ? err.message : 'unknown error')
    })
  }
  // U41: TLS only swaps the transport — the handler, routes and port stay as-is.
  const server = config.publicTls
    ? createHttpsServer(
        {
          key: readFileSync(config.publicTls.keyPath),
          cert: readFileSync(config.publicTls.certPath),
          minVersion: 'TLSv1.2'
        },
        requestListener
      )
    : createServer(requestListener)

  const isInternalPath = (path: string): boolean => path.startsWith('/v1/internal/')
  let internalChannel: { port: number; close: () => Promise<void> } | null = null

  return {
    setRelayPort(port: number) {
      relayPort = port
    },
    internalPort: () => internalChannel?.port ?? null,
    store,
    audit,
    get signingKey() {
      return signingKeys.current()
    },
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
        server.listen(config.port, '127.0.0.1', () =>
          resolve((server.address() as { port: number }).port)
        )
      })
    }
  }
}

function ttlFromEnv(name: string): number | undefined {
  const raw = process.env[name]
  if (!raw) return undefined
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const accessTtlMs = ttlFromEnv('ORCA_CLOUD_ACCESS_TTL_MS')
  const refreshTtlMs = ttlFromEnv('ORCA_CLOUD_REFRESH_TTL_MS')
  const handoffTtlMs = ttlFromEnv('ORCA_CLOUD_HANDOFF_TTL_MS')
  const app = createApp({
    port: Number(process.env.PORT ?? 18787),
    ...(accessTtlMs === undefined ? {} : { accessTtlMs }),
    ...(refreshTtlMs === undefined ? {} : { refreshTtlMs }),
    ...(handoffTtlMs === undefined ? {} : { handoffTtlMs }),
    ...(process.env.ORCA_CLOUD_LOGIN_LOCKOUT_URL
      ? { loginLockoutUrl: process.env.ORCA_CLOUD_LOGIN_LOCKOUT_URL }
      : {}),
    ...(process.env.ORCA_CLOUD_AUDIT_WRITER_URL
      ? { auditWriterUrl: process.env.ORCA_CLOUD_AUDIT_WRITER_URL }
      : {}),
    ...(process.env.ORCA_CLOUD_AUDIT_WRITER_URLS
      ? { auditWriterUrls: process.env.ORCA_CLOUD_AUDIT_WRITER_URLS.split(',') }
      : {}),
    ...(process.env.ORCA_CLOUD_WEB_ROOT ? { webRoot: process.env.ORCA_CLOUD_WEB_ROOT } : {}),
    ...(process.env.ORCA_CLOUD_WEB_ARCHIVE
      ? { webReleaseArchiveDir: process.env.ORCA_CLOUD_WEB_ARCHIVE }
      : {}),
    internalTls:
      process.env.INTERNAL_TLS_KEY && process.env.INTERNAL_TLS_CERT && process.env.INTERNAL_TLS_CA
        ? {
            port: Number(process.env.INTERNAL_TLS_PORT ?? 0),
            keyPath: process.env.INTERNAL_TLS_KEY,
            certPath: process.env.INTERNAL_TLS_CERT,
            caPath: process.env.INTERNAL_TLS_CA,
            allowedCNs: (process.env.INTERNAL_TLS_ALLOWED_CNS ?? '').split(',').filter(Boolean)
          }
        : undefined,
    publicTls:
      process.env.PLATFORM_TLS_CERT_PATH && process.env.PLATFORM_TLS_KEY_PATH
        ? {
            certPath: process.env.PLATFORM_TLS_CERT_PATH,
            keyPath: process.env.PLATFORM_TLS_KEY_PATH
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
  console.log(
    `[api] listening on ${process.env.PLATFORM_TLS_CERT_PATH ? 'https' : 'http'}://127.0.0.1:${port} (kid=${app.signingKey.kid})`
  )
  if (internal) console.log(`[api] internal mTLS on https://127.0.0.1:${internal}`)
}
