import { createHash } from 'node:crypto'
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
 * 1: refresh keys are `sha256:<digest>` (U233) and a pre-U233 binary can still load
 * users/sessions/projects from the file; only refresh fails, forcing re-login.
 * U249: the digest shape is marked by `refreshTokensHashed` instead of a version
 * bump, so rolling back to a v1 binary never wipes the rest of the state. Version 2
 * files (the short-lived bump) are still readable and rewritten as v1.
 */
export const SNAPSHOT_VERSION = 1
export const DEFAULT_AUDIT_LIMIT = 10_000

export type Entry<T> = [string, T]

/** Snapshot marker so a digest is never mistaken for a legacy plaintext key. */
export const REFRESH_TOKEN_DIGEST_PREFIX = 'sha256:'

export function digestRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export type AccessTokenEntry = {
  sessionId: string
  userId: string
  epoch: number
  expiresAt: number
}

type SnapshotDocument = {
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

/** Builds the on-disk shape; indexes and transient login locks are not persisted. */
function snapshotOf(store: Store, auditLimit = DEFAULT_AUDIT_LIMIT): SnapshotDocument {
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
    // D18: bearer tokens are regenerable from a refresh; keep the array in the
    // schema but never write plaintext credentials to disk.
    accessTokens: [],
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
    // D18: a handoff code is a live credential; one-time codes do not survive
    // a restart. The empty array keeps the snapshot schema readable by old peers.
    webHandoffs: [],
    policies: store.policies,
    audit,
    auditSeq: store.auditSeq,
    auditTip: store.auditTip
  }
}

export function serializeSnapshot(store: Store, auditLimit = DEFAULT_AUDIT_LIMIT): string {
  return JSON.stringify(snapshotOf(store, auditLimit))
}
