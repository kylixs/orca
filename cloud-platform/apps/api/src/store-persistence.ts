import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
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

/**
 * U131: dev-store snapshot on disk.
 *
 * The API store is in-memory, so a `--platform-only` restart used to come back
 * with no hosts: heartbeats for unknown ids answer 404 and a running host cannot
 * re-enrol. The snapshot keeps the store across restarts. Off by default — only
 * `ORCA_PLATFORM_STORE_FILE` enables it — so tests and the hosted platform keep
 * their current in-memory behaviour.
 */

/**
 * 1: refresh keys are `sha256:<digest>` (U233) and a pre-U233 binary can still load
 * users/sessions/projects from the file; only refresh fails, forcing re-login.
 * U249: the digest shape is marked by `refreshTokensHashed` instead of a version
 * bump, so rolling back to a v1 binary never wipes the rest of the state. Version 2
 * files (the short-lived bump) are still readable and rewritten as v1.
 */
export const SNAPSHOT_VERSION = 1
/** Readers accept the legacy v1 shape and files written by the withdrawn v2 bump. */
const READABLE_SNAPSHOT_VERSIONS = new Set<unknown>([1, 2])
export const DEFAULT_SNAPSHOT_INTERVAL_MS = 2_000
export const DEFAULT_AUDIT_LIMIT = 10_000

type Entry<T> = [string, T]
type WarnLog = { warn: (...args: unknown[]) => void }

/** Snapshot marker so a digest is never mistaken for a legacy plaintext key. */
const REFRESH_TOKEN_DIGEST_PREFIX = 'sha256:'

function digestRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Snapshot keys are digests; pre-U233 files carried plaintext, hashed on load. */
function restoredRefreshTokenKey(key: string, hashed: boolean): string {
  if (!hashed) {
    return digestRefreshToken(key)
  }
  return key.startsWith(REFRESH_TOKEN_DIGEST_PREFIX)
    ? key.slice(REFRESH_TOKEN_DIGEST_PREFIX.length)
    : key
}

type AccessTokenEntry = {
  sessionId: string
  userId: string
  epoch: number
  expiresAt: number
}

export type SnapshotDocument = {
  version: typeof SNAPSHOT_VERSION
  /** Marks prefixed digest keys without a version bump (U249). */
  refreshTokensHashed: true
  users: Entry<User>[]
  devices: Entry<Device>[]
  sessions: Entry<Session>[]
  accessTokens: Entry<AccessTokenEntry>[]
  refreshTokens: Entry<string>[]
  hosts: Entry<Host>[]
  projects: Entry<Project>[]
  grants: Grant[]
  hostGrants: HostGrant[]
  revocations: Revocation[]
  relayRoutes: Entry<RelayRoute>[]
  hostTokens: HostToken[]
  installDownloadTokens: InstallDownloadToken[]
  webHandoffs: Entry<WebHandoff>[]
  policies: Store['policies']
  audit: AuditEvent[]
  auditSeq: number
  auditTip: string
}

export type StorePersistenceOptions = {
  file: string
  intervalMs?: number
  auditLimit?: number
  log?: WarnLog
  /** Test seam replacing the atomic writer. */
  writeFile?: (file: string, text: string) => void
}

export type StorePersistenceHandle = {
  /** Writes synchronously when the serialized state changed since the last write. */
  flushNow: () => void
  /** Stops the timer and removes the signal handlers; does not delete the file. */
  stop: () => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function entriesOf<T>(value: unknown, field: string): Entry<T>[] {
  if (!Array.isArray(value)) {
    throw new Error(`snapshot ${field} is not an array`)
  }
  return value.map((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') {
      throw new Error(`snapshot ${field} has an invalid entry`)
    }
    return [entry[0], entry[1] as T]
  })
}

function arrayOf<T>(value: unknown, field: string): T[] {
  if (!Array.isArray(value)) {
    throw new Error(`snapshot ${field} is not an array`)
  }
  return value as T[]
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`snapshot ${field} is not a number`)
  }
  return value
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`snapshot ${field} is not a string`)
  }
  return value
}

/** Builds the on-disk shape; indexes and transient login locks are not persisted. */
export function snapshotOf(store: Store, auditLimit = DEFAULT_AUDIT_LIMIT): SnapshotDocument {
  const audit = auditLimit > 0 ? store.audit.slice(-auditLimit) : []
  return {
    version: SNAPSHOT_VERSION,
    refreshTokensHashed: true,
    users: [...store.users.entries()],
    devices: [...store.devices.entries()],
    // U197 v5: the plaintext current refresh is in-memory only (U216).
    sessions: [...store.sessions.entries()].map(([id, session]): Entry<Session> => {
      const persisted = { ...session }
      delete persisted.currentRefreshToken
      return [id, persisted]
    }),
    accessTokens: [...store.accessTokens.entries()],
    // U233 F6: the map is keyed by sha256(token), so no plaintext reaches disk.
    refreshTokens: [...store.refreshTokens.entries()].map(
      ([digest, sessionId]): Entry<string> => [`${REFRESH_TOKEN_DIGEST_PREFIX}${digest}`, sessionId]
    ),
    hosts: [...store.hosts.entries()],
    projects: [...store.projects.entries()],
    grants: store.grants,
    hostGrants: store.hostGrants,
    revocations: store.revocations,
    relayRoutes: [...store.relayRoutes.entries()],
    hostTokens: store.hostTokens,
    installDownloadTokens: store.installDownloadTokens,
    webHandoffs: [...store.webHandoffs.entries()],
    policies: store.policies,
    audit,
    auditSeq: store.auditSeq,
    auditTip: store.auditTip
  }
}

