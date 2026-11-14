import { randomBytes, randomUUID } from 'node:crypto'
import type { Permission } from '../../../packages/contract/src/credential.ts'

export type User = {
  id: string
  username: string
  displayName: string
  dept: string
  email: string
  groups: string[]
  roles: string[]
  status: 'active' | 'disabled'
}

export type Device = {
  id: string
  userId: string
  name: string
  publicKey: string
  revokedAt: number | null
}

export type Session = {
  id: string
  userId: string
  deviceId: string
  epoch: number
  refreshHash: string
  refreshExpiresAt: number
  revokedAt: number | null
}

export type Host = {
  id: string
  name: string
  fingerprint: string
  tlsFingerprint: string | null
  e2eePublicKey: string
  orcaVersion: string
  protocolVersion: number
  zone: string
  directAddrs: string[]
  relayRoute: string | null
  capabilities: string[]
  /** Parent directory the platform may create self-service projects under. */
  projectsRoot: string | null
  /** First-level directory names the host reports under that root (FR-3.7). */
  projectDirs: string[]
  status: 'online' | 'offline' | 'maintenance'
  /** Who may self-service on this host; absent means open (pre-grant behaviour). */
  provisionPolicy?: 'open' | 'restricted'
  maintenanceReason: string | null
  lastHeartbeatAt: number
  credentialHash: string | null
  /** Set once revoked; the credential stays valid so the host can learn of it. */
  revokedAt: number | null
}

export type Project = {
  id: string
  key: string
  name: string
  repoUrl: string
  hostId: string
  path: string
  defaultBranch: string
  downloadPolicy: 'deny' | 'allow'
  /**
   * Set once an admin writes this project's policy. Only explicit values travel
   * as overrides, so the global default still governs untouched projects.
   */
  downloadPolicyExplicit?: boolean
  /** Project override of the global read budget; absent means inherit. */
  readRatePerHour?: { calls: number; bytes: number }
  status: 'provisioning' | 'ready' | 'archived' | 'failed'
  /** Last provisioning failure reported by the host; cleared once it succeeds. */
  provisioningError?: string
  /** Platform username that created the project; drives the per-user quota. */
  createdBy?: string | null
  createdAt: number
}

export type Grant = {
  projectId: string
  subjectType: 'user' | 'group'
  subjectId: string
  permissions: Permission[]
}

export type HostPermission = 'provision' | 'maintain' | 'view'

/** Platform-only host delegation; nothing here travels to the host (AA2). */
export type HostGrant = {
  hostId: string
  subjectType: 'user' | 'group'
  subjectId: string
  permissions: HostPermission[]
}

export type AuditEventInput = {
  eventType: string
  actor: string | null
  targetType: string | null
  targetId: string | null
  result: 'success' | 'failure' | 'denied'
  traceId: string | null
  metadata?: Record<string, unknown>
}

export type AuditEvent = AuditEventInput & {
  seq: number
  ts: number
  prevHash: string
  hash: string
}

export type Revocation = {
  targetType: 'user' | 'project' | 'jti' | 'device'
  targetId: string
  reason: string
  /** Epoch ms; credentials issued before this instant are no longer accepted. */
  at: number
}

export type RelayRoute = { routeKey: string; hostId: string; target: string; version: number }

export type HostToken = { tokenHash: string; expiresAt: number; usedAt: number | null }

/** A one-time web handoff code (FR-3.10), bound to its user and project. */
export type WebHandoff = { userId: string; projectId: string; expiresAt: number }

export class Store {
  users = new Map<string, User>()
  usersByName = new Map<string, User>()
  devices = new Map<string, Device>()
  sessions = new Map<string, Session>()
  accessTokens = new Map<
    string,
    { sessionId: string; userId: string; epoch: number; expiresAt: number }
  >()
  refreshTokens = new Map<string, string>()
  hosts = new Map<string, Host>()
  hostsByName = new Map<string, Host>()
  projects = new Map<string, Project>()
  projectsByKey = new Map<string, Project>()
  grants: Grant[] = []
  hostGrants: HostGrant[] = []
  revocations: Revocation[] = []
  relayRoutes = new Map<string, RelayRoute>()
  hostTokens: HostToken[] = []
  webHandoffs = new Map<string, WebHandoff>()
  policies = {
    downloadDefault: 'deny' as 'deny' | 'allow',
    version: 1,
    // Design §9.3: reads are bounded per project per rolling hour (calls and bytes).
    readRatePerHour: { calls: 600, bytes: 64 * 1024 * 1024 }
  }
  loginAttempts = new Map<string, { count: number; lockedUntil: number }>()
  audit: AuditEvent[] = []
  auditSeq = 0
  auditTip = 'GENESIS'

  seedUser(input: Omit<User, 'id'>): User {
    const user = { id: `user_${randomUUID()}`, ...input }
    this.users.set(user.id, user)
    this.usersByName.set(user.username, user)
    return user
  }

  createDevice(userId: string, name: string, publicKey: string): Device {
    const device: Device = {
      id: `dev_${randomBytes(6).toString('hex')}`,
      userId,
      name,
      publicKey,
      revokedAt: null
    }
    this.devices.set(device.id, device)
    return device
  }

  effectivePermissions(projectId: string, user: User): Permission[] {
    const grants = this.grants.filter(
      (g) =>
        g.projectId === projectId &&
        ((g.subjectType === 'user' && g.subjectId === user.id) ||
          (g.subjectType === 'group' && user.groups.includes(g.subjectId)))
    )
    const merged = new Set<Permission>()
    for (const grant of grants) for (const p of grant.permissions) merged.add(p)
    return [...merged]
  }

  /**
   * Consumes at most once and says which kind of miss it was: the audit splits
   * "expired" from "unknown/replayed" while the caller sees the same 410 either
   * way. The entry is removed before it is validated, so a second redemption of
   * the same code can never read as a fresh success.
   */
  consumeWebHandoff(
    code: string,
    now: number
  ): { ok: true; entry: WebHandoff } | { ok: false; reason: 'unknown' | 'expired' } {
    const entry = this.webHandoffs.get(code)
    if (!entry) return { ok: false, reason: 'unknown' }
    this.webHandoffs.delete(code)
    return entry.expiresAt > now ? { ok: true, entry } : { ok: false, reason: 'expired' }
  }

  /** Codes nobody redeemed are dropped on the next issuance instead of piling up. */
  pruneExpiredWebHandoffs(now: number): void {
    for (const [code, entry] of this.webHandoffs) {
      if (entry.expiresAt <= now) this.webHandoffs.delete(code)
    }
  }

  recordLoginFailure(username: string, now: number): { locked: boolean; remaining: number } {
    const record = this.loginAttempts.get(username) ?? { count: 0, lockedUntil: 0 }
    record.count += 1
    if (record.count >= 5) {
      record.lockedUntil = now + 15 * 60_000
      record.count = 0
    }
    this.loginAttempts.set(username, record)
    return {
      locked: record.lockedUntil > now,
      remaining: record.lockedUntil > now ? 0 : 5 - record.count
    }
  }

  clearLoginFailures(username: string): void {
    this.loginAttempts.delete(username)
  }

  isLocked(username: string, now: number): boolean {
    const record = this.loginAttempts.get(username)
    return Boolean(record && record.lockedUntil > now)
  }
}
