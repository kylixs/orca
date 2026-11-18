import type {
  AuditEvent,
  Device,
  Grant,
  Host,
  HostGrant,
  HostToken,
  InstallDownloadToken,
  Project,
  RelayRoute,
  Revocation,
  Session,
  User,
  WebHandoff
} from './store.ts'
import type { Store } from './store.ts'
import {
  DEFAULT_AUDIT_LIMIT,
  REFRESH_TOKEN_DIGEST_PREFIX,
  digestRefreshToken,
  type AccessTokenEntry,
  type Entry
} from './snapshot-serialize.ts'

/** Readers accept the legacy v1 shape and files written by the withdrawn v2 bump. */
const READABLE_SNAPSHOT_VERSIONS = new Set<unknown>([1, 2])

/**
 * Snapshot keys are digests; pre-U233 files carried plaintext, hashed on load.
 * U249 P2-1: a prefixed key is self-describing even without the marker (legacy
 * plaintext tokens are base64url and never contain `:`), so strip it first; a
 * v1 binary rewriting a newer file must not get its keys hashed a second time.
 */
function restoredRefreshTokenKey(key: string, hashed: boolean): string {
  if (key.startsWith(REFRESH_TOKEN_DIGEST_PREFIX)) {
    return key.slice(REFRESH_TOKEN_DIGEST_PREFIX.length)
  }
  return hashed ? key : digestRefreshToken(key)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function entriesOf<T>(value: unknown, field: string): Entry<T>[] {
  if (!Array.isArray(value)) { throw new Error(`snapshot ${field} is not an array`) }
  return value.map((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') { throw new Error(`snapshot ${field} has an invalid entry`) }
    return [entry[0], entry[1] as T]
  })
}

function arrayOf<T>(value: unknown, field: string): T[] {
  if (!Array.isArray(value)) { throw new Error(`snapshot ${field} is not an array`) }
  return value as T[]
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) { throw new Error(`snapshot ${field} is not a number`) }
  return value
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') { throw new Error(`snapshot ${field} is not a string`) }
  return value
}

/** Replaces the store contents from a snapshot string, rebuilding derived indexes. */
export function restoreSnapshot(
  store: Store,
  text: string,
  auditLimit = DEFAULT_AUDIT_LIMIT
): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('snapshot is not valid JSON')
  }
  if (!isRecord(parsed)) { throw new Error('snapshot is not an object') }
  if (!READABLE_SNAPSHOT_VERSIONS.has(parsed.version)) { throw new Error(`snapshot version ${String(parsed.version)} is not supported`) }
  if (!isRecord(parsed.policies)) { throw new Error('snapshot policies is not an object') }

  const users = entriesOf<User>(parsed.users, 'users')
  const hosts = entriesOf<Host>(parsed.hosts, 'hosts')
  const projects = entriesOf<Project>(parsed.projects, 'projects')
  const devices = entriesOf<Device>(parsed.devices, 'devices')
  const sessions = entriesOf<Session>(parsed.sessions, 'sessions')
  const accessTokens = entriesOf<AccessTokenEntry>(parsed.accessTokens, 'accessTokens')
  const refreshTokens = entriesOf<string>(parsed.refreshTokens, 'refreshTokens')
  const relayRoutes = entriesOf<RelayRoute>(parsed.relayRoutes, 'relayRoutes')
  const webHandoffs = entriesOf<WebHandoff>(parsed.webHandoffs, 'webHandoffs')
  const grants = arrayOf<Grant>(parsed.grants, 'grants')
  const hostGrants = arrayOf<HostGrant>(parsed.hostGrants, 'hostGrants')
  const revocations = arrayOf<Revocation>(parsed.revocations, 'revocations')
  const hostTokens = arrayOf<HostToken>(parsed.hostTokens, 'hostTokens')
  const installDownloadTokens = arrayOf<InstallDownloadToken>(parsed.installDownloadTokens, 'installDownloadTokens')
  const audit = arrayOf<AuditEvent>(parsed.audit, 'audit')
  const auditSeq = requireNumber(parsed.auditSeq, 'auditSeq')
  const auditTip = requireString(parsed.auditTip, 'auditTip')
  // v2 was the withdrawn version bump (U249); its keys are always prefixed.
  const hashedRefreshTokens = parsed.refreshTokensHashed === true || parsed.version === 2

  // U249 P2-3: validate and build locals before committing anything, so a failed
  // restore never leaves a half-applied snapshot in memory.
  const policies: Store['policies'] = {
    downloadDefault: parsed.policies.downloadDefault === 'allow' ? 'allow' : 'deny',
    version: requireNumber(parsed.policies.version, 'policies.version'),
    readRatePerHour: isRecord(parsed.policies.readRatePerHour)
      ? {
          calls: requireNumber(
            parsed.policies.readRatePerHour.calls,
            'policies.readRatePerHour.calls'
          ),
          bytes: requireNumber(
            parsed.policies.readRatePerHour.bytes,
            'policies.readRatePerHour.bytes'
          )
        }
      : store.policies.readRatePerHour
  }
  const refreshTokenEntries = refreshTokens.map(([key, sessionId]): Entry<string> => [
    restoredRefreshTokenKey(key, hashedRefreshTokens),
    sessionId
  ])
  // U249 P2-2: reading a malformed entry value (`users:[["u",null]]`) throws while
  // building the name indexes, so build all maps locally and commit in one place.
  const usersByName = new Map(users.map(([, user]) => [user.username, user]))
  const hostsByName = new Map(hosts.map(([, host]) => [host.name, host]))
  const projectsByKey = new Map(projects.map(([, project]) => [project.key, project]))

  // Commit point: nothing above may mutate the store, so a throw leaves it intact.
  store.users = new Map(users)
  store.usersByName = usersByName
  store.devices = new Map(devices)
  store.sessions = new Map(sessions)
  store.accessTokens = new Map(accessTokens)
  store.refreshTokens = new Map(refreshTokenEntries)
  store.hosts = new Map(hosts)
  store.hostsByName = hostsByName
  store.projects = new Map(projects)
  store.projectsByKey = projectsByKey
  store.grants = grants
  store.hostGrants = hostGrants
  store.revocations = revocations
  store.relayRoutes = new Map(relayRoutes)
  store.hostTokens = hostTokens
  store.installDownloadTokens = installDownloadTokens
  store.webHandoffs = new Map(webHandoffs)
  store.policies = policies
  // Truncated audit is intentional; `auditSeq`/`auditTip` keep the live chain tip.
  store.audit = auditLimit > 0 ? audit.slice(-auditLimit) : []
  store.auditSeq = auditSeq
  store.auditTip = auditTip
  // loginAttempts is deliberately not persisted: a lockout is process-local state.
}