export function serializeSnapshot(store: Store, auditLimit = DEFAULT_AUDIT_LIMIT): string {
  return JSON.stringify(snapshotOf(store, auditLimit))
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
  if (!isRecord(parsed)) {
    throw new Error('snapshot is not an object')
  }
  if (!READABLE_SNAPSHOT_VERSIONS.has(parsed.version)) {
    throw new Error(`snapshot version ${String(parsed.version)} is not supported`)
  }
  if (!isRecord(parsed.policies)) {
    throw new Error('snapshot policies is not an object')
  }

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
  const installDownloadTokens = arrayOf<InstallDownloadToken>(
    parsed.installDownloadTokens,
    'installDownloadTokens'
  )
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

  store.users = new Map(users)
  store.usersByName = new Map(users.map(([, user]) => [user.username, user]))
  store.devices = new Map(devices)
  store.sessions = new Map(sessions)
  store.accessTokens = new Map(accessTokens)
  store.refreshTokens = new Map(refreshTokenEntries)
  store.hosts = new Map(hosts)
  store.hostsByName = new Map(hosts.map(([, host]) => [host.name, host]))
  store.projects = new Map(projects)
  store.projectsByKey = new Map(projects.map(([, project]) => [project.key, project]))
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

function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, file)
}

/**
 * Restores the snapshot (if any) and schedules change-only flushes. A missing file
 * starts empty. An unreadable one (corrupt JSON or unsupported version) is renamed
 * to `<file>.corrupt-<ts>` so the only copy survives the first flush, then the
 * platform boots with an empty store and writes a fresh snapshot.
 */
export function attachStorePersistence(
  store: Store,
  options: StorePersistenceOptions
): StorePersistenceHandle {
  const { file } = options
  const intervalMs = options.intervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS
  const auditLimit = options.auditLimit ?? DEFAULT_AUDIT_LIMIT
  const log = options.log ?? console
  const writeFile = options.writeFile ?? writeAtomic

  let lastWritten: string | null = null
  if (existsSync(file)) {
    let restoredText: string | null = null
    try {
      restoredText = readFileSync(file, 'utf8')
      restoreSnapshot(store, restoredText, auditLimit)
    } catch (error) {
      // U249 P2-2: preserve the unreadable bytes before any flush can overwrite
      // them; the fresh snapshot then lands on the now-free original path.
      restoredText = null
      const backup = `${file}.corrupt-${Date.now()}`
      try {
        renameSync(file, backup)
        log.warn(`[store-persistence] ignoring ${file}: ${String(error)} (kept as ${backup})`)
      } catch (renameError) {
        log.warn(
          `[store-persistence] ignoring ${file}: ${String(error)} (backup failed: ${String(renameError)})`
        )
      }
    }
    if (restoredText !== null) {
      try {
        const serialized = serializeSnapshot(store, auditLimit)
        if (serialized !== restoredText) {
          // Only a successful restore reaches here. Clean a legacy (plaintext or
          // v1) file now, since change-only flushes would otherwise leave the old
          // bytes on disk indefinitely.
          writeFile(file, serialized)
        }
        lastWritten = serialized
      } catch (error) {
        // Keep the restored memory state; `lastWritten` stays null so the next flush retries.
        log.warn(`[store-persistence] rewrite failed for ${file}: ${String(error)}`)
      }
    }
  }

  const flushNow = (): void => {
    try {
      const text = serializeSnapshot(store, auditLimit)
      if (text === lastWritten) {
        return
      }
      writeFile(file, text)
      lastWritten = text
    } catch (error) {
      log.warn(`[store-persistence] write failed for ${file}: ${String(error)}`)
    }
  }

  const timer = setInterval(flushNow, intervalMs)
  timer.unref()
  // Why exit: installing a signal listener suppresses Node's default termination,
  // so the flush must be followed by an explicit exit or SIGTERM would be ignored.
  const onSignal = (): void => {
    flushNow()
    process.exit(0)
  }
  process.once('SIGTERM', onSignal)
  process.once('SIGINT', onSignal)

  return {
    flushNow,
    stop: () => {
      clearInterval(timer)
      process.removeListener('SIGTERM', onSignal)
      process.removeListener('SIGINT', onSignal)
    }
  }
}
