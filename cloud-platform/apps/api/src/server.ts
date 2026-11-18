import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { isIPv6 } from 'node:net'
import { lstat, readFile, rm, stat } from 'node:fs/promises'
import { createReadStream, readFileSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateProjectPath } from '../../../packages/contract/src/project-path.ts'
import { validateProjectRepoUrl } from '../../../packages/contract/src/repo-url.ts'
import { validateProjectDefaultBranch } from '../../../packages/contract/src/branch-name.ts'
import {
  MAX_PROJECT_KEY_LENGTH,
  projectKeyFromName,
  validateProjectKey
} from '../../../packages/contract/src/project-key.ts'
import {
  PROJECT_PATH_MAX_CHARS,
  SELF_SERVICE_PROJECT_LIMIT,
  countActiveProjectsCreatedBy,
  hasHostPermission,
  joinProjectPath,
  parseProjectDirs,
  selectSelfServiceHost,
  validateProjectDir
} from './project-self-service.ts'
import { isProjectCreator, projectKeyTaken, projectPathTaken } from './project-occupancy.ts'
import { evaluateRelayRouteFreshness } from './relay-route-freshness.ts'
import {
  canCreateProjectOnHost,
  effectiveProjectPermissions,
  hostAccessLevel,
  hostBits,
  hostBitsFromRows,
  hostLevelFromBits
} from './host-authority.ts'
import {
  newDeviceToken,
  newJti,
  signCredential,
  type CredentialPayload,
  type Permission,
  type SigningKey
} from '../../../packages/contract/src/credential.ts'
import { AuditChain, AUDIT_REASON_MAX_CHARS, type AuditSummary } from './audit.ts'
import { AUDIT_RECENT_WINDOW_MS, AUDIT_WINDOW_MS, parseAuditQuery } from './audit-query.ts'
import {
  AUDIT_EXPORT_OBJECT_KEYS,
  generateAuditExportJobId,
  resolveAuditExportObjectPath,
  type AuditExportJob,
  type AuditExportJobStore
} from './audit-export-jobs.ts'
import {
  createAuditExportStore,
  resolveAuditExportSweepIntervalMs,
  resolveAuditExportTokenTtlMs,
  startAuditExportCleanup,
  startAuditExportSweep
} from './audit-export-runtime.ts'
import {
  AuditExportWorker,
  DEFAULT_AUDIT_EXPORT_MAX_BYTES,
  DEFAULT_AUDIT_EXPORT_MAX_EVENTS
} from './audit-export-worker.ts'
import { AUDIT_EVENT_TYPES } from './audit-event-catalog.ts'
import { createRemoteAudit, type AuditSink } from './audit-writer-client.ts'
import { createSigningKeyRing } from './signing-key-ring.ts'
import type { AuditEvent, AuditEventInput } from './store.ts'
import { openAuditLogFile } from './audit-log-file.ts'
import {
  requireCommand,
  requireNodeVersion,
  requireWritableDir,
  shellQuote,
  systemdAvailable
} from './install-script-command.ts'
import { renderHostUnit, renderRelayUnit } from './systemd-unit-template.ts'
import { attachStorePersistence } from './store-persistence.ts'
import { startInternalChannel } from './internal-channel.ts'
import {
  installUnreadBodyPolicy,
  leavesUnreadLargeBody,
  markRequestBodyRead
} from './unread-body-policy.ts'
import { ldapProfile, MockLdapAdapter, type LdapAdapter } from './ldap.ts'
import {
  Store,
  type Device,
  type Grant,
  type Host,
  type HostPermission,
  type InstallDownloadToken,
  type Project,
  type Session,
  type User
} from './store.ts'
import { parseReadRate } from './policy-rate.ts'
import {
  appendHostAuditReports,
  parseHostAuditGap,
  parseHostAuditReports,
  type HostAuditActorResolver,
  type HostAuditGap
} from './host-audit-ingest.ts'
import {
  createWebReleaseStore,
  MIN_WEB_CONTRACT_VERSION,
  WEB_CONTRACT_VERSION
} from './web-release.ts'
import {
  cacheControlForStaticName,
  sendStaticAsset,
  sendStaticNotFound,
  STATIC_CSP_REPORT_ONLY,
  STATIC_HASHED_CACHE_CONTROL,
  STATIC_HTML_CACHE_CONTROL,
  STATIC_SECURITY_HEADERS,
  STATIC_UNHASHED_CACHE_CONTROL,
  weakStaticEtag
} from './static-delivery.ts'
import { checkWebContract, readWebContract } from './web-contract.ts'
import {
  parseRefreshCookie,
  resolveRefreshCookieConfig,
  sameOrigin,
  serializeRefreshCookie,
  serializeRefreshCookieClear
} from './refresh-cookie.ts'
import {
  createRelayNodeRegistry,
  parseInstallNonce,
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
/** U197 S2: previous-token grace; `0` means strict reuse detection. */
const DEFAULT_REFRESH_GRACE_MS = 30_000
const MAX_REFRESH_GRACE_MS = 60_000
const CREDENTIAL_TTL_S = 60
const HOST_OFFLINE_DEFAULT_MS = 60_000
/** U37: per-beat cap on the heartbeat's provision kick; the rest waits for the next beat. */
const MAX_PROVISION_ASSIGNMENTS_PER_BEAT = 16
const HANDOFF_TTL_MS = 60_000
/** U115: a pasted install command must work at once, so its download credential is short. */
const INSTALL_DOWNLOAD_TTL_MS = 10 * 60_000
// §3.2 单常量：两条准入拒绝路径（查询侧 miss / 平台闸门 miss）共用同一文案，可一键切回备选。
const LDAP_GROUP_NOT_ADMITTED_MESSAGE = '账号未加入平台准入组。'
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
  /** U197 S1: refresh-cookie mode (auto|always|never); defaults to ORCA_CLOUD_COOKIE_MODE. */
  cookieMode?: string
  /** U197 S1: platform public origin; auto/always require it. */
  publicOrigin?: string
  /** U197 S2: previous-refresh grace window; defaults to ORCA_CLOUD_REFRESH_GRACE_MS. */
  refreshGraceMs?: number
  /** U230②: test-only barrier awaited before a disabled-session revoke, to interleave refreshes. */
  beforeDisabledSessionRevoke?: () => void | Promise<void>
  /** U244: test-only barrier awaited before an admin force-offline revokes user sessions. */
  beforeUserSessionRevoke?: () => void | Promise<void>
  /** How long a host stays "online" without a heartbeat; tests shrink it to observe the flip. */
  hostOfflineMs?: number
  /** One-time web-handoff code lifetime (FR-3.10); tests shrink it to exercise expiry. */
  handoffTtlMs?: number
  /** One-time install-script download token lifetime (U115); tests shrink it to exercise expiry. */
  installDownloadTtlMs?: number
  /** Audit-export storage root; overrides ORCA_AUDIT_EXPORT_DIR/ROOT. */
  auditExportDir?: string
  /** Export job lifetime; tests shrink it to observe expiry without waiting an hour. */
  auditExportTtlMs?: number
  /** Active exports one user may hold at once. */
  auditExportPerUserLimit?: number
  /** Active exports the process may hold across all users. */
  auditExportGlobalLimit?: number
  /** Download-link lifetime; defaults to five minutes. */
  auditExportTokenTtlMs?: number
  /** Queued-export rescue sweep interval; tests shrink it to observe the rescue. */
  auditExportSweepMs?: number
  /** U183 R2: where relay bundles are published; defaults to cloud-platform/dist/relay-bundles. */
  relayBundleDir?: string
  /** U183 R2: bundle sha the platform embeds when the request names none. */
  relayBundleSha?: string
  /** Append-only audit log; absent keeps the chain in memory (tests). */
  auditLogPath?: string
  /** Single audit writer shared by replicas; absent keeps the local chain. */
  auditWriterUrl?: string
  /** Leader first, then standbys; replicas fail over on their own. */
  auditWriterUrls?: string[]
  /** Shared login-lockout counter; absent counts in this process only. */
  loginLockoutUrl?: string
  /** LDAP admission group CN; set = logins outside the group are refused (fail-open-on-unset). */
  ldapRequiredGroup?: string
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
  /** U202 E9: file-backed export jobs shared by export routes and cleanup. */
  auditExportStore: AuditExportJobStore
  /** U201 E6b: drains queued export jobs; the accept route schedules a pass. */
  auditExportWorker: AuditExportWorker
  signingKey: SigningKey
  listen: () => Promise<number>
  close: () => Promise<void>
  setRelayPort: (port: number) => void
  /** Port of the mTLS control listener, when enabled. */
  internalPort: () => number | null
}

type AuthedRequest = { user: User; sessionId: string }

/**
 * U258/U264: a pre-read refusal cannot know whether it is discarding a legal
 * command — register accepts 64 KiB and heartbeat 1 MiB — so any unread
 * declared body over 16 KiB is treated as unreplayable and the connection is
 * closed. Legal callers read their body first and are unaffected. The policy
 * itself lives in `unread-body-policy.ts`; this map lets `json()` apply it
 * before the shared `writeHead` wrapper does.
 */
const requestByResponse = new WeakMap<ServerResponse, IncomingMessage>()

function json(res: ServerResponse, status: number, body: unknown): void {
  // U258: a reply sent before the body is read leaves Node draining the rest of
  // the request after the response so keep-alive can continue. Above the common
  // per-command cap (or for chunked framing, where the size is unknown) refuse
  // that drain by closing — an unauthenticated caller must not make the server
  // consume an arbitrary body.
  if (!res.headersSent && leavesUnreadLargeBody(requestByResponse.get(res))) {
    res.setHeader('connection', 'close')
  }
  const payload = JSON.stringify(body)
  // Every JSON exit, including the HEAD/404 fallthrough, carries the static security headers.
  res.writeHead(status, {
    ...STATIC_SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8'
  })
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

/**
 * U136④a: absent keeps the old last-write-wins contract; a supplied version must
 * be a non-negative integer, so `"1"` or `-1` is a caller error, not a no-op.
 */
function parseExpectedVersion(
  value: unknown
): { kind: 'absent' } | { kind: 'invalid' } | { kind: 'set'; version: number } {
  if (value === undefined) return { kind: 'absent' }
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? { kind: 'set', version: value }
    : { kind: 'invalid' }
}

/**
 * U197 S2: `0` is a meaningful strict-reuse setting, so an absent value must not
 * coerce to 0; invalid values fall back to the default rather than disabling grace.
 */
function parseRefreshGraceMs(value: number | string | null | undefined): number {
  if (value === undefined || value === null || value === '') return DEFAULT_REFRESH_GRACE_MS
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_REFRESH_GRACE_MS
  return Math.min(parsed, MAX_REFRESH_GRACE_MS)
}

type ReadBodyResult = { body: Record<string, unknown>; oversized: boolean }

/**
 * U251: a declared overage up to this budget is discarded before the refusal so
 * a client still writing a modest overage can read the refusal instead of a reset.
 * The drain is also time-boxed; an endless stream never holds the connection.
 */
const OVERSIZE_DRAIN_LIMIT_BYTES = 2 * 1024 * 1024
const OVERSIZE_DRAIN_TIMEOUT_MS = 250

async function drainDeclaredBody(req: IncomingMessage): Promise<void> {
  await new Promise<void>((resolve) => {
    let drained = 0
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      req.off('data', onData)
      req.off('end', finish)
      resolve()
    }
    const onData = (chunk: Buffer): void => {
      drained += chunk.length
      if (drained > OVERSIZE_DRAIN_LIMIT_BYTES) {
        req.pause()
        finish()
      }
    }
    const timer = setTimeout(() => {
      req.pause()
      finish()
    }, OVERSIZE_DRAIN_TIMEOUT_MS)
    req.on('data', onData)
    req.on('end', finish)
    // Late resets from the peer must stay swallowed.
    req.on('error', finish)
  })
}

/**
 * U251: an over-cap body is refused at the first byte past the cap, never
 * drained without a bound. Three cases: a declared overage within the drain
 * budget is discarded first; a larger declared overage is refused from the
 * header alone; a chunked overage pauses the stream. Only the first case lets a
 * client that is still writing read the refusal, and no case guarantees it —
 * a large declared or fast chunked writer may see a reset instead. Callers that
 * answer 413 close the connection; internal callers keep their empty-body
 * semantics and close too.
 */
async function readBody(req: IncomingMessage, maxBytes?: number): Promise<ReadBodyResult> {
  // U258: the body is consumed from here on, so a later rejection must not close
  // the connection on its account (oversized paths close explicitly).
  markRequestBodyRead(req)
  const declaredLength = Number(req.headers['content-length'])
  if (maxBytes !== undefined && Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    if (declaredLength <= OVERSIZE_DRAIN_LIMIT_BYTES) await drainDeclaredBody(req)
    return { body: {}, oversized: true }
  }
  const chunks: Buffer[] = []
  let size = 0
  let oversized = false
  let settled = false
  // Why not `for await`: returning early destroys the request (and its socket)
  // before the caller can send the 413.
  await new Promise<void>((resolve, reject) => {
    const settle = (): void => {
      if (settled) return
      settled = true
      req.off('data', onData)
      req.off('end', onEnd)
      // The error listener stays: a late reset from the still-streaming peer
      // must not surface as an uncaught 'error' after the refusal is sent.
      resolve()
    }
    const onData = (chunk: Buffer): void => {
      size += chunk.length
      if (maxBytes !== undefined && size > maxBytes) {
        oversized = true
        chunks.length = 0
        // Stop consuming: the caller closes instead of draining the stream.
        req.pause()
        settle()
        return
      }
      chunks.push(chunk)
    }
    const onEnd = (): void => settle()
    const onError = (error: Error): void => {
      if (settled) return
      settled = true
      req.off('data', onData)
      req.off('end', onEnd)
      reject(error)
    }
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
  })
  if (oversized) return { body: {}, oversized: true }
  if (chunks.length === 0) return { body: {}, oversized: false }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    // U236: `null` and scalars have no fields, so treat them exactly like an
    // absent body instead of letting `body.x` throw a 500. Arrays pass through.
    if (parsed === null || typeof parsed !== 'object') return { body: {}, oversized: false }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: non-null object from JSON.parse is an array or plain object; callers only read properties.
    return { body: parsed as Record<string, unknown>, oversized: false }
  } catch {
    return { body: {}, oversized: false }
  }
}

/**
 * U255: an oversized body is never consumed, so preserving keep-alive would let
 * Node drain the rest of it on response finish without a bound. Closing marks
 * the connection unusable for another request while callers keep their old
 * semantics (the body reads as {}). Per `readBody`:
 * - declared overage ≤ 2 MiB: bounded drain, then the response;
 * - declared overage > 2 MiB: header-only refusal plus close;
 * - chunked overage: pause plus close, dropping the unread bytes.
 */
async function readJsonWithRes(
  req: IncomingMessage,
  res: ServerResponse,
  maxBytes: number
): Promise<Record<string, unknown>> {
  const { body, oversized } = await readBody(req, maxBytes)
  if (oversized) res.setHeader('connection', 'close')
  return body
}

/**
 * U251: internal ingress keeps its discard-the-whole-body semantics, but an
 * oversized stream is closed instead of drained to completion.
 */
async function readInternalBody(
  req: IncomingMessage,
  res: ServerResponse
): Promise<Record<string, unknown>> {
  const { body, oversized } = await readBody(req, INTERNAL_BODY_MAX_BYTES)
  if (oversized) res.setHeader('connection', 'close')
  return body
}

/**
 * U251: a refused body was not consumed, so close instead of letting Node drain
 * it to preserve keep-alive. Only oversized requests lose the connection.
 */
function rejectOversizedBody(res: ServerResponse, traceId: string): void {
  res.setHeader('connection', 'close')
  error(res, 413, 'PAYLOAD_TOO_LARGE', '请求体过大。', traceId)
}

/**
 * U250 tier 2: a sensitive write's body is its only input, so an oversized one
 * is refused before any mutation or audit. Returns null after sending the 413.
 * U251: heartbeat overrides the default, since one beat carries a whole batch.
 */
async function readSensitiveWriteBody(
  req: IncomingMessage,
  res: ServerResponse,
  traceId: string,
  maxBytes = SENSITIVE_WRITE_BODY_MAX_BYTES
): Promise<Record<string, unknown> | null> {
  const { body, oversized } = await readBody(req, maxBytes)
  if (!oversized) return body
  rejectOversizedBody(res, traceId)
  return null
}

/** Login/refresh/handoff bodies carry only credentials; logout uses the same cap. */
const AUTH_BODY_MAX_BYTES = 16 * 1024

/** A logout body only ever carries a refresh token; anything larger is ignored. */
const LOGOUT_BODY_MAX_BYTES = 16 * 1024

/**
 * U250: internal ingress calls are small control messages; an oversized body is
 * dropped whole so peers keep their old semantics.
 * U251 P3: `internal/audit/file-events` accepts metadata up to
 * `FILE_EVENT_METADATA_LIMIT` (4096 B) plus top-level fields, so 4 KiB rejected
 * legal events; 8 KiB covers the full envelope.
 */
const INTERNAL_BODY_MAX_BYTES = 8 * 1024

/** U244: the force-offline body only carries an optional audit note. */
const FORCE_OFFLINE_BODY_MAX_BYTES = 4 * 1024

/** U257: the register name is stored, indexed, and audited; 128 matches ingest. */
const HOST_NAME_MAX_CHARS = 128

/** U250 tier 2: an authenticated sensitive write carries a small JSON command. */
const SENSITIVE_WRITE_BODY_MAX_BYTES = 16 * 1024

/**
 * U252/U256: register allows 200 projectDirs of 255 B each and a projectsRoot
 * bounded to `PROJECT_PATH_MAX_CHARS`, so the largest legal body measures ~56
 * KiB. 64 KiB admits it with headroom. Without the root bound, a 15,003-char
 * root plus 200 dirs measured 66,663 B and was refused as oversized.
 * Current TS hosts omit projectDirs, so this only protects cross-version and
 * other host implementations; raising the cap keeps their legal registrations
 * from being refused.
 */
const REGISTER_BODY_MAX_BYTES = 64 * 1024

/**
 * U251: one beat carries the host's whole pending batch — 100 audit events whose
 * per-event metadata may reach 4096 B (`host-audit-ingest.ts`), 200 projectDirs
 * (200 B each), and 32 provision reports (500 B errors). A legal maximum
 * measured ~433 KiB, so 1 MiB admits every valid beat; a 413 here would strand
 * the batch forever because the host only clears through after `beat.ok`.
 */
const HEARTBEAT_BODY_MAX_BYTES = 1024 * 1024

/**
 * U250 tier 2: a denied 403 branch reads the body only to name what was refused.
 * The cap makes the audit record bounded; an oversized body counts as empty.
 */
const DENIED_AUDIT_BODY_MAX_BYTES = 4 * 1024

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
 * U268: the longest legal form is a 253-char DNS name (254 with trailing dot)
 * plus `:` + five port digits = 260, so 264 leaves margin without accepting a
 * form a URL parser could not dial. O(1), and also runs in `browserPageOrigins`
 * on every CORS-bearing request.
 */
const MAX_DIRECT_ADDR_CHARS = 264

/**
 * A direct address must be a bare `host[:port]` (IPv6 bracketed), because it is
 * spliced verbatim into `https://<addr>/web-index.html`: a scheme, path, or
 * unbracketed IPv6 would move the handoff code onto a different origin or path.
 * U263: the host part admits only name characters, so URL delimiters (`@ \ / ? # %`)
 * cannot turn the splice into another origin.
 * U265: the bracket class admits malformed IPv6 (`[::::::]`), so the real parser
 * decides, not the character set.
 * U268: it also admits `.` so IPv4-mapped IPv6 (`[::ffff:192.0.2.1]`) reaches
 * `isIPv6`; a dotted non-address such as `[::ffff:999.0.0.1]` still fails there.
 */
function isDirectAddrForm(addr: string): boolean {
  if (addr.length === 0 || addr.length > MAX_DIRECT_ADDR_CHARS) return false
  const match = addr.match(/^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._-]+)(?::(\d{1,5}))?$/)
  if (!match) return false
  const port = match[2]
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return false
  const host = match[1]
  return host.startsWith('[') ? isIPv6(host.slice(1, -1)) : true
}

/**
 * U265: the form whitelist cannot prove `new URL` will accept the splice; an
 * address it refuses must be rejected before a token is spent or a host stored,
 * or every later project view (and project create) 500s on Invalid URL.
 */
function isDialableDirectAddr(addr: string): boolean {
  if (!isDirectAddrForm(addr)) return false
  try {
    new URL(`https://${addr}`)
    return true
  } catch {
    return false
  }
}

/**
 * U268: a hand-edited or very old snapshot can carry non-string elements. Every
 * reader scans this array, so drop them at load rather than 500 on `.match`.
 */
function stringDirectAddrs(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((addr): addr is string => typeof addr === 'string') : []
}

/**
 * U182: a Host header is attacker-controlled. Only a bare `host[:port]` may be
 * spliced into the install script, and only an `http`/`https` proxy scheme.
 */
function isSafeOriginHost(value: string): boolean {
  const match = value.match(
    /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)(?::(\d{1,5}))?$/
  )
  if (!match) {
    return false
  }
  const port = match[2]
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) {
    return false
  }
  const host = match[1]
  return host.startsWith('[') || (!host.includes('..') && !host.endsWith('.'))
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
  const scheme =
    forwardedScheme === 'http' || forwardedScheme === 'https' ? forwardedScheme : ownScheme
  const rawHost = (req.headers.host ?? '').trim()
  const host = isSafeOriginHost(rawHost) ? rawHost : `127.0.0.1:${req.socket.localPort ?? 0}`
  return `${scheme}://${host}`
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/** U183 R2: published bundle location; R1 writes here by default. */
const DEFAULT_RELAY_BUNDLE_DIR = fileURLToPath(
  new URL('../../../dist/relay-bundles', import.meta.url)
)
const RELAY_BUNDLE_SHA_PATTERN = /^[0-9a-f]{64}$/
const RELAY_BUNDLE_ROUTE_PATTERN = /^\/install\/relay-bundle\/([^/]+)\.(tgz|manifest\.json)$/

type RelayBundleManifest = {
  bundleSha256: string
  schemaVersion: number
  relayCodeVersion: string
}

function parseRelayBundleManifest(value: unknown): RelayBundleManifest | null {
  if (typeof value !== 'object' || value === null) return null
  const sha = Reflect.get(value, 'bundleSha256')
  const schemaVersion = Reflect.get(value, 'schemaVersion')
  const relayCodeVersion = Reflect.get(value, 'relayCodeVersion')
  if (
    typeof sha !== 'string' ||
    typeof schemaVersion !== 'number' ||
    !Number.isInteger(schemaVersion) ||
    typeof relayCodeVersion !== 'string'
  ) {
    return null
  }
  return { bundleSha256: sha, schemaVersion, relayCodeVersion }
}

type RelayBundleManifestResult =
  | { ok: true; manifest: RelayBundleManifest }
  | { ok: false; status: number; code: string; message: string }

/** The manifest is an out-of-band deployment artifact, never served to clients. */
async function readRelayBundleManifest(
  dir: string,
  sha: string
): Promise<RelayBundleManifestResult> {
  let raw: string
  try {
    raw = await readFile(join(dir, `relay-bundle-${sha}.manifest.json`), 'utf8')
  } catch {
    return {
      ok: false,
      status: 500,
      code: 'RELAY_BUNDLE_MANIFEST_MISSING',
      message: 'relay bundle 清单缺失：部署不完整。'
    }
  }
  const parsed: unknown = (() => {
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  })()
  const valid = parseRelayBundleManifest(parsed)
  if (!valid || valid.bundleSha256 !== sha) {
    return {
      ok: false,
      status: 500,
      code: 'RELAY_BUNDLE_MANIFEST_INVALID',
      message: 'relay bundle 清单与包不一致。'
    }
  }
  return { ok: true, manifest: valid }
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]'
  )
}

/**
 * FR-4.11: the payload behind the wizard's one-liner. It writes the env file the
 * target machine needs and prints the follow-up commands; it never prompts, so
 * `bash <(curl …)` stays unattended-safe.
 */
export function hostInstallScript(input: { platformUrl: string; token: string }): string {
  return `#!/usr/bin/env bash
# Orca Cloud 开发机接入脚本（平台生成；内嵌一次性注册令牌，注册一次后失效）
set -euo pipefail
umask 077

# U181 P1-2: readiness baseline; a state file written before this moment is stale.
ORCA_INSTALL_STARTED_AT_MS="$(( $(date +%s) * 1000 ))"

ORCA_ENV_FILE="\${ORCA_ENV_FILE:-$HOME/.orca-cloud/host.env}"
ORCA_ENV_DIR="$(dirname "$ORCA_ENV_FILE")"

# U181 P1-3: ORCA_CLI is an explicit override; Linux never falls back to a bare
# orca binary (GNOME Orca screen reader), macOS may.
ORCA_HOST_BIN=""
if [ -n "\${ORCA_CLI:-}" ]; then
  if [ -x "$ORCA_CLI" ]; then
    case "$ORCA_CLI" in
      /*) ORCA_HOST_BIN="$ORCA_CLI" ;;
      */*) ORCA_HOST_BIN="$(cd "\${ORCA_CLI%/*}" 2>/dev/null && pwd)/\${ORCA_CLI##*/}" ;;
      *) ORCA_HOST_BIN="$(pwd)/$ORCA_CLI" ;;
    esac
  else
    echo ">> ORCA_CLI 不可执行：$ORCA_CLI" >&2
    exit 78
  fi
elif command -v orca-ide >/dev/null 2>&1; then
  ORCA_HOST_BIN="$(command -v orca-ide)"
elif [ "$(uname -s 2>/dev/null || true)" = Darwin ] && command -v orca >/dev/null 2>&1; then
  ORCA_HOST_BIN="$(command -v orca)"
fi
if [ -z "$ORCA_HOST_BIN" ] || [ ! -x "$ORCA_HOST_BIN" ]; then
  echo ">> 未找到 Orca 宿主程序：请先安装 orca-ide（Linux）或 orca（macOS），或设置 ORCA_CLI 指向可执行文件" >&2
  exit 78
fi

ORCA_HOST_NAME="$(hostname -s 2>/dev/null || hostname 2>/dev/null || true)"
# U182: hostname -I is Linux-only. Probe hostname -I → macOS ipconfig → plain
# hostname; an empty advertise address is a failed install, never "success".
if [ -n "\${ADVERTISE_HOST:-}" ]; then
  ORCA_ADVERTISE="$ADVERTISE_HOST"
else
  ORCA_ADVERTISE="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  if [ -z "$ORCA_ADVERTISE" ] && command -v ipconfig >/dev/null 2>&1; then
    ORCA_ADVERTISE="$(ipconfig getifaddr en0 2>/dev/null || true)"
  fi
  if [ -z "$ORCA_ADVERTISE" ]; then
    ORCA_ADVERTISE="$(hostname 2>/dev/null || true)"
  fi
fi
if [ -z "$ORCA_ADVERTISE" ]; then
  echo ">> 无法自动探测本机地址（78）：hostname -I / ipconfig getifaddr en0 / hostname 均失败。" >&2
  echo ">> 请显式设置 ADVERTISE_HOST=<本机可达 IP> 后重试。" >&2
  exit 78
fi

ORCA_USER_DATA_PATH="\${ORCA_HOST_PROFILE:-$HOME/.orca-cloud/profile}"
ORCA_STATE_FILE="$ORCA_USER_DATA_PATH/orca-cloud-host-state.json"

mkdir -p "$ORCA_ENV_DIR"
chmod 700 "$ORCA_ENV_DIR" 2>/dev/null || true

ORCA_TLS_CERT="\${ORCA_TLS_CERT:-$HOME/.orca-cloud/tls/host.crt}"
ORCA_TLS_KEY="\${ORCA_TLS_KEY:-$HOME/.orca-cloud/tls/host.key}"
if [ ! -s "$ORCA_TLS_CERT" ] || [ ! -s "$ORCA_TLS_KEY" ]; then
  echo ">> 生成自签 TLS 证书（openssl）"
  mkdir -p "$(dirname "$ORCA_TLS_CERT")"
  chmod 700 "$(dirname "$ORCA_TLS_CERT")" 2>/dev/null || true
  # U182: -addext needs OpenSSL >= 1.1.1; older builds get a temp config, and
  # every openssl error stays on stderr instead of being swallowed.
  ORCA_OPENSSL_VER="$(openssl version 2>/dev/null | awk '{print $2}' || true)"
  ORCA_OPENSSL_ADDEXT=1
  case "$ORCA_OPENSSL_VER" in
    0.*|1.0.*|1.1.0*) ORCA_OPENSSL_ADDEXT=0 ;;
  esac
  ORCA_TLS_OK=0
  if [ "$ORCA_OPENSSL_ADDEXT" = 1 ]; then
    if openssl req -x509 -newkey rsa:2048 -nodes -days 365 \\
      -keyout "$ORCA_TLS_KEY" -out "$ORCA_TLS_CERT" \\
      -subj "/CN=$ORCA_HOST_NAME" \\
      -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" >/dev/null; then
      ORCA_TLS_OK=1
    fi
  else
    ORCA_SSL_CONF="$(mktemp "\${TMPDIR:-/tmp}/orca-openssl-XXXXXX.cnf")"
    cat > "$ORCA_SSL_CONF" <<ORCA_SSL_CONF_EOF
[req]
distinguished_name = dn
x509_extensions = v3_req
prompt = no
[dn]
CN = $ORCA_HOST_NAME
[v3_req]
subjectAltName = DNS:localhost,IP:127.0.0.1
ORCA_SSL_CONF_EOF
    if openssl req -x509 -newkey rsa:2048 -nodes -days 365 \\
      -keyout "$ORCA_TLS_KEY" -out "$ORCA_TLS_CERT" \\
      -config "$ORCA_SSL_CONF" >/dev/null; then
      ORCA_TLS_OK=1
    fi
    rm -f "$ORCA_SSL_CONF"
  fi
  if [ "$ORCA_TLS_OK" != 1 ]; then
    echo ">> 自签 TLS 证书生成失败（78 / openssl \${ORCA_OPENSSL_VER:-unknown}）：请检查上面的 openssl 错误；" >&2
    echo ">> 或设置 ORCA_TLS_CERT/ORCA_TLS_KEY 指向已有证书后重试。" >&2
    exit 78
  fi
fi

# U181 P1-2: the readiness poll needs a profile the host can write.
if ! mkdir -p "$ORCA_USER_DATA_PATH"; then
  echo ">> profile 目录不可写：$ORCA_USER_DATA_PATH" >&2
  exit 78
fi
chmod 700 "$ORCA_USER_DATA_PATH" 2>/dev/null || true

# U181 P2-10: capture before launch; the host writes its credential on this run,
# which must not be mistaken for "already enrolled".
ORCA_HAD_CREDENTIAL=0
if [ -f "$ORCA_USER_DATA_PATH/orca-cloud-host.json" ]; then ORCA_HAD_CREDENTIAL=1; fi

# U181 P1-4: preflight before host.env/unit or any service start. A failed
# verdict is config (78) or runtime (64); it can never become a timeout.
ORCA_PREFLIGHT_OUT="$(mktemp "\${TMPDIR:-/tmp}/orca-preflight-out-XXXXXX")"
ORCA_PREFLIGHT_ERR="$(mktemp "\${TMPDIR:-/tmp}/orca-preflight-err-XXXXXX")"
ORCA_PREFLIGHT_CODE=0
ORCA_CLOUD_API_URL=${shellQuote(input.platformUrl)} \\
ORCA_CLOUD_HOST_TOKEN=${shellQuote(input.token)} \\
ORCA_CLOUD_HOST_NAME="$ORCA_HOST_NAME" \\
ORCA_USER_DATA_PATH="$ORCA_USER_DATA_PATH" \\
ORCA_CLOUD_TLS_CERT_PATH="$ORCA_TLS_CERT" \\
ORCA_CLOUD_TLS_KEY_PATH="$ORCA_TLS_KEY" \\
  "$ORCA_HOST_BIN" --host-mode --preflight >"$ORCA_PREFLIGHT_OUT" 2>"$ORCA_PREFLIGHT_ERR" || ORCA_PREFLIGHT_CODE=$?
if [ "$ORCA_PREFLIGHT_CODE" -ne 0 ]; then
  echo ">> 宿主预检失败（--preflight 退出码 $ORCA_PREFLIGHT_CODE）：" >&2
  cat "$ORCA_PREFLIGHT_OUT" >&2 2>/dev/null || true
  cat "$ORCA_PREFLIGHT_ERR" >&2 2>/dev/null || true
  ORCA_PREFLIGHT_EXIT=78
  # Why: the CLI reports both halves as 78; the failed check id keeps "runtime
  # broken" (64) distinct from "config broken" (78) for the operator.
  if [ "$ORCA_PREFLIGHT_CODE" -eq 64 ] || grep -q '"id":"runtime","ok":false' "$ORCA_PREFLIGHT_OUT" 2>/dev/null; then
    ORCA_PREFLIGHT_EXIT=64
  fi
  rm -f "$ORCA_PREFLIGHT_OUT" "$ORCA_PREFLIGHT_ERR"
  if [ "$ORCA_PREFLIGHT_EXIT" -eq 64 ]; then
    echo ">> 宿主运行时不可用（preflight → 64）：请检查 orcad 槽、pinned Node 与 profile 目录" >&2
  else
    echo ">> 宿主配置无效（preflight → 78）：请检查 ORCA_CLOUD_* 配置后重试" >&2
  fi
  exit "$ORCA_PREFLIGHT_EXIT"
fi
rm -f "$ORCA_PREFLIGHT_OUT" "$ORCA_PREFLIGHT_ERR"
echo ">> 宿主预检通过"

echo ">> 写入环境配置 $ORCA_ENV_FILE"
# H9a: one atomic write. A rerun must never leave half a config behind, and
# the TLS paths are always present (a rerun used to drop them).
ORCA_ENV_TMP="$(mktemp "\${ORCA_ENV_FILE}.XXXXXX")"
{
  # ORCA_CLOUD_* is what the host binary reads; the bare aliases stay for env
  # files and docs written before the rename (same family as U38). Untrusted
  # values are emitted as one quoted literal so the script cannot be injected.
  printf '%s\\n' ${shellQuote(`ORCA_CLOUD_API_URL=${input.platformUrl}`)}
  printf '%s\\n' ${shellQuote(`ORCA_CLOUD_HOST_TOKEN=${input.token}`)}
  printf 'ORCA_CLOUD_HOST_NAME=%s\\n' "$ORCA_HOST_NAME"
  printf 'ORCA_CLOUD_ADVERTISE_HOST=%s\\n' "$ORCA_ADVERTISE"
  printf 'ORCA_CLOUD_PROJECTS_ROOT=%s\\n' "\${PROJECTS_ROOT:-/srv/work}"
  printf '%s\\n' ${shellQuote(`HOST_TOKEN=${input.token}`)}
  printf 'HOST_NAME=%s\\n' "$ORCA_HOST_NAME"
  printf 'ADVERTISE_HOST=%s\\n' "$ORCA_ADVERTISE"
  printf 'PROJECTS_ROOT=%s\\n' "\${PROJECTS_ROOT:-/srv/work}"
  # H9a: host mode pins a dedicated profile, which is also where it writes the
  # readiness file the self-check below reads.
  printf 'ORCA_USER_DATA_PATH=%s\\n' "$ORCA_USER_DATA_PATH"
  printf 'ORCA_CLOUD_TLS_CERT_PATH=%s\\n' "$ORCA_TLS_CERT"
  printf 'ORCA_CLOUD_TLS_KEY_PATH=%s\\n' "$ORCA_TLS_KEY"
} > "$ORCA_ENV_TMP"
chmod 600 "$ORCA_ENV_TMP"
mv -f "$ORCA_ENV_TMP" "$ORCA_ENV_FILE"
chmod 600 "$ORCA_ENV_FILE"

echo ">> 平台连通性检查"
# U180: the health check needs the URL we just wrote; load it without dropping -u.
set -a; . "$ORCA_ENV_FILE"; set +a
# U182: no redirect following; only an explicit 2xx is healthy, and bounded time
# so a black-holed DNS/gateway cannot hang the install.
ORCA_HEALTH_CODE="$(curl -sS --connect-timeout 5 --max-time 10 -o /dev/null -w '%{http_code}' "$ORCA_CLOUD_API_URL/health")" || ORCA_HEALTH_CODE=000
case "$ORCA_HEALTH_CODE" in
  2??) ;;
  *) echo ">> 平台健康检查失败（68 / HTTP $ORCA_HEALTH_CODE）：$ORCA_CLOUD_API_URL/health 不可达" >&2; exit 68 ;;
esac
echo ">> 环境已就绪：$ORCA_ENV_FILE"

# H9a: start the host now. The readiness file is the only success proof; logs
# and /health are diagnostics, never an "online" verdict.
ORCA_HOST_LOG="\${ORCA_HOST_LOG:-$HOME/.orca-cloud/host.log}"
mkdir -p "$(dirname "$ORCA_HOST_LOG")"
ORCA_HOST_PID=""
echo ">> 启动 Orca 宿主（--host-mode）：$ORCA_HOST_BIN --host-mode"
set -a; . "$ORCA_ENV_FILE"; set +a

# H9b: with user systemd the unit owns the process — it restarts on failure and
# survives logout/reboot. No nohup beside it (two instances fight the profile lock).
if ${systemdAvailable()}; then
  # U181 P2-9: record the supervisor here; the timeout/output paths must not
  # re-probe systemctl (a PATH drift would pick a different answer).
  ORCA_HOST_SUPERVISOR=systemd
  # U181 P2: ORCA_ENV_FILE is the single env source; %h keeps the design default.
  ORCA_UNIT_ENV_FILE="$ORCA_ENV_FILE"
  if [ "$ORCA_ENV_FILE" = "$HOME/.orca-cloud/host.env" ]; then
    ORCA_UNIT_ENV_FILE='%h/.orca-cloud/host.env'
  fi
  # U181 P2: design §5.1 names the unit orca-host.service.
  ORCA_UNIT_FILE="$HOME/.config/systemd/user/orca-host.service"
  # Stop the pre-rename unit so two services cannot fight the profile lock.
  ORCA_LEGACY_UNIT_FILE="$HOME/.config/systemd/user/orca-cloud-host.service"
  if [ -f "$ORCA_LEGACY_UNIT_FILE" ]; then
    systemctl --user disable --now orca-cloud-host.service >/dev/null 2>&1 || true
    rm -f "$ORCA_LEGACY_UNIT_FILE"
  fi
  mkdir -p "$(dirname "$ORCA_UNIT_FILE")"
  cat > "$ORCA_UNIT_FILE" <<ORCA_HOST_UNIT
${renderHostUnit({
  binPath: '$ORCA_HOST_BIN',
  environmentFile: '$ORCA_UNIT_ENV_FILE'
})}ORCA_HOST_UNIT
  echo ">> 已写入 systemd 用户单元：$ORCA_UNIT_FILE"
  # H10b: StartLimit needs systemd >=229; degrade instead of writing dead keys.
  ORCA_SYSTEMD_VERSION="$(systemctl --version 2>/dev/null | head -n 1 | awk '{print $2}' || true)"
  case "$ORCA_SYSTEMD_VERSION" in
    ''|*[!0-9]*) : ;;
    *)
      if [ "$ORCA_SYSTEMD_VERSION" -lt 229 ]; then
        echo ">> 警告：systemd $ORCA_SYSTEMD_VERSION < 229，StartLimit 不可用，降级为 Restart=no（宿主内部有界重试）" >&2
        ORCA_UNIT_DEGRADED="$ORCA_UNIT_FILE.degraded"
        grep -vE '^(StartLimitIntervalSec|StartLimitBurst)=' "$ORCA_UNIT_FILE" \\
          | sed 's/^Restart=on-failure$/Restart=no/' > "$ORCA_UNIT_DEGRADED"
        mv -f "$ORCA_UNIT_DEGRADED" "$ORCA_UNIT_FILE"
      fi ;;
  esac
  # Linger is best-effort: without it the host still runs until logout.
  if command -v loginctl >/dev/null 2>&1 && ! loginctl enable-linger; then
    echo ">> 警告：loginctl enable-linger 失败，注销后宿主会停止；请手动执行 loginctl enable-linger" >&2
  fi
  if ! systemctl --user daemon-reload || ! systemctl --user enable --now orca-host.service; then
    echo ">> systemd 用户服务安装失败（69）：请检查 systemctl --user 是否可用后重试" >&2
    echo ">> 单元文件保留在 $ORCA_UNIT_FILE" >&2
    exit 69
  fi
else
  ORCA_HOST_SUPERVISOR=nohup
  # H10b: no user systemd (container/WSL/macOS). A wrapper makes host.env the
  # single config source and records the real pid ($! may be setsid).
  ORCA_HOST_WRAPPER="$HOME/.orca-cloud/run-host.sh"
  ORCA_HOST_PID_FILE="$HOME/.orca-cloud/host.pid"
  cat > "$ORCA_HOST_WRAPPER" <<ORCA_HOST_WRAPPER
#!/usr/bin/env bash
# Orca Cloud host launcher (H10b). host.env is the single config source.
set -eu
set -a
. "$ORCA_ENV_FILE"
set +a
echo \$\$ > "$ORCA_HOST_PID_FILE"
exec "$ORCA_HOST_BIN" --host-mode
ORCA_HOST_WRAPPER
  chmod 700 "$ORCA_HOST_WRAPPER"
  if command -v setsid >/dev/null 2>&1; then
    nohup setsid "$ORCA_HOST_WRAPPER" >> "$ORCA_HOST_LOG" 2>&1 &
  else
    nohup "$ORCA_HOST_WRAPPER" >> "$ORCA_HOST_LOG" 2>&1 &
  fi
  ORCA_HOST_PID=$!
  ORCA_HOST_DEADLINE=$((SECONDS + 10))
  while [ ! -s "$ORCA_HOST_PID_FILE" ] && [ "$SECONDS" -lt "$ORCA_HOST_DEADLINE" ]; do
    sleep 0.2
  done
  ORCA_HOST_PID="$(cat "$ORCA_HOST_PID_FILE" 2>/dev/null || printf '%s' "$ORCA_HOST_PID")"
fi

# State self-check (design §4.3): schema v2, online, successful heartbeat, a
# non-empty hostId and a live pid. 0 (ORCA_HOST_STATE_TIMEOUT) skips the wait.
# 120s covers the 61s worst-case enrolment (4×10s + 1/5/15s backoff) plus cold start.
ORCA_STATE_WAIT="\${ORCA_HOST_STATE_TIMEOUT:-120}"
case "$ORCA_STATE_WAIT" in ''|*[!0-9]*) ORCA_STATE_WAIT=120 ;; esac
if [ "$ORCA_STATE_WAIT" -gt 0 ]; then
  _orca_state_field() {
    { grep -o "\\"$1\\"[[:space:]]*:[[:space:]]*[^,}]*" "$ORCA_STATE_FILE" 2>/dev/null \\
        | head -n 1 | cut -d: -f2- | tr -d ' "' ; } || true
  }
  echo ">> 等待宿主上线（状态文件 $ORCA_STATE_FILE，超时 \${ORCA_STATE_WAIT}s）"
  ORCA_STATE_DEADLINE=$(( $(date +%s) + ORCA_STATE_WAIT ))
  ORCA_STATE_OK=0
  while :; do
    if [ -s "$ORCA_STATE_FILE" ]; then
      ORCA_STATE_SCHEMA="$(_orca_state_field schemaVersion)"
      ORCA_STATE_STATUS="$(_orca_state_field status)"
      ORCA_STATE_HEARTBEAT="$(_orca_state_field lastHeartbeatOk)"
      ORCA_STATE_HOST_ID="$(_orca_state_field hostId)"
      ORCA_STATE_PID="$(_orca_state_field pid)"
      ORCA_STATE_STARTED_AT="$(_orca_state_field startedAt)"
      ORCA_STATE_HEARTBEAT_AT="$(_orca_state_field lastHeartbeatAt)"
      ORCA_STATE_PLATFORM_URL="$(_orca_state_field platformUrl)"
      case "$ORCA_STATE_PID" in ''|*[!0-9]*) ORCA_STATE_PID=0 ;; esac
      # U181 P1-2: accept seconds fixtures as well as the schema's epoch ms.
      case "$ORCA_STATE_STARTED_AT" in ''|*[!0-9]*) ORCA_STATE_STARTED_AT=0 ;; esac
      if [ "$ORCA_STATE_STARTED_AT" -gt 0 ] && [ "$ORCA_STATE_STARTED_AT" -lt 100000000000 ]; then
        ORCA_STATE_STARTED_AT=$(( ORCA_STATE_STARTED_AT * 1000 ))
      fi
      case "$ORCA_STATE_HEARTBEAT_AT" in ''|*[!0-9]*) ORCA_STATE_HEARTBEAT_AT=0 ;; esac
      if [ "$ORCA_STATE_HEARTBEAT_AT" -gt 0 ] && [ "$ORCA_STATE_HEARTBEAT_AT" -lt 100000000000 ]; then
        ORCA_STATE_HEARTBEAT_AT=$(( ORCA_STATE_HEARTBEAT_AT * 1000 ))
      fi
      ORCA_NOW_MS="$(( $(date +%s) * 1000 ))"
      if [ "$ORCA_STATE_SCHEMA" = 2 ] \\
        && [ "$ORCA_STATE_STATUS" = online ] \\
        && [ "$ORCA_STATE_HEARTBEAT" = true ] \\
        && [ -n "$ORCA_STATE_HOST_ID" ] && [ "$ORCA_STATE_HOST_ID" != null ] \\
        && [ "$ORCA_STATE_PID" -gt 0 ] && kill -0 "$ORCA_STATE_PID" 2>/dev/null \\
        && [ "$ORCA_STATE_STARTED_AT" -gt 0 ] && [ "$ORCA_STATE_STARTED_AT" -ge "$ORCA_INSTALL_STARTED_AT_MS" ] \\
        && [ "$ORCA_STATE_HEARTBEAT_AT" -gt 0 ] && [ "$ORCA_STATE_HEARTBEAT_AT" -le "$ORCA_NOW_MS" ] \\
        && [ "$(( ORCA_NOW_MS - ORCA_STATE_HEARTBEAT_AT ))" -le 30000 ] \\
        && [ "$ORCA_STATE_PLATFORM_URL" = "$ORCA_CLOUD_API_URL" ]; then
        ORCA_STATE_OK=1
        break
      fi
    fi
    if [ "$(date +%s)" -ge "$ORCA_STATE_DEADLINE" ]; then break; fi
    sleep 1
  done
  if [ "$ORCA_STATE_OK" != 1 ]; then
    echo ">> 宿主未在 \${ORCA_STATE_WAIT}s 内上线（退出码 70）" >&2
    if [ -s "$ORCA_STATE_FILE" ]; then
      echo ">> 状态文件摘录（$ORCA_STATE_FILE）：" >&2
      sed -n '1,24p' "$ORCA_STATE_FILE" >&2 || true
    else
      echo ">> 状态文件不存在：$ORCA_STATE_FILE" >&2
    fi
    # U181 P2-9: systemd logs go to journald; only the nohup path owns host.log.
    if [ "$ORCA_HOST_SUPERVISOR" = systemd ] && command -v journalctl >/dev/null 2>&1; then
      echo ">> 宿主日志（journalctl --user -u orca-host.service）尾部：" >&2
      journalctl --user -u orca-host.service -n 40 --no-pager >&2 2>/dev/null || true
    else
      echo ">> 宿主日志（$ORCA_HOST_LOG）尾部：" >&2
      tail -n 40 "$ORCA_HOST_LOG" >&2 2>/dev/null || true
    fi
    exit 70
  fi
  echo ">> 宿主已上线：hostId=$ORCA_STATE_HOST_ID pid=$ORCA_STATE_PID"
fi

if [ "$ORCA_HOST_SUPERVISOR" = systemd ]; then
  cat <<ORCA_NEXT

宿主已由 systemd 用户服务托管：orca-host.service（日志：journalctl --user -u orca-host.service）。
后续可选命令在开发机上执行：
1) 查看状态：systemctl --user status orca-host.service
2) 查看日志：journalctl --user -u orca-host.service -n 40 --no-pager
3) 停止：systemctl --user stop orca-host.service
4) 前台调试前先停止服务：
   systemctl --user stop orca-host.service
   set -a; . "$ORCA_ENV_FILE"; set +a
   $ORCA_HOST_BIN --host-mode
ORCA_NEXT
  if [ "$ORCA_HAD_CREDENTIAL" = 1 ]; then
    cat <<ORCA_REENROLL

5) 重新注册（一次性参数；成功后旧凭据失效，新凭据写入 host.env）：
   systemctl --user stop orca-host.service
   set -a; . "$ORCA_ENV_FILE"; set +a
   "$ORCA_HOST_BIN" --host-mode --reenroll
ORCA_REENROLL
  fi
else
  # U182: containers/WSL/macOS have no user systemd; print runnable commands
  # instead of instructions that are guaranteed to fail.
  cat <<ORCA_NEXT

宿主已在后台启动（pid $ORCA_HOST_PID，日志 $ORCA_HOST_LOG）。
启动脚本：$ORCA_HOST_WRAPPER（已 chmod 700，source host.env 后 exec --host-mode）。
未检测到 systemctl：容器 / WSL / macOS 不支持用户级自启。后续可选命令：
1) 停止：kill "$ORCA_HOST_PID"
2) 重新后台启动：
   nohup setsid "$ORCA_HOST_WRAPPER" >> "$ORCA_HOST_LOG" 2>&1 &
ORCA_NEXT
  if [ "$ORCA_HAD_CREDENTIAL" = 1 ]; then
    cat <<ORCA_REENROLL

3) 重新注册（一次性参数；需先停止上面的进程，成功后旧凭据失效）：
   kill "$ORCA_HOST_PID"
   set -a; . "$ORCA_ENV_FILE"; set +a
   "$ORCA_HOST_BIN" --host-mode --reenroll
ORCA_REENROLL
  fi
fi
`
}

export type RelayBundleEmbed = {
  sha256: string
  schemaVersion: number
  relayCodeVersion: string
  /** https platforms force the download proto; local http keeps the sha pin only. */
  downloadTls: boolean
}

export function relayInstallScript(input: {
  platformUrl: string
  internalToken: string
  bundle?: RelayBundleEmbed
}): string {
  const bundle = input.bundle
  const bundleUrl = bundle ? `${input.platformUrl}/install/relay-bundle/${bundle.sha256}.tgz` : ''
  const bundleVars = bundle
    ? `
# U183 R2: content-addressed bundle pinned by sha; the URL must match the route.
ORCA_RELAY_BUNDLE_SHA256=${shellQuote(bundle.sha256)}
ORCA_RELAY_BUNDLE_URL=${shellQuote(bundleUrl)}
ORCA_RELAY_SCHEMA_VERSION=${bundle.schemaVersion}
ORCA_RELAY_CODE_VERSION=${shellQuote(bundle.relayCodeVersion)}
ORCA_RELAY_DOWNLOAD_TLS=${bundle.downloadTls ? '1' : '0'}
# R11a: a current link already at this sha means there is nothing to acquire.
ORCA_RELAY_RELEASES_DIR="$ORCA_RELAY_ROOT/releases"
ORCA_RELAY_RELEASE_DIR="$ORCA_RELAY_RELEASES_DIR/$ORCA_RELAY_BUNDLE_SHA256"
ORCA_RELAY_CURRENT_LINK="$ORCA_RELAY_ROOT/current"
ORCA_RELAY_DOWNLOAD_DIR="$ORCA_RELAY_ROOT/downloads"
ORCA_RELAY_RELEASE_REUSED=0
if [ -L "$ORCA_RELAY_CURRENT_LINK" ] && [ "$(readlink "$ORCA_RELAY_CURRENT_LINK")" = "releases/$ORCA_RELAY_BUNDLE_SHA256" ]; then
  ORCA_RELAY_RELEASE_REUSED=1
fi
# R5 bundle 下载命令参数（TLS 平台强制 https；本地 http 仅靠 sha 钉死）。
ORCA_RELAY_BUNDLE_CURL_OPTS=(${bundle.downloadTls ? "-fsSL --proto '=https' --tlsv1.2" : '-fsSL'})
${
  bundle.downloadTls
    ? ''
    : `if [ "$ORCA_RELAY_DOWNLOAD_TLS" = "0" ]; then
  echo ">> 警告：平台地址不是 https，bundle 下载未强制 TLS（仅限本地测试）" >&2
fi
`
}`
    : ''
  const bundleEnv = bundle
    ? `  printf '%s\\n' ${shellQuote(`ORCA_RELAY_BUNDLE_SHA256=${bundle.sha256}`)}
  printf '%s\\n' ${shellQuote(`ORCA_RELAY_BUNDLE_URL=${bundleUrl}`)}
  printf '%s\\n' ${shellQuote(`ORCA_RELAY_SCHEMA_VERSION=${bundle.schemaVersion}`)}
  printf '%s\\n' ${shellQuote(`ORCA_RELAY_CODE_VERSION=${bundle.relayCodeVersion}`)}
  printf '%s\\n' ${shellQuote(`ORCA_RELAY_DOWNLOAD_TLS=${bundle.downloadTls ? '1' : '0'}`)}
`
    : ''
  // U183 R6: type/path whitelist, empty-dir extraction, real-tree recheck and
  // atomic activation. Any safety, unpack or activation failure exits 67.
  const bundleUnpack = bundle
    ? `# U183 R6: inspect entries before extracting, then switch current atomically.
if [ "$ORCA_RELAY_RELEASE_REUSED" = "1" ]; then
  echo ">> 当前版本已是 $ORCA_RELAY_BUNDLE_SHA256，跳过下载、跳过解包与激活"
else
  # Allow only regular files and directories; x/g (pax), l/h, b/c, p and s fail.
  if ! ORCA_RELAY_TAR_TYPES="$(tar -tvzf "$ORCA_RELAY_BUNDLE_FILE" | cut -c1 | sort -u | tr -d '\\n')"; then
    echo ">> bundle 无法读取条目（67）" >&2
    exit 67
  fi
  case "$ORCA_RELAY_TAR_TYPES" in
    ''|*[!d-]*)
      echo ">> bundle 含非法条目类型（67）：$ORCA_RELAY_TAR_TYPES" >&2
      exit 67 ;;
  esac
  if ! ORCA_RELAY_TAR_NAMES="$(tar -tzf "$ORCA_RELAY_BUNDLE_FILE")"; then
    echo ">> bundle 无法读取条目名（67）" >&2
    exit 67
  fi
  if printf '%s\\n' "$ORCA_RELAY_TAR_NAMES" | grep -Eq '(^/|(^|/)\\.\\.(/|$))'; then
    echo ">> bundle 含绝对路径或 .. 条目（67）" >&2
    exit 67
  fi
  if printf '%s\\n' "$ORCA_RELAY_TAR_NAMES" | grep -Ev '^(VERSION|apps/|packages/)' >/dev/null; then
    echo ">> bundle 含白名单之外的顶层条目（67）" >&2
    exit 67
  fi
  ORCA_RELAY_TAR_OVERWRITE_FLAG=""
  if tar --version 2>/dev/null | head -n 1 | grep -q 'GNU tar'; then
    ORCA_RELAY_TAR_OVERWRITE_FLAG="--no-overwrite-dir"
  fi
  mkdir -p "$ORCA_RELAY_RELEASES_DIR"
  ORCA_RELAY_RELEASE_TMP="$ORCA_RELAY_RELEASE_DIR.tmp-$$"
  rm -rf "$ORCA_RELAY_RELEASE_TMP"
  mkdir -p "$ORCA_RELAY_RELEASE_TMP"
  if ! tar -xzf "$ORCA_RELAY_BUNDLE_FILE" -C "$ORCA_RELAY_RELEASE_TMP" --no-same-owner --no-same-permissions $ORCA_RELAY_TAR_OVERWRITE_FLAG; then
    rm -rf "$ORCA_RELAY_RELEASE_TMP"
    # Do not leave an empty releases/ behind when nothing was activated.
    rmdir "$ORCA_RELAY_RELEASES_DIR" 2>/dev/null || true
    echo ">> bundle 解包失败（67）" >&2
    exit 67
  fi
  # Re-check the real tree: only regular files and directories may survive.
  if [ -n "$(find "$ORCA_RELAY_RELEASE_TMP" ! -type f ! -type d -print -quit)" ]; then
    rm -rf "$ORCA_RELAY_RELEASE_TMP"
    rmdir "$ORCA_RELAY_RELEASES_DIR" 2>/dev/null || true
    echo ">> bundle 解包后含非普通文件/目录（67）" >&2
    exit 67
  fi
  for ORCA_RELAY_REQUIRED in VERSION apps/relay/src/relay.ts packages/contract/src/internal-fetch.ts; do
    if [ ! -f "$ORCA_RELAY_RELEASE_TMP/$ORCA_RELAY_REQUIRED" ]; then
      rm -rf "$ORCA_RELAY_RELEASE_TMP"
      rmdir "$ORCA_RELAY_RELEASES_DIR" 2>/dev/null || true
      echo ">> bundle 缺少必需文件 $ORCA_RELAY_REQUIRED（67）" >&2
      exit 67
    fi
  done
  rm -rf "$ORCA_RELAY_RELEASE_DIR"
  if ! mv "$ORCA_RELAY_RELEASE_TMP" "$ORCA_RELAY_RELEASE_DIR"; then
    rm -rf "$ORCA_RELAY_RELEASE_TMP"
    echo ">> bundle 释放目录落位失败（67）" >&2
    exit 67
  fi
  # R11b: provenance marker — prune never removes a directory this script did
  # not create, even if an operator happened to name it like a sha.
  printf '%s\\n' "$ORCA_RELAY_BUNDLE_SHA256" > "$ORCA_RELAY_RELEASE_DIR/.orca-relay-release"
fi

if [ "$ORCA_RELAY_RELEASE_REUSED" = "0" ]; then
  # Keep the old target as previous only when the sha actually changes.
  ORCA_RELAY_OLD_TARGET="$(readlink "$ORCA_RELAY_CURRENT_LINK" 2>/dev/null || true)"
  if [ -n "$ORCA_RELAY_OLD_TARGET" ] && [ "$ORCA_RELAY_OLD_TARGET" != "releases/$ORCA_RELAY_BUNDLE_SHA256" ]; then
    orca_relay_atomic_link "$ORCA_RELAY_OLD_TARGET" "$ORCA_RELAY_ROOT/previous" || { echo ">> 记录 previous 失败（67）" >&2; exit 67; }
  fi
  orca_relay_atomic_link "releases/$ORCA_RELAY_BUNDLE_SHA256" "$ORCA_RELAY_CURRENT_LINK" || { echo ">> 切换 current 失败（67）" >&2; exit 67; }
  echo ">> 已激活版本 $ORCA_RELAY_BUNDLE_SHA256"
fi
`
    : ''
  // U183 R5: download and pin the bundle; failures are 65 (unavailable),
  // 66 (checksum) and 67 (manifest mismatch).
  const bundleAcquire = bundle
    ? `# U183 R5: acquire the pinned bundle and verify it before any env write.
# R11a: same-sha reruns have nothing to download or verify.
if [ "$ORCA_RELAY_RELEASE_REUSED" = "0" ]; then
ORCA_RELAY_BUNDLE_FILE=""
ORCA_RELAY_BUNDLE_OFFLINE=0
if [ -n "\${ORCA_RELAY_BUNDLE:-}" ]; then
  ORCA_RELAY_BUNDLE_OFFLINE=1
  ORCA_RELAY_BUNDLE_FILE="$ORCA_RELAY_BUNDLE"
  if [ ! -f "$ORCA_RELAY_BUNDLE_FILE" ]; then
    echo ">> 离线 bundle 不存在（65）：$ORCA_RELAY_BUNDLE_FILE" >&2
    exit 65
  fi
  echo ">> 使用离线 bundle：$ORCA_RELAY_BUNDLE_FILE"
else
  mkdir -p "$ORCA_RELAY_DOWNLOAD_DIR"
  ORCA_RELAY_BUNDLE_TARGET="$ORCA_RELAY_DOWNLOAD_DIR/$ORCA_RELAY_BUNDLE_SHA256.tgz"
  if [ -f "$ORCA_RELAY_BUNDLE_TARGET" ]; then
    ORCA_RELAY_BUNDLE_FILE="$ORCA_RELAY_BUNDLE_TARGET"
    echo ">> 复用已下载 bundle"
  else
    ORCA_RELAY_BUNDLE_FILE="$ORCA_RELAY_BUNDLE_TARGET.part"
    echo ">> 下载 relay bundle"
    if ! curl "\${ORCA_RELAY_BUNDLE_CURL_OPTS[@]}" --connect-timeout 10 --max-time 120 -o "$ORCA_RELAY_BUNDLE_FILE" "$ORCA_RELAY_BUNDLE_URL"; then
      rm -f "$ORCA_RELAY_BUNDLE_FILE"
      echo ">> bundle 下载失败（65）：$ORCA_RELAY_BUNDLE_URL" >&2
      exit 65
    fi
  fi
fi

if command -v sha256sum >/dev/null 2>&1; then
  ORCA_RELAY_ACTUAL_SHA="$(sha256sum "$ORCA_RELAY_BUNDLE_FILE" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  ORCA_RELAY_ACTUAL_SHA="$(shasum -a 256 "$ORCA_RELAY_BUNDLE_FILE" | awk '{print $1}')"
else
  echo ">> 未找到 sha256sum/shasum（64）：无法校验 relay bundle" >&2
  exit 64
fi
if [ "$ORCA_RELAY_ACTUAL_SHA" != "$ORCA_RELAY_BUNDLE_SHA256" ]; then
  if [ "$ORCA_RELAY_BUNDLE_OFFLINE" = "0" ]; then rm -f "$ORCA_RELAY_BUNDLE_FILE"; fi
  echo ">> bundle 校验失败（66）：sha256 与脚本内嵌值不符" >&2
  exit 66
fi
if [ "$ORCA_RELAY_BUNDLE_OFFLINE" = "0" ]; then
  if [ "$ORCA_RELAY_BUNDLE_FILE" != "$ORCA_RELAY_BUNDLE_TARGET" ]; then
    mv "$ORCA_RELAY_BUNDLE_FILE" "$ORCA_RELAY_BUNDLE_TARGET"
    ORCA_RELAY_BUNDLE_FILE="$ORCA_RELAY_BUNDLE_TARGET"
  fi
  ORCA_RELAY_MANIFEST_URL="\${ORCA_RELAY_BUNDLE_URL%.tgz}.manifest.json"
  ORCA_RELAY_MANIFEST_FILE="$ORCA_RELAY_DOWNLOAD_DIR/$ORCA_RELAY_BUNDLE_SHA256.manifest.json.part"
  echo ">> 校验 relay bundle 清单"
  if ! curl "\${ORCA_RELAY_BUNDLE_CURL_OPTS[@]}" --connect-timeout 10 --max-time 120 -o "$ORCA_RELAY_MANIFEST_FILE" "$ORCA_RELAY_MANIFEST_URL"; then
    rm -f "$ORCA_RELAY_MANIFEST_FILE"
    echo ">> bundle 清单获取失败（67）：$ORCA_RELAY_MANIFEST_URL" >&2
    exit 67
  fi
  if ! { grep -Fq "\\"bundleSha256\\": \\"$ORCA_RELAY_BUNDLE_SHA256\\"" "$ORCA_RELAY_MANIFEST_FILE" &&
    grep -Fq "\\"schemaVersion\\": $ORCA_RELAY_SCHEMA_VERSION" "$ORCA_RELAY_MANIFEST_FILE" &&
    grep -Fq "\\"relayCodeVersion\\": \\"$ORCA_RELAY_CODE_VERSION\\"" "$ORCA_RELAY_MANIFEST_FILE"; }; then
    rm -f "$ORCA_RELAY_MANIFEST_FILE"
    echo ">> bundle 清单与脚本内嵌值不符（67）" >&2
    exit 67
  fi
  rm -f "$ORCA_RELAY_MANIFEST_FILE"
fi
fi
`
    : ''
  return `#!/usr/bin/env bash
# Orca Cloud 中继接入脚本（平台生成；内嵌内部控制令牌，仅管理员可见）
set -euo pipefail
umask 077

# U183 R8: the unit's EnvironmentFile is <ROOT>/relay.env, so the env must live
# there too; the root is also what isolates co-located relays.
ORCA_RELAY_ROOT="\${ORCA_RELAY_ROOT:-$HOME/.orca-cloud/relay}"
ORCA_ENV_FILE="\${ORCA_ENV_FILE:-$ORCA_RELAY_ROOT/relay.env}"
ORCA_ENV_DIR="$(dirname "$ORCA_ENV_FILE")"
# R11b: upgraded releases survive as previous until the next sha change.
ORCA_RELAY_RELEASE_REUSED=0
ORCA_RELAY_PROOF_FAILURE=""
# R11b: point a symlink at a release via rename, so readers never see a gap.
orca_relay_atomic_link() {
  ln -sfn "$1" "$2.new" || return 1
  if ! mv -T "$2.new" "$2" 2>/dev/null; then
    rm -f "$2.new"
    ln -sfn "$1" "$2" || return 1
  fi
}
${bundleVars}

# U183 R4: preflight before any write. Node missing/old is EX_USAGE (64);
# an unusable entry or install root is EX_CONFIG (78); platform unreachable
# is 68. A failed preflight leaves no relay.env and no release behind.
ORCA_NODE_BIN="$(command -v node 2>/dev/null || true)"
${requireCommand('node', '未找到 node（64）：本脚本不安装中继运行时，请安装 Node.js >=22.18 并确保其在 PATH 中', 64)}
${requireNodeVersion('"$ORCA_NODE_BIN"', 22, 18, 'Node.js 版本过低（64）：中继需要 >=22.18')}
${
  bundle
    ? `# U184: bundle mode ships its own code under current/; no repo checkout needed.
ORCA_RELAY_ENTRY="$ORCA_RELAY_ROOT/current/apps/relay/src/relay.ts"`
    : `ORCA_RELAY_ENTRY="$ORCA_RELAY_ROOT/cloud-platform/apps/relay/src/relay.ts"
if [ ! -f "$ORCA_RELAY_ENTRY" ]; then
  echo ">> 未找到中继程序 $ORCA_RELAY_ENTRY（78）：本脚本不安装中继代码，请把 Orca 仓库放到该路径，或设置 ORCA_RELAY_ROOT" >&2
  exit 78
fi
if [ "\${ORCA_RELAY_ALLOW_UNVERIFIED:-}" != "1" ]; then
  echo ">> 仓库/未校验目录安装需 ORCA_RELAY_ALLOW_UNVERIFIED=1（78）：仅限开发，生产请使用 bundle" >&2
  exit 78
fi
echo ">> 警告：使用未校验的中继目录 $ORCA_RELAY_ENTRY（仅限开发）" >&2`
}
${requireWritableDir('$ORCA_RELAY_ROOT', '安装根不可写（78）：请设置 ORCA_RELAY_ROOT 指向当前用户可写目录后重试')}

# U183 R11a: portable mkdir lock (flock is not on every target). The lock holds
# the installer pid so a crashed run is detected as stale instead of blocking.
ORCA_RELAY_LOCK_DIR="$ORCA_RELAY_ROOT/.install.lock"
ORCA_RELAY_LOCK_OWNER=0
orca_relay_lock_release() {
  if [ "$ORCA_RELAY_LOCK_OWNER" = "1" ]; then
    rm -rf "$ORCA_RELAY_LOCK_DIR"
  fi
}
trap orca_relay_lock_release EXIT
if ! mkdir "$ORCA_RELAY_LOCK_DIR" 2>/dev/null; then
  ORCA_RELAY_LOCK_PID="$(tr -d '[:space:]' < "$ORCA_RELAY_LOCK_DIR/pid" 2>/dev/null || true)"
  # A concurrent installer may have mkdir'd but not written pid yet.
  if [ -z "$ORCA_RELAY_LOCK_PID" ]; then
    sleep 1
    ORCA_RELAY_LOCK_PID="$(tr -d '[:space:]' < "$ORCA_RELAY_LOCK_DIR/pid" 2>/dev/null || true)"
  fi
  if [ -n "$ORCA_RELAY_LOCK_PID" ] && kill -0 "$ORCA_RELAY_LOCK_PID" 2>/dev/null; then
    echo ">> 另一个安装正在进行（pid=$ORCA_RELAY_LOCK_PID）：请稍后重试（75 / relay_install_busy）" >&2
    exit 75
  fi
  echo ">> 清理残留安装锁（pid=\${ORCA_RELAY_LOCK_PID:-<空>} 已不存在）"
  rm -rf "$ORCA_RELAY_LOCK_DIR"
  if ! mkdir "$ORCA_RELAY_LOCK_DIR" 2>/dev/null; then
    echo ">> 无法获取安装锁（75 / relay_install_busy）：$ORCA_RELAY_LOCK_DIR" >&2
    exit 75
  fi
fi
ORCA_RELAY_LOCK_OWNER=1
printf '%s\\n' "$$" > "$ORCA_RELAY_LOCK_DIR/pid"
printf '%s\\n' "$(date +%s 2>/dev/null || printf '0')" > "$ORCA_RELAY_LOCK_DIR/started"

ORCA_PLATFORM_URL=${shellQuote(input.platformUrl)}
# U183 R10b: the installer itself queries the internal relay list.
ORCA_CLOUD_INTERNAL_TOKEN=${shellQuote(input.internalToken)}
echo ">> 平台连通性检查"
# U182: no redirect following; only an explicit 2xx is healthy, and bounded time
# so a black-holed DNS/gateway cannot hang the install.
ORCA_HEALTH_CODE="$(curl -sS --connect-timeout 5 --max-time 10 -o /dev/null -w '%{http_code}' "$ORCA_PLATFORM_URL/health")" || ORCA_HEALTH_CODE=000
case "$ORCA_HEALTH_CODE" in
  2??) ;;
  *) echo ">> 平台健康检查失败（68 / HTTP $ORCA_HEALTH_CODE）：$ORCA_PLATFORM_URL/health 不可达" >&2; exit 68 ;;
esac

${bundleAcquire}
${bundleUnpack}
mkdir -p "$ORCA_ENV_DIR"
chmod 700 "$ORCA_ENV_DIR" 2>/dev/null || true

echo ">> 写入环境配置 $ORCA_ENV_FILE"
# U183 R7: RELAY_ID is stable once written; a rerun keeps the existing identity.
ORCA_RELAY_PORT="\${PORT:-18443}"
ORCA_RELAY_ID=""
if [ -f "$ORCA_ENV_FILE" ]; then
  while IFS='=' read -r ORCA_ENV_KEY ORCA_ENV_VALUE; do
    if [ "$ORCA_ENV_KEY" = "ORCA_CLOUD_RELAY_ID" ] && [ -n "$ORCA_ENV_VALUE" ]; then
      ORCA_RELAY_ID="$ORCA_ENV_VALUE"
    fi
  done < "$ORCA_ENV_FILE"
fi
if [ -z "$ORCA_RELAY_ID" ]; then
  ORCA_RELAY_HOST="$(hostname 2>/dev/null || true)"
  if [ -z "$ORCA_RELAY_HOST" ]; then ORCA_RELAY_HOST="relay"; fi
  ORCA_RELAY_ID="$ORCA_RELAY_HOST:$ORCA_RELAY_PORT"
fi
# U183 R7/R10a: this install's nonce, announced by the running relay (1-128 chars).
ORCA_INSTALL_NONCE="$(openssl rand -hex 16 2>/dev/null || true)"
if [ -z "$ORCA_INSTALL_NONCE" ]; then
  ORCA_INSTALL_NONCE="$(date +%s 2>/dev/null || printf '0')-$$"
fi
# One atomic write: a rerun replaces the whole file, never appends or truncates it.
ORCA_ENV_TMP="$(mktemp "\${ORCA_ENV_FILE}.XXXXXX")"
{
  printf 'ORCA_CLOUD_API_URL=%s\\n' "$ORCA_PLATFORM_URL"
  printf '%s\\n' ${shellQuote(`ORCA_CLOUD_INTERNAL_TOKEN=${input.internalToken}`)}
  printf 'PORT=%s\\n' "$ORCA_RELAY_PORT"
  printf 'RELAY_PUBLIC_HOST=%s\\n' "\${RELAY_PUBLIC_HOST:-}"
  printf 'ORCA_CLOUD_RELAY_ID=%s\\n' "$ORCA_RELAY_ID"
  printf 'ORCA_CLOUD_INSTALL_NONCE=%s\\n' "$ORCA_INSTALL_NONCE"
${bundleEnv}} > "$ORCA_ENV_TMP"
chmod 600 "$ORCA_ENV_TMP"
mv -f "$ORCA_ENV_TMP" "$ORCA_ENV_FILE"
chmod 600 "$ORCA_ENV_FILE"
echo ">> 环境已就绪：$ORCA_ENV_FILE"

# U183 R10b: prove this install's relay is the process that came online.
# Local pid (systemd MainPID or the wrapper pid file) plus its cmdline carry
# process identity; the platform is only asked whether this install's nonce is
# online, so a stale relay reusing RELAY_ID cannot impersonate the new one.
orca_relay_self_proof() {
  local proof_timeout="\${1:-\${ORCA_RELAY_PROOF_TIMEOUT:-60}}"
  local proof_interval="\${ORCA_RELAY_PROOF_INTERVAL:-2}"
  local proof_body proof_headers proof_pid proof_status proof_json proof_entry
  local proof_nonce proof_last_seen proof_now_ms proof_date proof_epoch proof_date_ms
  local proof_skew_ms proof_abs_skew proof_tolerance proof_diff proof_ok proof_degraded=0
  local ORCA_RELAY_CMDLINE=""
  if [ "$proof_timeout" = "0" ]; then
    return 0
  fi
  proof_body="$(mktemp)"
  proof_headers="$(mktemp)"
  ORCA_RELAY_PROOF_DEADLINE=$((SECONDS + proof_timeout))
  while :; do
    if [ "$ORCA_RELAY_PROOF_KIND" = "systemd" ]; then
      proof_pid="$(systemctl --user show -p MainPID --value orca-relay.service 2>/dev/null || true)"
    else
      proof_pid="$(cat "$ORCA_RELAY_ROOT/relay.pid" 2>/dev/null || true)"
    fi
    proof_pid="$(printf '%s' "$proof_pid" | tr -d '[:space:]')"
    if [ -z "$proof_pid" ] || [ "$proof_pid" = "0" ] || ! kill -0 "$proof_pid" 2>/dev/null; then
      echo ">> 中继进程不存在（pid=\${proof_pid:-<空>}）：自证失败（70 / relay_not_online_timeout）" >&2
      ORCA_RELAY_PROOF_FAILURE="process"
      rm -f "$proof_body" "$proof_headers"
      return 1
    fi
    # Linux exposes /proc; macOS has no it, so fall back to ps.
    if [ -r "/proc/$proof_pid/cmdline" ]; then
      ORCA_RELAY_CMDLINE="$(tr '\\0' ' ' < "/proc/$proof_pid/cmdline" 2>/dev/null || true)"
    else
      ORCA_RELAY_CMDLINE="$(ps -p "$proof_pid" -o command= 2>/dev/null || true)"
    fi
    case "$ORCA_RELAY_CMDLINE" in
      *relay.ts*) ;;
      *)
        echo ">> 中继进程 cmdline 不含 relay.ts（pid=$proof_pid）：自证失败（70 / relay_not_online_timeout）" >&2
        ORCA_RELAY_PROOF_FAILURE="process"
        rm -f "$proof_body" "$proof_headers"
        return 1 ;;
    esac

    proof_status="$(curl -sS --connect-timeout 5 --max-time 10 -D "$proof_headers" -o "$proof_body" -w '%{http_code}' \
      -H "x-internal-token: $ORCA_CLOUD_INTERNAL_TOKEN" \
      "$ORCA_PLATFORM_URL/v1/internal/relays" 2>/dev/null || true)"
    case "$proof_status" in
      401|403)
        echo ">> 内部令牌不匹配（HTTP $proof_status）：安装命令已失效或内部控制令牌不一致，请让管理员重新生成" >&2
        ORCA_RELAY_PROOF_FAILURE="credentials"
        rm -f "$proof_body" "$proof_headers"
        return 1 ;;
    esac

    proof_ok=0
    if [ "$proof_status" = "200" ]; then
      proof_json="$(tr -d '[:space:]' < "$proof_body" 2>/dev/null || true)"
      proof_entry="$(printf '%s' "$proof_json" | tr '}' '\\n' | grep -F "\\"id\\":\\"$ORCA_RELAY_ID\\"" | head -n 1 || true)"
      case "$proof_entry" in
        *'"online":true'*) proof_ok=1 ;;
      esac
      if [ "$proof_ok" = "1" ]; then
        proof_nonce="$(printf '%s' "$proof_entry" | grep -o '"installNonce":"[^"]*"' | cut -d: -f2 | tr -d '"' || true)"
        if [ -z "$proof_nonce" ]; then
          # Old relay or old platform: fall back to identity + online, but say so.
          if [ "$proof_degraded" = "0" ]; then
            echo ">> 警告：平台未回显安装 nonce（旧中继或旧平台），退回进程身份 + online 自证" >&2
            proof_degraded=1
          fi
        elif [ "$proof_nonce" != "$ORCA_INSTALL_NONCE" ]; then
          proof_ok=0
        fi
      fi
      if [ "$proof_ok" = "1" ]; then
        # lastSeenAt is platform epoch ms; estimate platform clock from Date.
        proof_last_seen="$(printf '%s' "$proof_entry" | grep -o '"lastSeenAt":[0-9]*' | cut -d: -f2 || true)"
        proof_now_ms=$(( $(date +%s) * 1000 ))
        proof_date="$(grep -i '^date:' "$proof_headers" 2>/dev/null | head -n 1 | cut -d' ' -f2- | tr -d '\\r' || true)"
        proof_date_ms=""
        if [ -n "$proof_date" ]; then
          if proof_epoch="$(date -u -d "$proof_date" +%s 2>/dev/null)"; then
            proof_date_ms=$((proof_epoch * 1000))
          elif proof_epoch="$(date -j -u -f '%a, %d %b %Y %H:%M:%S GMT' "$proof_date" +%s 2>/dev/null)"; then
            proof_date_ms=$((proof_epoch * 1000))
          fi
        fi
        proof_skew_ms=0
        if [ -n "$proof_date_ms" ] && [ "$proof_date_ms" -gt 0 ]; then
          proof_skew_ms=$((proof_now_ms - proof_date_ms))
        fi
        proof_abs_skew=$proof_skew_ms
        case "$proof_abs_skew" in -*) proof_abs_skew=$((-proof_abs_skew)) ;; esac
        proof_tolerance=5000
        if [ "$proof_abs_skew" -gt 3000 ]; then
          proof_tolerance=$((proof_abs_skew + 2000))
        fi
        if [ -z "$proof_last_seen" ]; then
          proof_ok=0
        else
          proof_diff=$((proof_now_ms - proof_skew_ms - proof_last_seen))
          case "$proof_diff" in -*) proof_diff=$((-proof_diff)) ;; esac
          if [ "$proof_diff" -gt "$proof_tolerance" ]; then
            proof_ok=0
          fi
        fi
      fi
    fi

    if [ "$proof_ok" = "1" ]; then
      echo ">> 中继自证通过（id=$ORCA_RELAY_ID pid=$proof_pid）"
      ORCA_RELAY_PROOF_FAILURE=""
      rm -f "$proof_body" "$proof_headers"
      return 0
    fi
    [ "$SECONDS" -lt "$ORCA_RELAY_PROOF_DEADLINE" ] || break
    sleep "$proof_interval"
  done

  echo ">> 中继未通过自证（70 / relay_not_online_timeout）" >&2
  echo ">> pid=$proof_pid cmdline=\${ORCA_RELAY_CMDLINE:-<空>}" >&2
  echo ">> 平台 /v1/internal/relays 响应：" >&2
  cat "$proof_body" >&2 2>/dev/null || true
  echo ">> 中继日志尾部：" >&2
  if [ "$ORCA_RELAY_PROOF_KIND" = "systemd" ]; then
    journalctl --user -u orca-relay.service -n 20 --no-pager >&2 2>/dev/null || true
  else
    tail -n 20 "$ORCA_RELAY_ROOT/relay.log" >&2 2>/dev/null || true
  fi
  rm -f "$proof_body" "$proof_headers"
  ORCA_RELAY_PROOF_FAILURE="timeout"
  return 1
}

# R11b: keep only current and previous; only sha-named dirs this script owns.
orca_relay_prune_releases() {
  [ -n "\${ORCA_RELAY_RELEASES_DIR:-}" ] || return 0
  local current_target previous_target entry name
  current_target="$(readlink "$ORCA_RELAY_CURRENT_LINK" 2>/dev/null || true)"
  previous_target="$(readlink "$ORCA_RELAY_ROOT/previous" 2>/dev/null || true)"
  for entry in "$ORCA_RELAY_RELEASES_DIR"/*; do
    [ -e "$entry" ] || continue
    [ -L "$entry" ] && continue
    [ -d "$entry" ] || continue
    # Provenance: only dirs unpacked by this script carry the marker.
    [ -f "$entry/.orca-relay-release" ] || continue
    name="\${entry##*/}"
    [ "\${#name}" -eq 64 ] || continue
    case "$name" in *[!0-9a-f]*) continue ;; esac
    if [ "releases/$name" = "$current_target" ] || [ "releases/$name" = "$previous_target" ]; then
      continue
    fi
    rm -rf "$entry"
    echo ">> 清理旧 release $name（保留 current/previous）"
  done
}

# R15: bundle cache keeps only the current and previous shas; a failed run's
# .part files are diagnostics and expire after 7 days.
orca_relay_prune_downloads() {
  [ -n "\${ORCA_RELAY_DOWNLOAD_DIR:-}" ] || return 0
  [ -d "$ORCA_RELAY_DOWNLOAD_DIR" ] || return 0
  local current_target previous_target keep_current keep_previous entry name
  current_target="$(readlink "$ORCA_RELAY_CURRENT_LINK" 2>/dev/null || true)"
  previous_target="$(readlink "$ORCA_RELAY_ROOT/previous" 2>/dev/null || true)"
  keep_current="\${current_target#releases/}"
  keep_previous="\${previous_target#releases/}"
  for entry in "$ORCA_RELAY_DOWNLOAD_DIR"/*.tgz; do
    [ -e "$entry" ] || continue
    name="\${entry##*/}"
    name="\${name%.tgz}"
    [ "\${#name}" -eq 64 ] || continue
    case "$name" in *[!0-9a-f]*) continue ;; esac
    if [ "$name" = "$keep_current" ] || [ "$name" = "$keep_previous" ]; then
      continue
    fi
    rm -f "$entry"
    echo ">> 清理无主 bundle 缓存 $name.tgz"
  done
  find "$ORCA_RELAY_DOWNLOAD_DIR" -maxdepth 1 -name '*.part' -mtime +7 -exec rm -f {} + 2>/dev/null || true
}

# R11b: a failed upgrade rolls back to previous, restarts and re-proves. A
# same-sha rerun has no new version to blame, so it never produces a rollback.
orca_relay_rollback() {
  local rollback_target=""
  rollback_target="$(readlink "$ORCA_RELAY_ROOT/previous" 2>/dev/null || true)"
  if [ -z "$rollback_target" ]; then
    echo ">> rollback=failed：previous 链接不可读（70）" >&2
    exit 70
  fi
  echo ">> 尝试回滚到 previous=$rollback_target（新版本未上线）" >&2
  if ! orca_relay_atomic_link "$rollback_target" "$ORCA_RELAY_ROOT/current"; then
    echo ">> rollback=failed previous=$rollback_target：切换 current 失败（70）" >&2
    exit 70
  fi
  if ! orca_relay_restart; then
    echo ">> rollback=failed previous=$rollback_target：回滚版本启动失败（70）" >&2
    exit 70
  fi
  if orca_relay_self_proof "\${ORCA_RELAY_ROLLBACK_PROOF_TIMEOUT:-30}"; then
    echo ">> rollback=ok previous=$rollback_target：已回滚到 \${rollback_target#releases/}，新版本未上线（70 / relay_rollback_succeeded）" >&2
    exit 70
  fi
  echo ">> rollback=failed previous=$rollback_target：回滚后仍未上线（70）" >&2
  exit 70
}

orca_relay_handle_proof_failure() {
  # Credentials are not a version defect: rolling back cannot fix a bad token.
  if [ "$ORCA_RELAY_PROOF_FAILURE" = "credentials" ]; then
    # U189: this token can never register, so do not leave a relay running.
    echo ">> 停止本次启动的中继进程（令牌无效，无法上线）" >&2
    if [ "$ORCA_RELAY_PROOF_KIND" = "systemd" ]; then
      systemctl --user stop orca-relay.service >/dev/null 2>&1 || true
    else
      orca_relay_stop_wrapper
    fi
    exit 70
  fi
  if [ "$ORCA_RELAY_RELEASE_REUSED" = "1" ] || [ ! -L "$ORCA_RELAY_ROOT/previous" ]; then
    exit 70
  fi
  orca_relay_rollback
}

orca_relay_handle_start_failure() {
  if [ "$ORCA_RELAY_RELEASE_REUSED" = "1" ] || [ ! -L "$ORCA_RELAY_ROOT/previous" ]; then
    exit 69
  fi
  orca_relay_rollback
}

if ${systemdAvailable()}; then
  # U183 R8: install the user unit from the shared H10a template. Its
  # EnvironmentFile is <ROOT>/relay.env and its ExecStart follows current,
  # so a rollback only flips the symlink.
  ORCA_RELAY_UNIT_FILE="$HOME/.config/systemd/user/orca-relay.service"
  mkdir -p "$(dirname "$ORCA_RELAY_UNIT_FILE")"
  ORCA_RELAY_UNIT_EXISTED=0
  if [ -f "$ORCA_RELAY_UNIT_FILE" ]; then ORCA_RELAY_UNIT_EXISTED=1; fi
  # R11a: identical reruns must not recreate the unit (nor restart it needlessly).
  ORCA_RELAY_UNIT_TMP="$ORCA_RELAY_UNIT_FILE.tmp.$$"
  cat > "$ORCA_RELAY_UNIT_TMP" <<ORCA_RELAY_UNIT
${renderRelayUnit({
  nodePath: '$ORCA_NODE_BIN',
  root: '$ORCA_RELAY_ROOT',
  entry: '$ORCA_RELAY_ENTRY',
  workingDirectory: bundle ? '$ORCA_RELAY_ROOT/current' : '$ORCA_RELAY_ROOT'
})}ORCA_RELAY_UNIT
  # U187: StartLimit needs systemd >=229; older hosts degrade to Restart=no.
  ORCA_SYSTEMD_VERSION="$(systemctl --version 2>/dev/null | head -n 1 | awk '{print $2}' || true)"
  case "$ORCA_SYSTEMD_VERSION" in
    ''|*[!0-9]*) : ;;
    *)
      if [ "$ORCA_SYSTEMD_VERSION" -lt 229 ]; then
        echo ">> 警告：systemd $ORCA_SYSTEMD_VERSION < 229，StartLimit 不可用，降级为 Restart=no" >&2
        ORCA_RELAY_UNIT_DEGRADED="$ORCA_RELAY_UNIT_TMP.degraded"
        grep -vE '^(StartLimitIntervalSec|StartLimitBurst)=' "$ORCA_RELAY_UNIT_TMP" \\
          | sed 's/^Restart=on-failure$/Restart=no/' > "$ORCA_RELAY_UNIT_DEGRADED"
        mv -f "$ORCA_RELAY_UNIT_DEGRADED" "$ORCA_RELAY_UNIT_TMP"
      fi ;;
  esac
  if [ -f "$ORCA_RELAY_UNIT_FILE" ] && cmp -s "$ORCA_RELAY_UNIT_TMP" "$ORCA_RELAY_UNIT_FILE"; then
    rm -f "$ORCA_RELAY_UNIT_TMP"
    echo ">> systemd 用户单元未变化，跳过重写：$ORCA_RELAY_UNIT_FILE"
  else
    mv -f "$ORCA_RELAY_UNIT_TMP" "$ORCA_RELAY_UNIT_FILE"
    echo ">> 已写入 systemd 用户单元：$ORCA_RELAY_UNIT_FILE"
  fi
  if ! systemctl --user daemon-reload || ! systemctl --user enable --now orca-relay.service; then
    echo ">> systemd 用户服务安装失败（69 / relay_service_install_failed）：请检查 systemctl --user 是否可用后重试" >&2
    echo ">> 单元文件保留在 $ORCA_RELAY_UNIT_FILE" >&2
    exit 69
  fi
  # R11b: an existing unit must be restarted so a new release (or a refreshed
  # nonce) actually runs; enable --now is a no-op on an active service.
  orca_relay_restart() {
    systemctl --user restart orca-relay.service
  }
  if [ "$ORCA_RELAY_UNIT_EXISTED" = "1" ]; then
    if ! orca_relay_restart; then
      echo ">> 中继服务重启失败（69 / relay_service_install_failed）" >&2
      exit 69
    fi
  fi
  # U183 R10b: MainPID + cmdline identity, then this install's nonce online.
  ORCA_RELAY_PROOF_KIND=systemd
  if ! orca_relay_self_proof; then
    orca_relay_handle_proof_failure
  fi
  orca_relay_prune_releases
  orca_relay_prune_downloads

  cat <<ORCA_NEXT

中继已由 systemd 用户服务托管：orca-relay.service（配置文件 $ORCA_ENV_FILE）。
1) 查看状态：systemctl --user status orca-relay.service
2) 停止：systemctl --user stop orca-relay.service
3) 前台调试前先停止服务：
   systemctl --user stop orca-relay.service
   set -a; . "$ORCA_ENV_FILE"; set +a
   $ORCA_NODE_BIN $ORCA_RELAY_ENTRY

说明：RELAY_PUBLIC_HOST 填客户端可达地址（NAT/跨网段必填）；缺省时平台记录注册来源 IP。
ORCA_NEXT
else
  # U183 R9: no systemd (containers / WSL / macOS). Install a wrapper that
  # sources relay.env and execs node, then start it now — not at boot.
  ORCA_RELAY_WRAPPER="$ORCA_RELAY_ROOT/run-relay.sh"
  ORCA_RELAY_LOG="$ORCA_RELAY_ROOT/relay.log"
  ORCA_RELAY_PID_FILE="$ORCA_RELAY_ROOT/relay.pid"
  cat > "$ORCA_RELAY_WRAPPER" <<ORCA_RELAY_WRAPPER
#!/usr/bin/env bash
# Orca Cloud relay launcher (U183 R9). relay.env is the single config source.
set -eu
set -a
. "$ORCA_ENV_FILE"
set +a
echo \\$\\$ > "$ORCA_RELAY_PID_FILE"
exec "$ORCA_NODE_BIN" "$ORCA_RELAY_ENTRY"
ORCA_RELAY_WRAPPER
  chmod 700 "$ORCA_RELAY_WRAPPER"
  echo ">> 已写入启动脚本：$ORCA_RELAY_WRAPPER"

  # U183 R9: $! is the nohup/setsid wrapper, not the relay. The wrapper writes
  # its own $$ (it execs node, so the pid does not change) — that is the pid
  # we record, no pgrep/ps fan-out needed.
  orca_relay_stop_wrapper() {
    local old_pid="" waited=0
    old_pid="$(cat "$ORCA_RELAY_PID_FILE" 2>/dev/null || true)"
    old_pid="$(printf '%s' "$old_pid" | tr -d '[:space:]')"
    if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
      kill "$old_pid" 2>/dev/null || true
      while kill -0 "$old_pid" 2>/dev/null && [ "$waited" -lt 50 ]; do
        sleep 0.2
        waited=$((waited + 1))
      done
      kill -9 "$old_pid" 2>/dev/null || true
    fi
    rm -f "$ORCA_RELAY_PID_FILE"
  }
  orca_relay_start_wrapper() {
    orca_relay_stop_wrapper
    if command -v setsid >/dev/null 2>&1; then
      nohup setsid "$ORCA_RELAY_WRAPPER" >> "$ORCA_RELAY_LOG" 2>&1 &
    else
      nohup "$ORCA_RELAY_WRAPPER" >> "$ORCA_RELAY_LOG" 2>&1 &
    fi
    ORCA_RELAY_DEADLINE=$((SECONDS + 10))
    while [ ! -s "$ORCA_RELAY_PID_FILE" ] && [ "$SECONDS" -lt "$ORCA_RELAY_DEADLINE" ]; do
      sleep 0.2
    done
    ORCA_RELAY_PID="$(cat "$ORCA_RELAY_PID_FILE" 2>/dev/null || true)"
    # Give an immediately-crashing relay time to die so kill -0 is truthful.
    sleep 1
    if [ -z "$ORCA_RELAY_PID" ] || ! kill -0 "$ORCA_RELAY_PID" 2>/dev/null; then
      rm -f "$ORCA_RELAY_PID_FILE"
      return 1
    fi
    return 0
  }
  orca_relay_restart() {
    orca_relay_start_wrapper
  }
  # U183 R10b: wrapper pid + cmdline identity; set before any start failure so
  # a rollback re-proof reads the same kind.
  ORCA_RELAY_PROOF_KIND=pid
  if ! orca_relay_start_wrapper; then
    echo ">> relay 启动失败（69 / relay_start_failed）：请查看 $ORCA_RELAY_LOG" >&2
    orca_relay_handle_start_failure
  fi
  if ! orca_relay_self_proof; then
    orca_relay_handle_proof_failure
  fi
  orca_relay_prune_releases
  orca_relay_prune_downloads

  cat <<ORCA_NEXT

中继已在后台启动（pid $ORCA_RELAY_PID），日志 $ORCA_RELAY_LOG。
未检测到 systemctl：该进程不随开机自启，主机重启后请重新执行：
   nohup setsid "$ORCA_RELAY_WRAPPER" >> "$ORCA_RELAY_LOG" 2>&1 &
1) 停止：kill "$ORCA_RELAY_PID"
2) 前台调试前先停止上述进程，然后：
   set -a; . "$ORCA_ENV_FILE"; set +a
   $ORCA_NODE_BIN $ORCA_RELAY_ENTRY
3) 启动脚本：$ORCA_RELAY_WRAPPER（已 chmod 700）

说明：RELAY_PUBLIC_HOST 填客户端可达地址（NAT/跨网段必填）；缺省时平台记录注册来源 IP。
ORCA_NEXT
fi
`
}

const ROLE_PERMISSIONS: Record<string, string[]> = {
  'platform:admin': ['platform:admin'],
  'platform:auditor': ['platform:auditor'],
  developer: []
}

/**
 * 用户管理页三角色 → 存储 roles（u67 设计 §7.2）；下拉加新角色 = 加一个键。
 */
const USER_PAGE_ROLES: Record<'developer' | 'auditor' | 'admin', string[]> = {
  developer: ['developer'],
  auditor: ['developer', 'platform:auditor'],
  admin: ['developer', 'platform:admin']
}

/** 存储 roles 的页面角色键；USER_PAGE_ROLES 的逆映射。 */
function userPageRole(roles: string[]): 'developer' | 'auditor' | 'admin' {
  if (roles.includes('platform:admin')) return 'admin'
  if (roles.includes('platform:auditor')) return 'auditor'
  return 'developer'
}

function isAdmin(user: User): boolean {
  return user.roles.includes('platform:admin')
}

/** The credential contract's permission bits; anything else is a dead grant bit. */
const GRANT_PERMISSION_SET = new Set<string>([
  'open',
  'terminal',
  'agent',
  'file:read',
  'file:write',
  'browser',
  'download'
])

/**
 * Groups the platform has seen: the union of logged-in users' LDAP groups and
 * groups already referenced by a grant, sorted and de-duplicated. No LDAP search
 * exists, so this is the whole known set (design A1).
 */
function knownGroups(store: Store): string[] {
  const groups = new Set<string>()
  for (const user of store.users.values()) for (const group of user.groups) groups.add(group)
  for (const grant of store.grants) {
    if (grant.subjectType === 'group') groups.add(grant.subjectId)
  }
  for (const grant of store.hostGrants) {
    if (grant.subjectType === 'group') groups.add(grant.subjectId)
  }
  return [...groups].sort()
}

/** The three host bits; anything else is a dead grant bit (AA2). */
const HOST_PERMISSION_SET = new Set<string>(['provision', 'maintain', 'view'])

type GrantSubjectVerdict =
  | { ok: true; subjectType: 'user'; subjectId: string; username: string }
  | { ok: true; subjectType: 'group'; subjectId: string }
  | { ok: false; code: 'USER_NOT_FOUND' | 'GROUP_NOT_FOUND'; message: string }

/**
 * One resolver for the directory and grant writes: the ACL matches user ids and
 * exact group names, so a typo must be refused instead of stored as a row that
 * reads as granted and never fires.
 */
function resolveGrantSubject(
  store: Store,
  subjectType: 'user' | 'group',
  submitted: string
): GrantSubjectVerdict {
  const subjectId = submitted.trim()
  if (subjectType === 'group') {
    return knownGroups(store).includes(subjectId)
      ? { ok: true, subjectType, subjectId }
      : { ok: false, code: 'GROUP_NOT_FOUND', message: '组不存在或平台未见过该组。' }
  }
  const user = store.users.get(subjectId) ?? store.usersByName.get(subjectId)
  return user
    ? { ok: true, subjectType, subjectId: user.id, username: user.username }
    : { ok: false, code: 'USER_NOT_FOUND', message: '用户不存在。' }
}

/** U66 file events: client-declared download/copy audit (§2.10 of the U66 design). */
const FILE_EVENT_TYPES = new Set(['file_download', 'file_copy', 'download_blocked'])
const FILE_EVENT_RESULTS = new Set(['success', 'failure', 'denied'])
const FILE_EVENT_METADATA_FIELDS = new Set([
  'hostId',
  'hostName',
  'projectKey',
  'method',
  'kind',
  'surface',
  'capturePoint',
  'captureConfidence',
  'copyKind',
  'policy',
  'reason',
  'fileName',
  'path',
  'sizeBytes',
  'copiedChars',
  'copiedBytes',
  'itemCount',
  'sha256',
  'sha256Source',
  'savedName',
  'mime',
  'isBinary',
  'excerpt',
  'excerptBytes',
  'excerptTruncated',
  'occurredAt',
  'clientVersion',
  'truncated'
])
/** Platform-written; a client must not be able to forge its own attribution. */
const FILE_EVENT_PLATFORM_FIELDS = new Set(['deviceId', 'subject', 'actorSource'])
const FILE_EVENT_TOP_FIELDS = new Set([
  'eventType',
  'result',
  'traceId',
  'metadata',
  'deviceId',
  'subject',
  'sessionId',
  'cloudSession',
  'projectId',
  'hostId',
  'hostName'
])
const FILE_EVENT_KINDS = new Set(['file', 'folder', 'artifact', 'browser'])
const FILE_EVENT_SURFACES = new Set(['desktop', 'web', 'mobile', 'admin-embed'])
const FILE_EVENT_COPY_KINDS = new Set(['content-whole', 'content-selection', 'file-object'])
const FILE_EVENT_POLICIES = new Set(['allow', 'deny'])
const DOWNLOAD_METHODS = new Set([
  'files.readChunk',
  'browser.download',
  'files.download',
  'mobile.saveToPhone'
])
const DOWNLOAD_CAPTURE_POINTS = new Set([
  'download-runtime-client',
  'mobile-save',
  'host-browser-download',
  'host-files-download'
])
const COPY_CAPTURE_POINTS = new Set([
  'web-clipboard-api',
  'desktop-clipboard-ipc',
  'dom-copy-listener',
  'mobile-copy-content'
])
const FILE_EVENT_METADATA_LIMIT = 4096
const FILE_EVENT_RATE_LIMIT = 120
const FILE_EVENT_RATE_WINDOW_MS = 60_000
const OCCURRED_AT_TOLERANCE_MS = 60_000

type FileEventVerdict =
  | { ok: true; metadata: Record<string, unknown>; excerptDropped: boolean }
  | { ok: false; field: string; reason: string }

/** Relative, forward-slash project path; absolute paths and `..` are refused (OQ-8). */
function safeFileEventPath(value: string): string | null {
  const normalized = value.replaceAll('\\', '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) return null
  if (normalized.split('/').includes('..')) return null
  return normalized.slice(0, 1024)
}

/**
 * §2.5 field whitelist and enums. Excerpts are refused for the first release
 * (AC-53), so the field is dropped rather than stored; everything else that the
 * dictionary does not know is rejected so a bad report never reaches the chain.
 */
function validateFileEventMetadata(input: {
  eventType: string
  result: string
  metadata: Record<string, unknown>
  project: Project
  hostId: string
  hostName: string
  actor: string
  actorSource: 'device' | 'subject' | 'host'
  subject: string | null
  deviceId: string | null
  now: number
}): FileEventVerdict {
  const raw = input.metadata
  let invalid: { field: string; reason: string } | null = null
  const fail = (field: string, reason: string): void => {
    invalid ??= { field, reason }
  }
  for (const key of Object.keys(raw)) {
    if (FILE_EVENT_METADATA_FIELDS.has(key)) continue
    fail(`metadata.${key}`, FILE_EVENT_PLATFORM_FIELDS.has(key) ? 'platform-written' : 'unknown')
  }

  const text = (field: string, max: number, required = false): string | undefined => {
    const value = raw[field]
    if (value === undefined) {
      if (required) fail(field, 'missing')
      return undefined
    }
    if (typeof value !== 'string' || value.length === 0) {
      fail(field, 'not-a-string')
      return undefined
    }
    return value.slice(0, max)
  }
  const enumText = (field: string, allowed: Set<string>, required = false): string | undefined => {
    const value = text(field, 128, required)
    if (value !== undefined && !allowed.has(value)) fail(field, 'not-allowed')
    return value
  }
  const optionalText = (field: string, max: number): string | undefined => {
    if (raw[field] === undefined) return undefined
    const value = text(field, max)
    if (value !== undefined && /[\\/]/.test(value)) fail(field, 'must-be-basename')
    return value
  }
  const integer = (field: string, required = false): number | undefined => {
    const value = raw[field]
    if (value === undefined) {
      if (required) fail(field, 'missing')
      return undefined
    }
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < 0 ||
      value > Number.MAX_SAFE_INTEGER
    ) {
      fail(field, 'not-a-non-negative-integer')
      return undefined
    }
    return value
  }

  const eventType = input.eventType
  const isDownload = eventType === 'file_download'
  const isCopy = eventType === 'file_copy'
  const isBlocked = eventType === 'download_blocked'

  const kind = enumText('kind', FILE_EVENT_KINDS, isDownload || isBlocked)
  const surface = enumText('surface', FILE_EVENT_SURFACES, true)
  const method = isCopy ? text('method', 128) : text('method', 128, true)
  if (isDownload && method !== undefined && !DOWNLOAD_METHODS.has(method)) {
    fail('method', 'not-allowed')
  }
  const fileName = optionalText('fileName', 255)
  if (fileName === undefined && !(isDownload && kind === 'browser')) fail('fileName', 'missing')
  const pathValue = text('path', 1024, true)
  const path = pathValue === undefined ? undefined : safeFileEventPath(pathValue)
  if (pathValue !== undefined && path === null) fail('path', 'absolute-or-parent-traversal')
  const occurredAt = integer('occurredAt', true)
  if (occurredAt !== undefined && Math.abs(occurredAt - input.now) > OCCURRED_AT_TOLERANCE_MS) {
    fail('occurredAt', 'outside-60s-window')
  }

  const sizeBytes = integer(
    'sizeBytes',
    isDownload && input.result === 'success' && kind !== 'browser'
  )
  const copyKind = enumText('copyKind', FILE_EVENT_COPY_KINDS, isCopy)
  const copiedChars = integer('copiedChars', isCopy)
  const copiedBytes = integer('copiedBytes', isCopy)
  const itemCount = integer('itemCount')
  const policyValue = enumText('policy', FILE_EVENT_POLICIES)
  const reason = text('reason', 128)
  const clientVersion = text('clientVersion', 64)
  const mime = text('mime', 128)
  if (raw.isBinary !== undefined && typeof raw.isBinary !== 'boolean')
    fail('isBinary', 'not-a-boolean')
  if (raw.truncated !== undefined && typeof raw.truncated !== 'boolean') {
    fail('truncated', 'not-a-boolean')
  }

  let sha256: string | undefined
  if (raw.sha256 !== undefined) {
    const value = text('sha256', 64)
    // Invalid fingerprints are dropped, not fatal (§2.5).
    if (value !== undefined && /^[0-9a-f]{64}$/.test(value)) sha256 = value
  }
  const savedName = optionalText('savedName', 255)

  let capturePoint: string | undefined
  if (isBlocked) {
    if (raw.capturePoint !== undefined && raw.capturePoint !== 'frontend-block') {
      fail('capturePoint', 'frontend-block-required')
    }
    capturePoint = 'frontend-block'
  } else if (isCopy) {
    capturePoint = enumText('capturePoint', COPY_CAPTURE_POINTS)
  } else {
    capturePoint = enumText('capturePoint', DOWNLOAD_CAPTURE_POINTS)
  }
  if (raw.captureConfidence !== undefined && raw.captureConfidence !== 'client-declared') {
    fail('captureConfidence', 'client-cannot-self-attest')
  }

  // Excerpts are a second-release switch; the host is authoritative and drops them.
  const excerptDropped =
    raw.excerpt !== undefined ||
    raw.excerptBytes !== undefined ||
    raw.excerptTruncated !== undefined

  if (invalid) return { ok: false, ...invalid }

  const metadata: Record<string, unknown> = {
    hostId: input.hostId,
    hostName: input.hostName,
    projectKey: input.project.key,
    captureConfidence: 'client-declared',
    actorSource: input.actorSource,
    ...(input.subject ? { subject: input.subject } : {}),
    ...(input.deviceId ? { deviceId: input.deviceId } : {}),
    ...(path !== undefined ? { path } : {}),
    surface,
    occurredAt,
    capturePoint:
      capturePoint ??
      (isBlocked
        ? 'frontend-block'
        : isCopy
          ? surface === 'mobile'
            ? 'mobile-copy-content'
            : surface === 'desktop'
              ? 'desktop-clipboard-ipc'
              : 'web-clipboard-api'
          : method === 'mobile.saveToPhone'
            ? 'mobile-save'
            : method === 'browser.download'
              ? 'host-browser-download'
              : 'download-runtime-client')
  }
  if (fileName !== undefined) metadata.fileName = fileName
  if (method !== undefined) metadata.method = method
  if (kind !== undefined) metadata.kind = kind
  if (sizeBytes !== undefined) metadata.sizeBytes = sizeBytes
  if (copyKind !== undefined) metadata.copyKind = copyKind
  if (copiedChars !== undefined) metadata.copiedChars = copiedChars
  if (copiedBytes !== undefined) metadata.copiedBytes = copiedBytes
  if (itemCount !== undefined) metadata.itemCount = itemCount
  if (sha256 !== undefined) {
    metadata.sha256 = sha256
    metadata.sha256Source = 'client'
  }
  if (savedName !== undefined) metadata.savedName = savedName
  if (mime !== undefined) metadata.mime = mime
  if (typeof raw.isBinary === 'boolean') metadata.isBinary = raw.isBinary
  if (typeof raw.truncated === 'boolean') metadata.truncated = raw.truncated
  if (clientVersion !== undefined) metadata.clientVersion = clientVersion
  if (isBlocked) {
    metadata.policy = 'deny'
    metadata.reason = reason ?? 'DOWNLOAD_DISABLED'
  } else {
    if (policyValue !== undefined) metadata.policy = policyValue
    if (reason !== undefined) metadata.reason = reason
    if (isDownload && input.result === 'denied' && reason === undefined) {
      metadata.reason = 'DOWNLOAD_DISABLED'
    }
  }

  // Order: excerpt (already absent) → sha256 → optional fields; then give up.
  if (Buffer.byteLength(JSON.stringify(metadata)) > FILE_EVENT_METADATA_LIMIT) {
    delete metadata.sha256
    delete metadata.sha256Source
    delete metadata.mime
    delete metadata.isBinary
    delete metadata.clientVersion
    delete metadata.savedName
    delete metadata.itemCount
    delete metadata.truncated
  }
  if (Buffer.byteLength(JSON.stringify(metadata)) > FILE_EVENT_METADATA_LIMIT) {
    return { ok: false, field: 'metadata', reason: 'too-large' }
  }
  return { ok: true, metadata, excerptDropped }
}

/**
 * Serializes accepted-export drains per process: a trigger during a pass queues
 * one sequential follow-up, so passes never overlap and no accepted job is
 * dropped. The pass is scheduled so the 202 flushes first; faults are logged only.
 */
export function createAuditExportDrain(
  run: () => Promise<unknown>,
  schedule: (callback: () => void) => unknown = setImmediate
): () => void {
  let inFlight: Promise<unknown> | null = null
  let pending = 0
  const start = (): void => {
    inFlight = new Promise<void>((resolve) => {
      schedule(resolve)
    })
      .then(run)
      .catch((error: unknown) => {
        console.error('[audit-export] worker run failed:', error)
      })
      .finally(() => {
        inFlight = null
        if (pending > 0) {
          pending -= 1
          start()
        }
      })
  }
  return () => {
    if (inFlight) {
      pending += 1
      return
    }
    start()
  }
}

export function createApp(config: ApiConfig): ApiHandle {
  const now = config.now ?? (() => Date.now())
  const accessTtlMs = config.accessTtlMs ?? ACCESS_TTL_MS
  const refreshTtlMs = config.refreshTtlMs ?? REFRESH_TTL_MS
  const refreshGraceMs = parseRefreshGraceMs(
    config.refreshGraceMs ?? process.env.ORCA_CLOUD_REFRESH_GRACE_MS
  )
  const hostOfflineMs =
    config.hostOfflineMs ??
    Number(process.env.ORCA_CLOUD_HOST_OFFLINE_MS ?? HOST_OFFLINE_DEFAULT_MS)
  const handoffTtlMs = config.handoffTtlMs ?? HANDOFF_TTL_MS
  const installDownloadTtlMs = config.installDownloadTtlMs ?? INSTALL_DOWNLOAD_TTL_MS
  const relayBundleDir =
    config.relayBundleDir ?? process.env.ORCA_RELAY_BUNDLE_DIR ?? DEFAULT_RELAY_BUNDLE_DIR
  // U183 R2: an explicit sha wins; without one the legacy script stays bundle-free.
  const configuredRelayBundleSha = (
    config.relayBundleSha ??
    process.env.ORCA_RELAY_BUNDLE_SHA ??
    ''
  ).trim()
  const expiresInSeconds = Math.ceil(accessTtlMs / 1000)
  const refreshCookieConfig = resolveRefreshCookieConfig({
    mode: config.cookieMode ?? process.env.ORCA_CLOUD_COOKIE_MODE,
    publicOrigin: config.publicOrigin ?? process.env.ORCA_CLOUD_PUBLIC_ORIGIN,
    refreshTtlMs
  })

  /** S1: enabled means the operator configured a usable origin (`never` is inert). */
  function refreshCookieEnabled(): boolean {
    return refreshCookieConfig.mode !== 'never'
  }

  /**
   * S1 issues the Cookie only for the platform's own origin. Judged from Origin
   * against ORCA_CLOUD_PUBLIC_ORIGIN — never requestOrigin(), whose XFP is forgeable.
   */
  function issuesRefreshCookie(req: IncomingMessage): boolean {
    return (
      refreshCookieEnabled() && sameOrigin(req.headers.origin, refreshCookieConfig.publicOrigin)
    )
  }

  /** A duplicate or indistinguishable orca_refresh is a hard 401, never a fallback. */
  function hasAmbiguousRefreshCookie(req: IncomingMessage): boolean {
    return refreshCookieEnabled() && parseRefreshCookie(req.headers.cookie).kind === 'duplicate'
  }

  /**
   * U218 §2B-9: a non-browser caller that replays a Cookie without an Origin is
   * refused rather than parsed as a Cookie source.
   */
  function carriesRefreshCookieWithoutOrigin(req: IncomingMessage): boolean {
    return (
      refreshCookieEnabled() &&
      req.headers.origin === undefined &&
      parseRefreshCookie(req.headers.cookie).kind !== 'absent'
    )
  }

  /**
   * U218 §2B-9: with a configured platform origin, a browser login from any
   * other Origin is refused instead of degrading to a readable body refresh.
   * Handoff is exempt: host cross-origin pages legitimately trade a code.
   */
  function rejectsForeignLoginOrigin(req: IncomingMessage): boolean {
    return (
      refreshCookieEnabled() &&
      req.headers.origin !== undefined &&
      !sameOrigin(req.headers.origin, refreshCookieConfig.publicOrigin)
    )
  }

  /**
   * U197 S2: CSRF applies only to Cookie-authenticated requests. The trusted
   * origin is the configured one — never a request-header-derived origin.
   */
  function passesCookieCsrf(req: IncomingMessage): boolean {
    if (!sameOrigin(req.headers.origin, refreshCookieConfig.publicOrigin)) return false
    const header = req.headers['content-type']
    const raw = Array.isArray(header) ? header[0] : header
    if (raw === undefined) return false
    return raw.split(';')[0]?.trim().toLowerCase() === 'application/json'
  }

  function setRefreshCookie(res: ServerResponse, value: string): void {
    res.setHeader('cache-control', 'no-store')
    res.setHeader(
      'set-cookie',
      serializeRefreshCookie({
        value,
        secure: refreshCookieConfig.secure,
        maxAgeSeconds: refreshCookieConfig.maxAgeSeconds
      })
    )
  }

  /** Same attributes as the issue path, or the browser keeps the old Cookie. */
  function clearRefreshCookie(res: ServerResponse): void {
    res.setHeader('cache-control', 'no-store')
    res.setHeader(
      'set-cookie',
      serializeRefreshCookieClear({
        secure: refreshCookieConfig.secure,
        // Cookie Domain never carries a port; the issue path omits Domain, so
        // both scopes are cleared for a browser that holds both.
        domain: refreshCookieConfig.publicOrigin
          ? new URL(refreshCookieConfig.publicOrigin).hostname
          : null
      })
    )
  }

  const auditLogPath = config.auditLogPath ?? process.env.AUDIT_LOG_PATH ?? null
  const store = new Store()
  // U131: dev-store snapshots are opt-in; without the env var the store stays in memory.
  const storeFile = (process.env.ORCA_PLATFORM_STORE_FILE ?? '').trim()
  const storePersistence = storeFile ? attachStorePersistence(store, { file: storeFile }) : null
  if (storePersistence) {
    // U268: a restored snapshot may hold non-string entries; readers scan this
    // array and would throw on the first one.
    for (const host of store.hosts.values()) {
      host.directAddrs = stringDirectAddrs(host.directAddrs)
    }
  }
  // U202 E9: one export store per process; startup prune plus unref'd periodic sweep.
  const auditExportStore = createAuditExportStore(process.env, {
    dir: config.auditExportDir,
    ttlMs: config.auditExportTtlMs,
    perUserActiveLimit: config.auditExportPerUserLimit,
    globalActiveLimit: config.auditExportGlobalLimit,
    now
  })
  const auditExportCleanup = startAuditExportCleanup({ store: auditExportStore })
  const auditExportTokenTtlMs =
    config.auditExportTokenTtlMs ?? resolveAuditExportTokenTtlMs(process.env)
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
  // trim 防「空白 env 意外开启」准入（§3.4）。
  const ldapRequiredGroup =
    (config.ldapRequiredGroup ?? process.env.ORCA_CLOUD_LDAP_REQUIRED_GROUP ?? '').trim() || null
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

  // U205 F3: the worker awaits each page, so the in-process chain (sync) and a
  // remote writer (`auditWriterUrls`, promise-returning) both drive exports.
  const auditExportWorker = new AuditExportWorker({
    store: auditExportStore,
    query: (filter) => audit.query(filter),
    now,
    // Terminal events are best-effort (the worker never awaits them); the
    // adapter fills the nullable fields `AuditSink.append` requires.
    audit: {
      append: async (event) => {
        await audit.append({
          eventType: event.eventType,
          actor: event.actor ?? null,
          targetType: event.targetType,
          targetId: event.targetId,
          result: event.result,
          traceId: event.traceId ?? null,
          metadata: event.metadata
        })
      }
    }
  })
  /**
   * One pass per accepted job, after the 202 is written. The drain gate keeps a
   * single pass in flight per process; `markRunning` stays the ownership claim.
   */
  const scheduleAuditExportRun = createAuditExportDrain(() =>
    auditExportWorker.processQueuedAuditExports(1)
  )
  // U206 F17: another replica (or a lost trigger) can leave a job queued, so a
  // low-frequency tick rescues it without waiting on a POST.
  const auditExportSweep = startAuditExportSweep({
    store: auditExportStore,
    trigger: scheduleAuditExportRun,
    intervalMs: config.auditExportSweepMs ?? resolveAuditExportSweepIntervalMs(process.env)
  })
  // U209: acceptance reserves synchronously, then releases in `finally`, so
  // concurrent POSTs cannot all pass the same on-disk quota snapshot. Pending
  // slots live only in this process (multiple replicas still rely on D1).
  const auditExportPendingByUser = new Map<string, number>()
  let auditExportPendingGlobal = 0
  function reserveAuditExportSlot(
    userId: string
  ): { ok: true; release: () => void } | { ok: false; reason: 'per-user' | 'global' } {
    const pendingForUser = auditExportPendingByUser.get(userId) ?? 0
    if (
      auditExportStore.countActive(userId) + pendingForUser >=
      auditExportStore.perUserActiveLimit
    ) {
      return { ok: false, reason: 'per-user' }
    }
    if (
      auditExportStore.countActive() + auditExportPendingGlobal >=
      auditExportStore.globalActiveLimit
    ) {
      return { ok: false, reason: 'global' }
    }
    auditExportPendingByUser.set(userId, pendingForUser + 1)
    auditExportPendingGlobal += 1
    let released = false
    return {
      ok: true,
      release: () => {
        if (released) {
          return
        }
        released = true
        const remaining = (auditExportPendingByUser.get(userId) ?? 1) - 1
        if (remaining > 0) {
          auditExportPendingByUser.set(userId, remaining)
        } else {
          auditExportPendingByUser.delete(userId)
        }
        auditExportPendingGlobal -= 1
      }
    }
  }

  /**
   * U115: the copied install command runs without a session, so the wizard mints
   * this short-lived credential. Stored hashed; the plaintext lives only in the
   * command the admin copies.
   */
  function issueInstallDownloadToken(
    user: User,
    kind: InstallDownloadToken['kind'],
    hostId: string | null
  ): { downloadToken: string; downloadExpiresIn: number } {
    const downloadToken = randomBytes(24).toString('base64url')
    store.installDownloadTokens = store.installDownloadTokens.filter((t) => t.expiresAt > now())
    store.installDownloadTokens.push({
      tokenHash: hashToken(downloadToken),
      userId: user.id,
      kind,
      hostId,
      expiresAt: now() + installDownloadTtlMs,
      usedAt: null
    })
    return { downloadToken, downloadExpiresIn: Math.ceil(installDownloadTtlMs / 1000) }
  }

  /**
   * Peek without consuming: the request still has to pass the script's own input
   * checks, and the token is burned only when a 200 is about to be written.
   */
  function findInstallDownloadToken(
    downloadToken: string,
    kind: InstallDownloadToken['kind'],
    hostId: string | null
  ): { entry: InstallDownloadToken; user: User } | null {
    const hash = hashToken(downloadToken)
    const entry = store.installDownloadTokens.find((t) => safeEqual(t.tokenHash, hash))
    if (!entry || entry.usedAt || entry.expiresAt < now()) return null
    if (entry.kind !== kind) return null
    // A bound token may only fetch that host's script, not any host's.
    if (entry.hostId !== null && entry.hostId !== hostId) return null
    const user = store.users.get(entry.userId)
    return user ? { entry, user } : null
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
      /** U62 G4: endpoint-specific fields (hostId, refused subject) for the denied event. */
      metadata?: Record<string, unknown>
    }
  ): void {
    audit.appendBestEffort({
      eventType: input.eventType,
      actor: user.username,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      result: 'denied',
      traceId,
      metadata: {
        reason: 'PERMISSION_DENIED',
        requiredPermission: input.permission,
        ...input.metadata
      }
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
   * U62 G4: a refused grant write still names the subject it refused. The body
   * was never trusted (the caller had no say), so every field is best effort.
   */
  function deniedGrantMetadata(
    body: Record<string, unknown>,
    hostId?: string
  ): Record<string, unknown> {
    const subject = {
      subjectType: typeof body.subjectType === 'string' ? body.subjectType : 'user',
      subjectId: typeof body.subjectId === 'string' ? body.subjectId : '',
      permissions: Array.isArray(body.permissions)
        ? body.permissions.filter((p): p is string => typeof p === 'string')
        : []
    }
    return hostId === undefined ? subject : { hostId, ...subject }
  }

  /** Denied writes never mutate, so the row diff is informational and nothing is revoked. */
  function deniedHostGrantRevocationFields(
    body: Record<string, unknown>,
    hostId: string
  ): { removedPermissions: HostPermission[]; revokedUsers: number } {
    const subjectType = body.subjectType === 'group' ? 'group' : 'user'
    const subjectId = typeof body.subjectId === 'string' ? body.subjectId.trim() : ''
    const next = Array.isArray(body.permissions)
      ? body.permissions.filter(
          (permission): permission is string => typeof permission === 'string'
        )
      : []
    // The stored row is keyed by the resolved user id, not the submitted username.
    const resolved = resolveGrantSubject(store, subjectType, subjectId)
    const previous = resolved.ok
      ? store.hostGrants.find(
          (g) =>
            g.hostId === hostId &&
            g.subjectType === resolved.subjectType &&
            g.subjectId === resolved.subjectId
        )
      : undefined
    return {
      removedPermissions: (previous?.permissions ?? []).filter(
        (permission) => !next.includes(permission)
      ),
      revokedUsers: 0
    }
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
   * U136④a: the expected-version check and its write must not interleave with
   * another policy write across the (possibly remote) audit await, or both
   * stale callers would pass the check and mint the same version.
   */
  let policyWriteQueue: Promise<void> = Promise.resolve()
  async function withPolicyWriteLock(work: () => Promise<void>): Promise<void> {
    const previous = policyWriteQueue
    let release!: () => void
    policyWriteQueue = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      await work()
    } finally {
      release()
    }
  }

  const fileEventRate = new Map<string, { windowStart: number; count: number }>()
  const fileEventGap = {
    dropped: 0,
    rateLimited: 0,
    suppressed: 0,
    lastGapAt: null as number | null
  }
  const noteFileEventGap = (key: 'dropped' | 'rateLimited' | 'suppressed'): void => {
    fileEventGap[key] += 1
    fileEventGap.lastGapAt = now()
  }

  // §2.10.4: the heartbeat's auditGap becomes a `host.audit_gap` chain event the
  // status endpoint's gap summary reads. Aggregated per agent as deltas, so a
  // host that reports the same counters every 10s beat does not flood the chain;
  // a restart (new bootId) with undelivered pending counts once as dropped.
  const hostGapBaseline = new Map<
    string,
    { bootId: string; pending: number; dropped: number; suppressed: number; rateLimited: number }
  >()
  const noteHostAuditGap = (
    host: { id: string; name: string },
    gap: HostAuditGap,
    traceId: string
  ): void => {
    const previous = hostGapBaseline.get(host.id)
    const lostPending =
      previous !== undefined && previous.bootId !== gap.bootId ? previous.pending : 0
    const delta = (key: 'dropped' | 'suppressed' | 'rateLimited'): number =>
      previous !== undefined && previous.bootId === gap.bootId
        ? Math.max(0, gap[key] - previous[key])
        : gap[key]
    hostGapBaseline.set(host.id, { ...gap })
    const deltas = {
      dropped: delta('dropped'),
      suppressed: delta('suppressed'),
      rateLimited: delta('rateLimited')
    }
    if (
      lostPending <= 0 &&
      deltas.dropped <= 0 &&
      deltas.suppressed <= 0 &&
      deltas.rateLimited <= 0
    ) {
      return
    }
    audit.appendBestEffort({
      eventType: 'host.audit_gap',
      actor: `host:${host.name}`,
      targetType: 'host',
      targetId: host.id,
      result: 'success',
      traceId,
      metadata: {
        hostId: host.id,
        hostName: host.name,
        bootId: gap.bootId,
        pending: gap.pending,
        dropped: deltas.dropped + lostPending,
        suppressed: deltas.suppressed,
        rateLimited: deltas.rateLimited
      }
    })
  }

  /** §2.1 device-tier attribution: the platform's own device → user tables. */
  const resolveHostAuditActor: HostAuditActorResolver = (deviceId) => {
    const device = store.devices.get(deviceId)
    if (!device) return null
    const user = store.users.get(device.userId)
    return user ? { username: user.username } : null
  }

  type FileEventOutcome = { status: number; body: Record<string, unknown>; retryAfter?: boolean }

  /** Finds the download-family event a same-trace report must merge into (N-4). */
  async function findFileEventByTrace(
    traceId: string,
    deviceId: string | null
  ): Promise<AuditEvent | null> {
    const page = await audit.query({ traceId, limit: 200 })
    return (
      page.events.find((event) => {
        if (event.eventType !== 'file_download' && event.eventType !== 'download_blocked') {
          return false
        }
        return deviceId === null || event.metadata?.deviceId === deviceId
      }) ?? null
    )
  }

  /**
   * §2.10 `audit.recordFileEvent`. The host RPC validates and queues; this is the
   * same contract's authenticated ingress, appending straight to the chain.
   * Best effort: a bad report or an unwritable chain answers without throwing.
   */
  async function recordFileEvent(
    body: Record<string, unknown>,
    requestTraceId: string
  ): Promise<FileEventOutcome> {
    const reject = (field: string, reason: string): FileEventOutcome => ({
      status: 400,
      body: {
        error: {
          code: 'INVALID_FILE_EVENT',
          message: '文件审计事件字段不合法。',
          traceId: requestTraceId,
          details: { field, reason }
        }
      }
    })
    for (const key of Object.keys(body)) {
      if (!FILE_EVENT_TOP_FIELDS.has(key)) return reject(key, 'unknown')
    }
    const eventType = typeof body.eventType === 'string' ? body.eventType : ''
    if (!FILE_EVENT_TYPES.has(eventType)) return reject('eventType', 'not-allowed')
    const resultValue = typeof body.result === 'string' ? body.result : ''
    if (!FILE_EVENT_RESULTS.has(resultValue)) return reject('result', 'not-allowed')
    const result: 'success' | 'failure' | 'denied' =
      resultValue === 'success' ? 'success' : resultValue === 'failure' ? 'failure' : 'denied'
    if (eventType === 'download_blocked' && result !== 'denied') {
      return reject('result', 'download-blocked-must-be-denied')
    }

    const cloudSession =
      typeof body.cloudSession === 'string' && body.cloudSession.length > 0
        ? body.cloudSession
        : typeof body.sessionId === 'string'
          ? body.sessionId
          : ''
    if (!cloudSession) {
      return { status: 200, body: { queued: false, reason: 'non-cloud-session' } }
    }

    const current = now()
    const previous = fileEventRate.get(cloudSession)
    const window =
      previous && current - previous.windowStart < FILE_EVENT_RATE_WINDOW_MS
        ? previous
        : { windowStart: current, count: 0 }
    if (window.count >= FILE_EVENT_RATE_LIMIT) {
      noteFileEventGap('rateLimited')
      return {
        status: 429,
        retryAfter: true,
        body: {
          queued: false,
          reason: 'rate-limited',
          auditGap: { rateLimited: fileEventGap.rateLimited }
        }
      }
    }
    window.count += 1
    fileEventRate.set(cloudSession, window)

    const metadataInput = body.metadata
    if (
      metadataInput !== undefined &&
      (typeof metadataInput !== 'object' || metadataInput === null || Array.isArray(metadataInput))
    ) {
      return reject('metadata', 'not-an-object')
    }
    const metadata: Record<string, unknown> = {}
    if (metadataInput !== undefined) {
      for (const [key, value] of Object.entries(metadataInput)) metadata[key] = value
    }
    const projectId = typeof body.projectId === 'string' ? body.projectId : ''
    if (!projectId) return reject('projectId', 'missing')
    const project = store.projects.get(projectId)
    if (!project) return reject('projectId', 'unknown')

    const deviceId =
      typeof body.deviceId === 'string' && body.deviceId.length > 0 ? body.deviceId : null
    const subjectInput =
      typeof body.subject === 'string' && body.subject.length > 0
        ? body.subject.slice(0, 128)
        : null
    const suppliedHostId =
      typeof body.hostId === 'string' && body.hostId.length > 0 ? body.hostId : null
    if (suppliedHostId && suppliedHostId !== project.hostId) {
      return reject('hostId', 'project-host-mismatch')
    }
    const hostId = project.hostId
    const hostName =
      store.hosts.get(hostId)?.name ??
      (typeof body.hostName === 'string' ? body.hostName.slice(0, 128) : 'unknown')

    const device = deviceId ? store.devices.get(deviceId) : undefined
    const deviceUser = device ? store.users.get(device.userId) : undefined
    let actor: string
    let actorSource: 'device' | 'subject' | 'host'
    if (deviceUser) {
      actor = deviceUser.username
      actorSource = 'device'
    } else if (subjectInput && /^user:/i.test(subjectInput)) {
      actor = subjectInput.slice(5)
      actorSource = 'subject'
    } else {
      actor = `host:${hostName}`
      actorSource = 'host'
    }
    const subject = subjectInput ?? (actorSource === 'device' ? `user:${actor}` : null)
    const traceId =
      typeof body.traceId === 'string' && body.traceId.length > 0
        ? body.traceId.slice(0, 128)
        : requestTraceId

    // One download action, one event: a same-trace report never adds a second (N-4).
    if ((eventType === 'file_download' || eventType === 'download_blocked') && traceId) {
      const prior = await findFileEventByTrace(traceId, deviceId)
      if (prior) {
        if (eventType === 'file_download' && metadata.savedName !== undefined) {
          return { status: 200, body: { queued: true, acceptedSeq: prior.seq, merged: true } }
        }
        noteFileEventGap('dropped')
        return {
          status: 200,
          body: { queued: false, reason: 'duplicate', matchedSeq: prior.seq }
        }
      }
      // A supplement with no matching event is merged/dropped, never a download.
      if (
        eventType === 'file_download' &&
        metadata.savedName !== undefined &&
        metadata.method === undefined &&
        metadata.path === undefined
      ) {
        noteFileEventGap('dropped')
        return { status: 200, body: { queued: false, reason: 'unmatched-saved-name' } }
      }
    }

    const verdict = validateFileEventMetadata({
      eventType,
      result,
      metadata,
      project,
      hostId,
      hostName,
      actor,
      actorSource,
      subject,
      deviceId,
      now: current
    })
    if (!verdict.ok) return reject(verdict.field, verdict.reason)

    try {
      const event = await audit.append({
        eventType,
        actor,
        targetType: 'project',
        targetId: project.id,
        result,
        traceId,
        metadata: verdict.metadata
      })
      return {
        status: 200,
        body: {
          queued: true,
          acceptedSeq: event.seq,
          ...(verdict.excerptDropped ? { reason: 'excerpt-not-allowed', excerptDropped: true } : {})
        }
      }
    } catch {
      noteFileEventGap('dropped')
      return { status: 200, body: { queued: false, reason: 'audit-unavailable' } }
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
  const ldap =
    config.ldap ??
    new MockLdapAdapter(
      accounts,
      ldapRequiredGroup ? { requiredGroup: ldapRequiredGroup } : undefined
    )

  // Seed: admin, developer, host, project, grants. A restored snapshot already
  // holds these; re-seeding would mint new user ids that grants no longer match.
  const admin =
    store.usersByName.get('admin') ??
    store.seedUser({
      username: 'admin',
      displayName: '李静',
      dept: '平台工程部',
      email: 'admin@example.com',
      groups: ['platform-admins'],
      roles: ['platform:admin', 'developer'],
      status: 'active'
    })
  const dev =
    store.usersByName.get('zhangsan') ??
    store.seedUser({
      username: 'zhangsan',
      displayName: '张伟',
      dept: '支付研发部',
      email: 'zhangsan@example.com',
      groups: ['developers', 'team-payment'],
      roles: ['developer'],
      status: 'active'
    })
  const host: Host =
    store.hosts.get('host_dev001') ??
    ({
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
    } satisfies Host)
  if (!store.hosts.has(host.id)) {
    store.hosts.set(host.id, host)
    store.hostsByName.set(host.name, host)
  }

  const project: Project =
    store.projects.get('proj_payment') ??
    ({
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
    } satisfies Project)
  if (!store.projects.has(project.id)) {
    store.projects.set(project.id, project)
    store.projectsByKey.set(project.key, project)
  }
  const seededGrant: Grant = {
    projectId: project.id,
    subjectType: 'group',
    subjectId: 'team-payment',
    permissions: ['open', 'terminal', 'agent', 'file:read', 'file:write']
  }
  if (
    !store.grants.some(
      (grant) =>
        grant.projectId === seededGrant.projectId &&
        grant.subjectType === seededGrant.subjectType &&
        grant.subjectId === seededGrant.subjectId
    )
  ) {
    store.grants.push(seededGrant)
  }
  if (host.revokedAt === null && !store.relayRoutes.has('dev-001')) {
    store.relayRoutes.set('dev-001', {
      routeKey: 'dev-001',
      hostId: host.id,
      target: '127.0.0.1:16768',
      version: 1,
      updatedAt: now()
    })
  }
  // U140: a restored snapshot can still carry the route the revoke path deleted,
  // and the seed above must not revive it — revoked hosts own no relay route.
  for (const [key, relayRoute] of store.relayRoutes) {
    const routeHost = store.hosts.get(relayRoute.hostId)
    if (!routeHost || routeHost.revokedAt !== null) store.relayRoutes.delete(key)
  }

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
    const session: Session = {
      id: `sess_${randomUUID()}`,
      userId: user.id,
      deviceId,
      epoch: 1,
      refreshHash: hashToken(refreshToken),
      refreshExpiresAt: now() + refreshTtlMs,
      currentRefreshToken: refreshToken,
      revokedAt: null
    }
    store.sessions.set(session.id, session)
    store.accessTokens.set(accessToken, {
      sessionId: session.id,
      userId: user.id,
      epoch: session.epoch,
      expiresAt: now() + accessTtlMs
    })
    store.refreshTokens.set(hashToken(refreshToken), session.id)
    return { accessToken, refreshToken }
  }

  function issueAccessToken(session: Session): string {
    const accessToken = randomBytes(32).toString('base64url')
    store.accessTokens.set(accessToken, {
      sessionId: session.id,
      userId: session.userId,
      epoch: session.epoch,
      expiresAt: now() + accessTtlMs
    })
    return accessToken
  }

  /**
   * Cookie-source refresh re-sends the same value (v5 §2B-2). The token map
   * stores digests only (U233), so a restored session falls back to the value
   * the caller already verified against `refreshHash`.
   */
  function currentRefreshTokenOf(session: Session, presented: string): string | null {
    if (
      session.currentRefreshToken !== undefined &&
      safeEqual(session.refreshHash, hashToken(session.currentRefreshToken))
    ) {
      return session.currentRefreshToken
    }
    return safeEqual(session.refreshHash, hashToken(presented)) ? presented : null
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
   * U241 ②: every revocation kills already-issued access tokens exactly once.
   * A session revoked elsewhere (logout, disabled refresh, reuse) keeps its epoch.
   */
  function revokeSessionOnce(session: Session): boolean {
    if (session.revokedAt !== null) return false
    session.revokedAt = now()
    bumpEpoch(session.id)
    return true
  }

  /**
   * U230②: a disabled session is revoked and audited at most once. The re-check
   * after the barrier keeps concurrent refreshes from double-bumping the epoch.
   */
  async function revokeDisabledSession(
    session: Session,
    user: User | undefined,
    source: 'cookie' | 'body',
    traceId: string
  ): Promise<void> {
    await config.beforeDisabledSessionRevoke?.()
    if (!revokeSessionOnce(session)) return
    audit.appendBestEffort({
      eventType: 'logout',
      actor: user?.username ?? null,
      targetType: 'session',
      targetId: session.id,
      result: 'denied',
      traceId,
      metadata: { reason: 'USER_DISABLED', source }
    })
  }

  /**
   * U244: two admin force-offline requests for one user may race. Serialising
   * audit+revoke makes the epoch bump and its audit event happen exactly once;
   * the follower then sees zero live sessions and reports 0. A follower only
   * defers to the leader when that leader actually succeeded — a failed audit
   * left the work undone, so it retries as the next leader.
   */
  type UserSessionRevokeQueueEntry = { tail: Promise<void>; outcome?: { ok: boolean } }
  const userSessionRevokeQueues = new Map<string, UserSessionRevokeQueueEntry>()
  /** The leader's audit write already answered 503; the lock must not record success. */
  const USER_SESSION_REVOKE_AUDIT_FAILED = Symbol('user-session-revoke-audit-failed')

  async function withUserSessionRevokeLock<T>(
    userId: string,
    action: (follower: boolean) => Promise<T>
  ): Promise<T> {
    const queued = userSessionRevokeQueues.get(userId)
    const previous = queued?.tail ?? Promise.resolve()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const entry: UserSessionRevokeQueueEntry = { tail: previous.then(() => gate) }
    userSessionRevokeQueues.set(userId, entry)
    await previous
    const follower = queued?.outcome?.ok === true
    try {
      const value = await action(follower)
      entry.outcome = { ok: true }
      return value
    } catch (failure) {
      entry.outcome = { ok: false }
      throw failure
    } finally {
      release()
      if (userSessionRevokeQueues.get(userId) === entry) {
        userSessionRevokeQueues.delete(userId)
      }
    }
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
    const addOrigin = (value: string): void => {
      try {
        origins.add(new URL(value).origin)
      } catch {
        // A form the URL parser refuses cannot be a browser page origin.
      }
    }
    for (const host of store.hosts.values()) {
      for (const addr of host.directAddrs) {
        if (isDirectAddrForm(addr)) addOrigin(`https://${addr}`)
      }
    }
    for (const node of relayNodes.all()) {
      if (node.browserHost !== '') addOrigin(`https://${node.browserHost}`)
    }
    return origins
  }

  /**
   * The request's Origin when it is one of those page origins, else null. Exact
   * match, never a wildcard: a bearer token rides the Authorization header,
   * which CORS does not protect — this only decides who may read the reply.
   * U265: both sides are URL-normalized, so a host stored as `Example.COM:443`
   * matches the `https://example.com` a browser serializes.
   */
  function corsAllowOriginFor(req: IncomingMessage): string | null {
    const raw = req.headers.origin?.toString().trim() ?? ''
    if (raw === '') return null
    let origin: string
    try {
      origin = new URL(raw).origin
    } catch {
      return null
    }
    return browserPageOrigins().has(origin) ? origin : null
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
    try {
      const page = new URL(`https://${addr}/cloud-admin.html`)
      page.searchParams.set('api', platformOrigin)
      return page.toString()
    } catch {
      // U265: a restored snapshot may pre-date the parse check; an unviewable
      // page is better than an uncaught 500 on every project listing.
      return ''
    }
  }

  /** Credentials in a clone URL are host-only; readers get the address without them. */
  function redactRepoCredentials(repoUrl: string): string {
    try {
      const url = new URL(repoUrl)
      if (!url.username && !url.password) return repoUrl
      url.username = ''
      url.password = ''
      return url.toString()
    } catch {
      return repoUrl
    }
  }

  function projectView(p: Project, user: User, platformOrigin: string): Record<string, unknown> {
    const adminAccess = isAdmin(user) || user.roles.includes('platform:auditor')
    // U65/U67: the ticket view carries the synthesized bits (host grant as
    // source, read-only as ceiling); `hostAccess` explains a cap, additively.
    const permissions = effectiveProjectPermissions(store, p, user, isAdmin(user))
    const host = store.hosts.get(p.hostId)
    const hostAccess = isAdmin(user) ? null : hostAccessLevel(store, p.hostId, user)
    return {
      id: p.id,
      key: p.key,
      name: p.name,
      repoUrl: isAdmin(user) ? p.repoUrl : redactRepoCredentials(p.repoUrl),
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
      ...(adminAccess ? { createdBy: p.createdBy ?? null } : {}),
      ...(hostAccess ? { hostAccess } : {}),
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
    if (!effectiveProjectPermissions(store, p, user, isAdmin(user)).includes('open')) return null
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
   * Returns a rejection code, or null when accepted. A change of root is refused
   * while the host still owns non-archived projects: their recorded paths — and
   * every ticket minted from them — point at the old root, so silently moving it
   * presents each project as not-prepared with nothing to explain why. Rewriting
   * those paths across roots is a guess about an operator's intent, so refusing
   * and saying so is the safe minimal semantics.
   */
  function applyProjectsRoot(
    target: Host,
    value: unknown,
    traceId: string
  ): 'PROJECTS_ROOT_INVALID' | 'PROJECTS_ROOT_CONFLICT' | null {
    if (value === undefined) {
      return null
    }
    if (value === '' || value === null) {
      return commitProjectsRoot(target, null, traceId) ? null : 'PROJECTS_ROOT_CONFLICT'
    }
    const verdict = validateProjectPath(value)
    // U256: an over-long root would derive paths the create contract refuses, and
    // would break the register body budget that 64 KiB was sized for.
    if (!verdict.ok || verdict.path.length > PROJECT_PATH_MAX_CHARS) {
      audit.appendBestEffort({
        eventType: 'host_projects_root_rejected',
        actor: 'agent',
        targetType: 'host',
        targetId: target.id,
        result: 'failure',
        traceId,
        metadata: { reason: verdict.ok ? 'PROJECT_PATH_INVALID' : verdict.code }
      })
      return 'PROJECTS_ROOT_INVALID'
    }
    return commitProjectsRoot(target, verdict.path, traceId) ? null : 'PROJECTS_ROOT_CONFLICT'
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
        version: store.policies.version,
        updatedAt: now()
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
    // Derived `ip-` keys are syncHostRoute's: it carries an explicit upstream
    // across a label move, and this correction must not undo that (U39/M114a).
    if (target.relayRoute.startsWith('ip-')) return
    const current = store.relayRoutes.get(target.relayRoute)
    if (current) {
      // U64: a restarted host reports its new listen port on the next beat, so
      // following it closes the window where the relay keeps dialing the dead
      // port. Why the beat outranks registration's explicit relayTarget: that
      // target is the host's enrolment-time snapshot, while a changed
      // directAddrs proves the host has moved since. Same address ⇒ no write.
      if (current.target === routeTarget) return
      current.target = routeTarget
      current.version = store.policies.version
      current.updatedAt = now()
      return
    }
    store.relayRoutes.set(target.relayRoute, {
      routeKey: target.relayRoute,
      hostId: target.id,
      target: routeTarget,
      version: store.policies.version,
      updatedAt: now()
    })
  }

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    fromInternalChannel = false
  ): Promise<void> {
    // U258/U264: `json` needs the request to decide whether an unread body must
    // close; the wrapper covers every exit that writes its head directly.
    requestByResponse.set(res, req)
    installUnreadBodyPolicy(res, req)
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

    // ---- U183 R2: relay bundles are public and content-addressed ----
    // Registered before the /install/* admin gate: the tarball holds no secret,
    // and the admin-issued script pins the sha it must receive.
    if (req.method === 'GET' && path.startsWith('/install/relay-bundle/')) {
      const route = RELAY_BUNDLE_ROUTE_PATTERN.exec(path)
      if (!route) return error(res, 404, 'NOT_FOUND', '接口不存在。', traceId)
      const [, sha, extension] = route
      if (!RELAY_BUNDLE_SHA_PATTERN.test(sha)) {
        return error(res, 400, 'RELAY_BUNDLE_SHA_INVALID', 'bundle sha 非法。', traceId)
      }
      const dir = await stat(relayBundleDir).catch(() => null)
      if (!dir?.isDirectory()) {
        return error(res, 503, 'RELAY_BUNDLE_UNAVAILABLE', 'relay bundle 目录未配置。', traceId)
      }
      const body = await readFile(join(relayBundleDir, `relay-bundle-${sha}.${extension}`)).catch(
        () => null
      )
      if (!body) return error(res, 404, 'RELAY_BUNDLE_NOT_FOUND', 'bundle 不存在。', traceId)
      res.writeHead(200, {
        'content-type':
          extension === 'tgz' ? 'application/gzip' : 'application/json; charset=utf-8',
        'content-length': body.byteLength,
        // Task contract: bundle responses are never cached, even though the name is content-addressed.
        'cache-control': 'no-store'
      })
      res.end(body)
      return
    }

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
      return serveStatic(path, req, res)
    }

    // ---- auth ----
    if (req.method === 'POST' && path === '/v1/auth/login') {
      if (hasAmbiguousRefreshCookie(req)) {
        clearRefreshCookie(res)
        res.setHeader('cache-control', 'no-store')
        return error(res, 401, 'SESSION_EXPIRED', '会话状态异常，请清除 Cookie 后重试。', traceId)
      }
      // U218 §2B-9: a Cookie without Origin is not a browser login, and a
      // foreign Origin must never degrade to a readable body refresh.
      if (carriesRefreshCookieWithoutOrigin(req)) {
        // U233 F2: an unparseable/stale Cookie must be cleared, or the jar keeps
        // replaying it and every login stays 401.
        clearRefreshCookie(res)
        res.setHeader('cache-control', 'no-store')
        return error(res, 401, 'SESSION_EXPIRED', '会话状态异常，请清除 Cookie 后重试。', traceId)
      }
      if (rejectsForeignLoginOrigin(req)) {
        res.setHeader('cache-control', 'no-store')
        return error(res, 403, 'CSRF_REJECTED', '请求来源不受信任。', traceId)
      }
      const loginBody = await readBody(req, AUTH_BODY_MAX_BYTES)
      if (loginBody.oversized) {
        res.setHeader('cache-control', 'no-store')
        return rejectOversizedBody(res, traceId)
      }
      const body = loginBody.body
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
      // 两条准入拒绝路径同一审计/错误码/文案（§3.2）。
      const refuseNotAdmitted = () => {
        audit.appendBestEffort({
          eventType: 'login',
          actor: username,
          targetType: 'session',
          targetId: null,
          result: 'failure',
          traceId,
          metadata: { reason: 'ldap_group_denied' }
        })
        return error(res, 401, 'LDAP_GROUP_NOT_ADMITTED', LDAP_GROUP_NOT_ADMITTED_MESSAGE, traceId)
      }
      const result = await ldap.authenticate(username, password)
      if (!result.ok) {
        // 查询侧 filter miss：密码未经 bind 验证，不计数也不清锁定。
        if (result.reason === 'not_admitted') {
          return refuseNotAdmitted()
        }
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
      // 平台统一闸门（Mock 唯一执行点/生产防御第二道）：密码已验，清零已发生、不增量。
      if (ldapRequiredGroup && !result.profile.groups.includes(ldapRequiredGroup)) {
        return refuseNotAdmitted()
      }
      let user = store.usersByName.get(username)
      // U228: a disabled account must not sign in. Refuse after the password
      // check but before any device/session/token/Cookie is created.
      if (user && user.status !== 'active') {
        audit.appendBestEffort({
          eventType: 'login',
          actor: user.username,
          targetType: 'session',
          targetId: null,
          result: 'denied',
          traceId,
          metadata: { reason: 'USER_DISABLED' }
        })
        return error(res, 403, 'USER_DISABLED', '账号已停用，请联系平台管理员。', traceId)
      }
      if (!user) {
        user = store.seedUser({
          username,
          displayName: result.profile.displayName,
          dept: result.profile.dept,
          email: result.profile.email,
          groups: result.profile.groups,
          roles: ['developer'],
          status: 'active'
        })
      }
      user.groups = [...new Set([...user.groups, ...result.profile.groups])]
      // 角色覆盖优先于 LDAP 种子（§7.3）：种子只在首登生效，覆盖后每次登录重算。
      if (user.roleOverride) {
        user.roles = USER_PAGE_ROLES[user.roleOverride]
      }
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
      // S1: a same-origin browser keeps the refresh token in the Cookie, so the
      // body carries only the access token; everyone else keeps the old body.
      const issueCookie = issuesRefreshCookie(req)
      if (issueCookie) setRefreshCookie(res, tokens.refreshToken)
      return json(res, 200, {
        ...(issueCookie ? { accessToken: tokens.accessToken, refreshCookie: true } : tokens),
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
      // A duplicate or indistinguishable Cookie is a hard 401: never fall back
      // to the body, or an attacker could rotate a valid body token via it.
      if (hasAmbiguousRefreshCookie(req)) {
        clearRefreshCookie(res)
        res.setHeader('cache-control', 'no-store')
        return error(res, 401, 'SESSION_EXPIRED', '会话已失效，请重新登录。', traceId)
      }
      const cookieParse = refreshCookieEnabled()
        ? parseRefreshCookie(req.headers.cookie)
        : ({ kind: 'absent' } as const)
      const cookieValue = cookieParse.kind === 'present' ? cookieParse.value : ''
      const cookieSessionId =
        cookieValue === '' ? undefined : store.refreshTokens.get(hashToken(cookieValue))
      const cookieSession = cookieSessionId ? store.sessions.get(cookieSessionId) : undefined

      // U197 S2: Cookie first; the body is consulted only when no Cookie resolves.
      if (cookieSession) {
        // CSRF has no side effects: reject before any renewal or clear.
        if (!passesCookieCsrf(req)) {
          res.setHeader('cache-control', 'no-store')
          return error(res, 403, 'CSRF_REJECTED', '请求来源不受信任。', traceId)
        }
        const cookieBody = await readBody(req, AUTH_BODY_MAX_BYTES)
        if (cookieBody.oversized) {
          res.setHeader('cache-control', 'no-store')
          return rejectOversizedBody(res, traceId)
        }
        const body = cookieBody.body
        // Re-check after the body read: a concurrent revoke must still 401.
        if (cookieSession.revokedAt || cookieSession.refreshExpiresAt < now()) {
          // U241 ②: revoking on expiry makes old access tokens fail immediately;
          // an already-revoked session is left untouched (no second bump).
          revokeSessionOnce(cookieSession)
          clearRefreshCookie(res)
          return error(res, 401, 'SESSION_EXPIRED', '会话已失效，请重新登录。', traceId)
        }
        // U228: a disabled account must not renew. Revoke before any branch so
        // current, previous and grace values all fail the same way.
        const cookieUser = store.users.get(cookieSession.userId)
        if (!cookieUser || cookieUser.status !== 'active') {
          await revokeDisabledSession(cookieSession, cookieUser, 'cookie', traceId)
          clearRefreshCookie(res)
          return error(res, 401, 'SESSION_EXPIRED', '会话已失效，请重新登录。', traceId)
        }
        const cookieHash = hashToken(cookieValue)
        const cookieIsCurrent = safeEqual(cookieSession.refreshHash, cookieHash)
        const cookieIsPrevious =
          !cookieIsCurrent &&
          cookieSession.previousRefreshHash !== undefined &&
          safeEqual(cookieSession.previousRefreshHash, cookieHash)
        // U235/U236: readJsonWithRes now normalises null/scalars to {}, so this is
        // defence in depth; arrays are objects and simply carry no token.
        const bodyToken =
          body !== null && typeof body === 'object' && typeof body.refreshToken === 'string'
            ? body.refreshToken
            : ''
        const bodyHash = bodyToken === '' ? undefined : hashToken(bodyToken)
        const bodyIsCurrent =
          bodyHash !== undefined && safeEqual(cookieSession.refreshHash, bodyHash)
        const bodyIsPrevious =
          bodyHash !== undefined &&
          cookieSession.previousRefreshHash !== undefined &&
          safeEqual(cookieSession.previousRefreshHash, bodyHash)
        const inGrace = cookieSession.graceUntil !== undefined && now() < cookieSession.graceUntil
        // Echo only a value this session owns; a fake or foreign body value must
        // never become a refresh in the response.
        const echoRefresh = bodyIsCurrent || bodyIsPrevious

        // A value that maps to this session but is neither current nor previous
        // is a replay, as is a previous hit outside the window (§5.3/§5.5).
        if (!cookieIsCurrent && !cookieIsPrevious) {
          revokeSessionOnce(cookieSession)
          clearRefreshCookie(res)
          audit.appendBestEffort({
            eventType: 'refresh.reuse_detected',
            actor: null,
            targetType: 'session',
            targetId: cookieSession.id,
            result: 'failure',
            traceId,
            metadata: { source: 'cookie' }
          })
          return error(res, 401, 'SESSION_EXPIRED', '会话已失效，请重新登录。', traceId)
        }

        // v5 §2B-2/§5.2: a stale Cookie inside the grace window still mints
        // access, but nothing is rotated or renewed and no Cookie is re-sent.
        if (cookieIsPrevious) {
          if (!inGrace) {
            revokeSessionOnce(cookieSession)
            clearRefreshCookie(res)
            audit.appendBestEffort({
              eventType: 'refresh.reuse_detected',
              actor: null,
              targetType: 'session',
              targetId: cookieSession.id,
              result: 'failure',
              traceId,
              metadata: { source: 'cookie' }
            })
            return error(res, 401, 'SESSION_EXPIRED', '会话已失效，请重新登录。', traceId)
          }
          audit.appendBestEffort({
            eventType: 'refresh.grace_reuse',
            actor: null,
            targetType: 'session',
            targetId: cookieSession.id,
            result: 'success',
            traceId,
            metadata: { source: 'cookie' }
          })
          return json(res, 200, {
            accessToken: issueAccessToken(cookieSession),
            ...(echoRefresh ? { refreshToken: bodyToken } : {}),
            expiresIn: expiresInSeconds
          })
        }

        // A previous body value outside the window is a replay even when the
        // Cookie itself is current (§5.5).
        if (bodyIsPrevious && !inGrace) {
          revokeSessionOnce(cookieSession)
          clearRefreshCookie(res)
          audit.appendBestEffort({
            eventType: 'refresh.reuse_detected',
            actor: null,
            targetType: 'session',
            targetId: cookieSession.id,
            result: 'failure',
            traceId,
            metadata: { source: 'cookie' }
          })
          return error(res, 401, 'SESSION_EXPIRED', '会话已失效，请重新登录。', traceId)
        }

        // U218 §2B-5: a previous-body hit while the Cookie is current is a
        // windowed replay; audit it without recording the token value.
        if (bodyIsPrevious) {
          audit.appendBestEffort({
            eventType: 'refresh.grace_reuse',
            actor: null,
            targetType: 'session',
            targetId: cookieSession.id,
            result: 'success',
            traceId,
            metadata: { source: 'body' }
          })
        }

        // v5 §2B-2: the Cookie is the credential, so it never rotates and the
        // server never mints a new refresh here. Every hit except the
        // previous-body grace echo slides the expiry and re-sends the identical
        // current value.
        const renew = !bodyIsPrevious
        if (renew) cookieSession.refreshExpiresAt = now() + refreshTtlMs
        // Reconstruction reads in-memory plaintext (`currentRefreshToken`), then
        // falls back to the Cookie already verified current above.
        const sameValue = currentRefreshTokenOf(cookieSession, cookieValue)
        const resendCookie = renew && sameValue !== null
        if (resendCookie) setRefreshCookie(res, sameValue)
        return json(res, 200, {
          accessToken: issueAccessToken(cookieSession),
          ...(echoRefresh ? { refreshToken: bodyToken } : {}),
          expiresIn: expiresInSeconds,
          ...(resendCookie ? { refreshCookie: true } : {})
        })
      }

      // Body fallback: the legacy path, unchanged except for the grace window.
      const fallbackBody = await readBody(req, AUTH_BODY_MAX_BYTES)
      if (fallbackBody.oversized) {
        res.setHeader('cache-control', 'no-store')
        return rejectOversizedBody(res, traceId)
      }
      const body = fallbackBody.body
      // U235/U236: readJsonWithRes normalises null/scalars to {}; an array has no
      // refreshToken field, so the empty-token path covers it too.
      const rawBodyToken =
        body !== null && typeof body === 'object' ? body.refreshToken : undefined
      const token = String(rawBodyToken ?? '')
      const sessionId = store.refreshTokens.get(hashToken(token))
      const session = sessionId ? store.sessions.get(sessionId) : undefined
      if (!session || session.revokedAt || session.refreshExpiresAt < now()) {
        // U241 ②: an expired session is revoked once so its access tokens die
        // now instead of at the next access-TTL boundary.
        if (session) revokeSessionOnce(session)
        if (refreshCookieEnabled()) clearRefreshCookie(res)
        return error(res, 401, 'SESSION_EXPIRED', '会话已失效，请重新登录。', traceId)
      }
      // U228: a disabled account must not renew through the body source either.
      const sessionUser = store.users.get(session.userId)
      if (!sessionUser || sessionUser.status !== 'active') {
        await revokeDisabledSession(session, sessionUser, 'body', traceId)
        if (refreshCookieEnabled()) clearRefreshCookie(res)
        return error(res, 401, 'SESSION_EXPIRED', '会话已失效，请重新登录。', traceId)
      }
      const isCurrent = safeEqual(session.refreshHash, hashToken(token))
      if (!isCurrent) {
        const isPrevious =
          session.previousRefreshHash !== undefined &&
          safeEqual(session.previousRefreshHash, hashToken(token))
        if (isPrevious && session.graceUntil !== undefined && now() < session.graceUntil) {
          // Grace hit: no rotation and no renewal; echo the request value so an
          // old page does not write the literal "undefined".
          audit.appendBestEffort({
            eventType: 'refresh.grace_reuse',
            actor: null,
            targetType: 'session',
            targetId: session.id,
            result: 'success',
            traceId,
            metadata: { source: 'body' }
          })
          return json(res, 200, {
            accessToken: issueAccessToken(session),
            refreshToken: token,
            expiresIn: expiresInSeconds
          })
        }
        revokeSessionOnce(session)
        if (refreshCookieEnabled()) clearRefreshCookie(res)
        audit.appendBestEffort({
          eventType: 'refresh.reuse_detected',
          actor: null,
          targetType: 'session',
          targetId: session.id,
          result: 'failure',
          traceId,
          metadata: { source: 'body' }
        })
        return error(res, 401, 'SESSION_EXPIRED', '会话已失效，请重新登录。', traceId)
      }
      // Why kept: a replayed old token must still identify this session, so the
      // hash mismatch below can revoke it instead of reading as an unknown token.
      const accessToken = issueAccessToken(session)
      const refreshToken = randomBytes(32).toString('base64url')
      session.previousRefreshHash = session.refreshHash
      session.graceUntil = now() + refreshGraceMs
      session.refreshHash = hashToken(refreshToken)
      session.currentRefreshToken = refreshToken
      session.refreshExpiresAt = now() + refreshTtlMs
      store.refreshTokens.set(hashToken(refreshToken), session.id)
      // The one place that may both set the Cookie and return a newly minted
      // body refresh: a Cookie-less legacy caller has no other credential.
      const issueCookie = issuesRefreshCookie(req)
      if (issueCookie) setRefreshCookie(res, refreshToken)
      return json(res, 200, {
        accessToken,
        refreshToken,
        expiresIn: expiresInSeconds,
        ...(issueCookie ? { refreshCookie: true } : {})
      })
    }

    // ---- web handoff (FR-3.10): a browser trades its one-time code for a session ----
    // Deliberately before token resolution: the caller has no session yet.
    if (req.method === 'POST' && path === '/v1/web/handoff') {
      // U250: the body carries the one-time handoff code, a credential. Cap it
      // before any credential-state check, so an oversized request is refused
      // without consuming or probing a code or Cookie.
      const handoff = await readBody(req, AUTH_BODY_MAX_BYTES)
      if (handoff.oversized) {
        res.setHeader('cache-control', 'no-store')
        return rejectOversizedBody(res, traceId)
      }
      if (hasAmbiguousRefreshCookie(req)) {
        clearRefreshCookie(res)
        res.setHeader('cache-control', 'no-store')
        return error(res, 401, 'SESSION_EXPIRED', '会话状态异常，请清除 Cookie 后重试。', traceId)
      }
      // U218 §2B-9: the host cross-origin handoff (an Origin) stays valid, but a
      // Cookie without Origin is never parsed as a Cookie source.
      if (carriesRefreshCookieWithoutOrigin(req)) {
        // U233 F2: clear the stale Cookie before refusing, or a cookie-jar client
        // is locked out permanently.
        clearRefreshCookie(res)
        res.setHeader('cache-control', 'no-store')
        return error(res, 401, 'SESSION_EXPIRED', '会话状态异常，请清除 Cookie 后重试。', traceId)
      }
      const body = handoff.body
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
        // U233 F3: only an archived project is project_archived; a missing or
        // disabled subject is subject_gone.
        await deny(
          410,
          'HANDOFF_GONE',
          '交接码无效或已使用。',
          !user || user.status !== 'active' || !project ? 'subject_gone' : 'project_archived',
          user?.username ?? null
        )
        return
      }
      // The code is bound to a user, not a permission: a grant pulled between
      // issue and redeem must still stop the entry here (synthesized bits).
      if (!effectiveProjectPermissions(store, project, user, isAdmin(user)).includes('open')) {
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
      // S1: platform same-origin gets the Cookie and no body refresh; the
      // host-served cross-origin pages keep the new body token (Cookie is dropped).
      const issueCookie = issuesRefreshCookie(req)
      if (issueCookie) setRefreshCookie(res, tokens.refreshToken)
      return json(res, 200, {
        ...(issueCookie ? { accessToken: tokens.accessToken, refreshCookie: true } : tokens),
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
      // U233 F1: an ambiguous Cookie is still a hard 401, but Bearer/body are
      // explicit locators and must be revoked before returning it. The Cookie
      // itself stays unguessed.
      const ambiguousCookie = hasAmbiguousRefreshCookie(req)
      // U218: clearing never depends on the mode — a stale Cookie from an
      // earlier deployment must not survive logout.
      clearRefreshCookie(res)
      const auth = resolveToken(req)
      // An expired access token resolves to null, so locate the session from the
      // Cookie too and revoke both when they differ (§2B-3).
      const cookieParse = parseRefreshCookie(req.headers.cookie)
      const cookieToken = cookieParse.kind === 'present' ? cookieParse.value : ''
      const cookieSessionId =
        cookieToken === '' ? undefined : store.refreshTokens.get(hashToken(cookieToken))
      // U229 F10: with an expired access token and no Cookie, a legacy client has
      // no server-side locator; the body may carry the refresh token instead.
      // Never let a malformed or oversized body turn sign-out into an error.
      let body: Record<string, unknown> = {}
      try {
        body = await readJsonWithRes(req, res, LOGOUT_BODY_MAX_BYTES)
      } catch {
        body = {}
      }
      // U232/U236: readJsonWithRes normalises non-object bodies to {}; keep the guard
      // as defence in depth for the logout body token.
      const bodyToken =
        body !== null && typeof body === 'object' && typeof body.refreshToken === 'string'
          ? body.refreshToken
          : ''
      const bodySessionId =
        bodyToken === '' ? undefined : store.refreshTokens.get(hashToken(bodyToken))
      const targets = new Set<string>()
      if (auth) targets.add(auth.sessionId)
      if (cookieSessionId !== undefined) targets.add(cookieSessionId)
      if (bodySessionId !== undefined) targets.add(bodySessionId)
      // U241 ①: an already revoked session (disabled refresh, reuse detection)
      // must not bump the epoch or log a second success; the 200 and Cookie
      // clearing still happen below.
      const revokedSessions: string[] = []
      for (const sessionId of targets) {
        const session = store.sessions.get(sessionId)
        if (!session || !revokeSessionOnce(session)) continue
        revokedSessions.push(sessionId)
      }
      // One logout event per newly revoked session, deduped by the target set (U220 N2).
      for (const sessionId of revokedSessions) {
        const session = store.sessions.get(sessionId)
        const user = session ? store.users.get(session.userId) : undefined
        if (!session || !user) continue
        const event = {
          eventType: 'logout',
          actor: user.username,
          targetType: 'session',
          targetId: sessionId,
          result: 'success' as const,
          traceId
        }
        // U233 F5: every logout target is best-effort — a failed audit write
        // must not turn a completed revocation into a 500.
        audit.appendBestEffort(event)
      }
      // A forged value must neither revoke nor reveal anything; record the denial
      // without the token itself.
      if (bodyToken !== '' && bodySessionId === undefined) {
        audit.appendBestEffort({
          eventType: 'logout',
          actor: null,
          targetType: 'session',
          targetId: null,
          result: 'denied',
          traceId,
          metadata: { reason: 'UNKNOWN_REFRESH' }
        })
      }
      if (ambiguousCookie) {
        return error(res, 401, 'SESSION_EXPIRED', '会话状态异常，请清除 Cookie 后重试。', traceId)
      }
      return json(res, 200, { ok: true })
    }

    const auth = resolveToken(req)
    const requireAuth = (): AuthedRequest | null => {
      if (!auth) error(res, 401, 'SESSION_EXPIRED', '登录已过期，请重新登录。', traceId)
      return auth
    }

    // ---- install wizard (FR-4.11): admin-issued, the script embeds secrets ----
    // U115: the copied command runs on the target machine with no session, so a
    // one-time download token in the URL authenticates it; Bearer stays for the
    // API and tests. The static fallback above skips /install/ to reach here.
    if (req.method === 'GET' && (path === '/install/host.sh' || path === '/install/relay.sh')) {
      const kind = path === '/install/host.sh' ? 'host' : 'relay'
      const download = url.searchParams.get('download') ?? ''
      const downloadMatch = download
        ? findInstallDownloadToken(download, kind, url.searchParams.get('hostId'))
        : null
      const authed: AuthedRequest | null = downloadMatch
        ? { user: downloadMatch.user, sessionId: 'install-download' }
        : requireAuth()
      if (!authed) return
      if (!downloadMatch && !isAdmin(authed.user)) {
        return denyPrivileged(res, traceId, authed.user, {
          eventType: 'install_script',
          targetType: 'install_script',
          targetId: path,
          permission: 'platform:admin'
        })
      }
      // The operator pastes this command on the target machine, so the embedded
      // address must be the one the wizard page saw.
      const platformUrl = requestOrigin(req)
      const bundleSha = (url.searchParams.get('sha') ?? configuredRelayBundleSha).trim()
      let bundleEmbed: RelayBundleEmbed | undefined
      if (kind === 'relay' && bundleSha) {
        if (!RELAY_BUNDLE_SHA_PATTERN.test(bundleSha)) {
          return error(res, 400, 'RELAY_BUNDLE_SHA_INVALID', 'bundle sha 非法。', traceId)
        }
        const origin = new URL(platformUrl)
        const downloadTls = origin.protocol === 'https:'
        // B2: an https-only proto restriction would break local http platforms;
        // instead, production (non-loopback http) refuses to generate a script.
        if (!downloadTls && !isLoopbackHost(origin.hostname)) {
          return error(
            res,
            400,
            'RELAY_BUNDLE_INSECURE_URL',
            '生产平台必须使用 https 下发 relay bundle。',
            traceId
          )
        }
        const dir = await stat(relayBundleDir).catch(() => null)
        const archive = dir?.isDirectory()
          ? await readFile(join(relayBundleDir, `relay-bundle-${bundleSha}.tgz`)).catch(() => null)
          : null
        if (!archive) {
          return error(
            res,
            503,
            'RELAY_BUNDLE_UNAVAILABLE',
            '目标 relay bundle 不存在，无法生成安装脚本。',
            traceId
          )
        }
        const manifest = await readRelayBundleManifest(relayBundleDir, bundleSha)
        if (!manifest.ok)
          return error(res, manifest.status, manifest.code, manifest.message, traceId)
        bundleEmbed = {
          sha256: bundleSha,
          schemaVersion: manifest.manifest.schemaVersion,
          relayCodeVersion: manifest.manifest.relayCodeVersion,
          downloadTls
        }
      }
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
        script = relayInstallScript({
          platformUrl,
          internalToken,
          ...(bundleEmbed ? { bundle: bundleEmbed } : {})
        })
      }
      // Burn only now: a request that failed the script's own checks must not
      // spend the admin's one shot.
      if (downloadMatch) downloadMatch.entry.usedAt = now()
      // Why no token in metadata: the audit log must not become a second copy of the secret.
      audit.appendBestEffort({
        eventType: 'install_script',
        actor: authed.user.username,
        targetType: 'install_script',
        targetId: `${kind}.sh`,
        result: 'success',
        traceId,
        metadata: {
          type: kind,
          tokenEmbedded,
          platformUrl,
          via: downloadMatch ? 'download-token' : 'session'
        }
      })
      res.writeHead(200, {
        'content-type': 'text/x-shellscript; charset=utf-8',
        // U182: the body embeds a secret; no shared cache may keep it.
        'cache-control': 'no-store'
      })
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
        if (session.deviceId === device.id) revokeSessionOnce(session)
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
            (isAdmin(authed.user) ||
              effectiveProjectPermissions(store, p, authed.user, false).includes('open'))
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
      const body = await readSensitiveWriteBody(req, res, traceId)
      if (!body) return
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
          // U254: a 16 KiB key would push the event past the writer's 16 KiB cap.
          metadata: {
            reason: keyVerdict.code,
            key: String(body.key ?? '').slice(0, MAX_PROJECT_KEY_LENGTH)
          }
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
      const pathTooLong = pathVerdict.ok && pathVerdict.path.length > PROJECT_PATH_MAX_CHARS
      if (!pathVerdict.ok || pathTooLong) {
        const code = pathVerdict.ok ? 'PROJECT_PATH_INVALID' : pathVerdict.code
        const message = pathVerdict.ok ? '项目路径不能超过 4096 个字符。' : pathVerdict.message
        await audit.append({
          eventType: 'project_create',
          actor: authed.user.username,
          targetType: 'project',
          targetId: null,
          result: 'denied',
          traceId,
          // U254: keep the event under the writer's 16 KiB cap; 4096 still locates it.
          metadata: { reason: code, path: String(body.path ?? '').slice(0, PROJECT_PATH_MAX_CHARS) }
        })
        return error(res, 400, code, message, traceId)
      }
      if (projectPathTaken(store, target.id, pathVerdict.path)) {
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
      // U261 P45: an unknown value was silently coerced to deny; refuse it like
      // the project/global policy routes (D2) instead of 201 with a changed policy.
      if (
        body.downloadPolicy !== undefined &&
        body.downloadPolicy !== 'allow' &&
        body.downloadPolicy !== 'deny'
      ) {
        await audit.append({
          eventType: 'project_create',
          actor: authed.user.username,
          targetType: 'project',
          targetId: null,
          result: 'denied',
          traceId,
          metadata: { reason: 'POLICY_INVALID' }
        })
        return error(res, 400, 'POLICY_INVALID', 'downloadPolicy 必须是 allow 或 deny。', traceId)
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
      const body = await readSensitiveWriteBody(req, res, traceId)
      if (!body) return
      const deny = async (
        status: number,
        code: string,
        message: string,
        details?: Record<string, unknown>,
        metadata?: Record<string, unknown>
      ): Promise<void> => {
        await audit.append({
          eventType: 'project_create',
          actor: authed.user.username,
          targetType: 'project',
          targetId: null,
          result: 'denied',
          traceId,
          metadata: { reason: code, selfService: true, ...metadata }
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
        isOnline: hostOnline,
        // U62 C10: auto-selection counts only hosts this caller may provision
        // on, so "no usable host" answers NO_PROVISIONABLE_HOST instead of
        // asking the caller to pick among hosts that would 403 anyway.
        isProvisionAllowed: (host) =>
          canCreateProjectOnHost(store, host.id, authed.user, isAdmin(authed.user))
      })
      if (!selection.ok) {
        return await deny(selection.status, selection.code, selection.message, selection.details)
      }
      // U65/U67: creation needs the provision bit (admin bypass); the legacy
      // provisionPolicy no longer opens the gate — it only reports in /available.
      if (!canCreateProjectOnHost(store, selection.host.id, authed.user, isAdmin(authed.user))) {
        return await deny(
          403,
          'HOST_PROVISION_FORBIDDEN',
          '该主机已限制自助建项目，请联系管理员。',
          undefined,
          { hostId: selection.host.id }
        )
      }
      const key = keyVerdict.key
      if (projectKeyTaken(store, key)) {
        return await deny(409, 'PROJECT_KEY_TAKEN', '项目 Key 已被占用，请更换。')
      }
      const root = selection.host.projectsRoot
      if (root === null) {
        return await deny(400, 'PATH_OUTSIDE_ROOT', '项目目录不在主机项目根目录内。')
      }
      const joined = joinProjectPath(root, dirVerdict.dir)
      // U256: a long root can derive a path past the 4096-char contract; refuse
      // it here, before any project row exists, instead of persisting it.
      if (!joined.ok) {
        return await deny(400, joined.code, joined.message)
      }
      const projectPath = joined.path
      if (projectPathTaken(store, selection.host.id, projectPath)) {
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
      // 404 for both unknown and unauthorised: never leak existence. The open
      // verdict reads the synthesized bits, so a host view grant sees it too.
      const adminAccess = isAdmin(authed.user) || authed.user.roles.includes('platform:auditor')
      if (
        !found ||
        (!adminAccess &&
          !effectiveProjectPermissions(store, found, authed.user, false).includes('open'))
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
      // G06: admin-only opt-in mirrors the list param; history stays readable, not operable.
      const archivedReadOptIn =
        req.method === 'GET' &&
        action === '' &&
        isAdmin(authed.user) &&
        url.searchParams.get('includeArchived') === '1'
      // Why: an archived project is history; only archive/restore (or the admin
      // opt-in read) may still see it.
      if (found.status === 'archived' && !archiveAction && !archivedReadOptIn) {
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
        const body = await readSensitiveWriteBody(req, res, traceId)
        if (!body) return
        if ('path' in body || 'hostId' in body) {
          return error(res, 400, 'PROJECT_FIELD_IMMUTABLE', '项目路径与主机不允许修改。', traceId)
        }
        // U237 D1: an empty body used to reset status/provisioningError and log
        // a success without changing a field. Explicit null still clears.
        if (!('repoUrl' in body) && !('defaultBranch' in body)) {
          return error(
            res,
            400,
            'PROJECT_UPDATE_INVALID',
            '至少提供 repoUrl 或 defaultBranch 之一。',
            traceId
          )
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
        return handleWebHandoff(req, res, authed.user, found, traceId, platformOrigin)
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
        if (!isAdmin(authed.user) && !authed.user.roles.includes('project:owner')) {
          // AC-18: a refused grant write is a 403 *and* an audit event.
          // U62 G4: the event names the refused subject.
          const body = await readJsonWithRes(req, res, DENIED_AUDIT_BODY_MAX_BYTES)
          return denyPrivileged(res, traceId, authed.user, {
            eventType: 'grant_update',
            targetType: 'project',
            targetId: projectId,
            permission: 'platform:admin',
            metadata: deniedGrantMetadata(body)
          })
        }
        if (!auditAllowsMutations(res, traceId)) return
        const body = await readSensitiveWriteBody(req, res, traceId)
        if (!body) return
        // U62 B12: same contract as host grants — reject unknown subject types.
        if (
          body.subjectType !== undefined &&
          body.subjectType !== 'user' &&
          body.subjectType !== 'group'
        ) {
          return error(
            res,
            400,
            'GRANT_SUBJECT_TYPE_INVALID',
            'subjectType 只支持 user 或 group。',
            traceId
          )
        }
        const subjectType = body.subjectType === 'group' ? 'group' : 'user'
        const submitted = String(body.subjectId ?? '').trim()
        // A non-array used to read as [] and delete the row; reject it instead (U57 G9).
        if (!Array.isArray(body.permissions)) {
          return error(res, 400, 'GRANT_PERMISSION_INVALID', '权限位不在允许范围内。', traceId)
        }
        const submittedPermissions: unknown[] = body.permissions
        // PUT is a whole-row replacement, so an out-of-contract bit rejects the
        // row instead of silently storing a bit no host rule reads.
        const permissions = submittedPermissions.filter(
          (permission): permission is Permission =>
            typeof permission === 'string' && GRANT_PERMISSION_SET.has(permission)
        )
        if (permissions.length !== submittedPermissions.length) {
          return error(res, 400, 'GRANT_PERMISSION_INVALID', '权限位不在允许范围内。', traceId)
        }
        // The ACL matches on the user id, so a username has to be resolved here:
        // storing it verbatim would mint a grant that reads as granted and never
        // fires (M116-QA-001). A group nobody has been seen in is the same dead
        // row, so it is refused too (A2).
        const resolved = resolveGrantSubject(store, subjectType, submitted)
        if (!resolved.ok) {
          return error(res, 400, resolved.code, resolved.message, traceId)
        }
        const subjectId = resolved.subjectId
        const username = resolved.subjectType === 'user' ? resolved.username : null
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
          : projectPathTaken(store, found.hostId, found.path, found.id)
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
        // U251 P3: same order as the other tiers — audit availability first, so
        // a broken chain answers 503 even when the body is oversized.
        if (!auditAllowsMutations(res, traceId)) return
        const body = await readSensitiveWriteBody(req, res, traceId)
        if (!body) return
        // `inherit: true` is the only way back to following the global default:
        // it drops the explicit flag and ignores any downloadPolicy in the body.
        // Old clients never send it, so their requests take the pinned branch.
        const inherit = body.inherit === true
        // U237 D2: a missing/typo'd downloadPolicy used to be coerced to `deny`.
        if (!inherit && body.downloadPolicy !== 'allow' && body.downloadPolicy !== 'deny') {
          return error(
            res,
            400,
            'POLICY_INVALID',
            'downloadPolicy 必须是 allow 或 deny，或传 inherit:true。',
            traceId
          )
        }
        const nextPolicy = body.downloadPolicy === 'allow' ? 'allow' : 'deny'
        const rate = parseReadRate(body.readRatePerHour)
        if (rate.kind === 'invalid') {
          return error(res, 400, 'POLICY_INVALID', '读取限速必须是大于 0 的 calls/bytes。', traceId)
        }
        return withPolicyWriteLock(async () => {
          // U136④a: same optimistic control as the global policy, on the shared version.
          const expectedVersion = parseExpectedVersion(body.expectedVersion)
          if (expectedVersion.kind === 'invalid') {
            return error(res, 400, 'POLICY_INVALID', 'expectedVersion 必须是非负整数。', traceId)
          }
          if (
            expectedVersion.kind === 'set' &&
            expectedVersion.version !== store.policies.version
          ) {
            if (
              !(await recordAudit(
                res,
                {
                  eventType: 'policy_update',
                  actor: authed.user.username,
                  targetType: 'project',
                  targetId: projectId,
                  result: 'failure',
                  traceId,
                  metadata: {
                    reason: 'POLICY_VERSION_CONFLICT',
                    expectedVersion: expectedVersion.version,
                    resultVersion: store.policies.version,
                    ...(inherit ? { inherited: true } : { downloadPolicy: found.downloadPolicy })
                  }
                },
                traceId
              ))
            ) {
              return
            }
            return error(
              res,
              409,
              'POLICY_VERSION_CONFLICT',
              '下载策略已被他人修改，请刷新后重试。',
              traceId,
              {
                version: store.policies.version,
                downloadPolicy: found.downloadPolicy,
                readRatePerHour: found.readRatePerHour ?? store.policies.readRatePerHour
              }
            )
          }
          const resultVersion = store.policies.version + 1
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
                  ...(rate.kind === 'clear' ? { readRatePerHour: null } : {}),
                  ...(expectedVersion.kind === 'set'
                    ? { expectedVersion: expectedVersion.version, resultVersion }
                    : {})
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
          store.policies.version = resultVersion
          return json(res, 200, {
            downloadPolicy: found.downloadPolicy,
            readRatePerHour: found.readRatePerHour ?? store.policies.readRatePerHour,
            version: store.policies.version
          })
        })
      }
    }

    // ---- authorization directory (A1) ----
    // Derived from what the platform already knows, so Mock and production share
    // one implementation (no LDAP search adapter exists).
    if (req.method === 'GET' && path === '/v1/directory') {
      const authed = requireAuth()
      if (!authed) return
      if (!isAdmin(authed.user)) {
        return denyPrivileged(res, traceId, authed.user, {
          eventType: 'directory_read',
          targetType: 'directory',
          permission: 'platform:admin'
        })
      }
      return json(res, 200, {
        users: [...store.users.values()].map((user) => ({
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          dept: user.dept
        })),
        groups: knownGroups(store)
      })
    }

    // ---- user management (U67-3): admin-only list + role writes ----
    if (req.method === 'GET' && path === '/v1/users') {
      const authed = requireAuth()
      if (!authed) return
      if (!isAdmin(authed.user)) {
        return denyPrivileged(res, traceId, authed.user, {
          eventType: 'user_list',
          targetType: 'user',
          permission: 'platform:admin'
        })
      }
      return json(res, 200, {
        // U145: additive admission config, so the page states a fact instead of a fake sync status.
        ldap: { requiredGroup: ldapRequiredGroup },
        users: [...store.users.values()].map((user) => ({
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          dept: user.dept,
          groups: user.groups,
          roles: user.roles,
          status: user.status,
          role: userPageRole(user.roles),
          roleSource: user.roleOverride ? 'admin-override' : 'default'
        }))
      })
    }

    const userRolesPath = path.match(/^\/v1\/users\/([\w-]+)\/roles$/)
    if (userRolesPath && req.method === 'PUT') {
      const authed = requireAuth()
      if (!authed) return
      const targetId = userRolesPath[1]
      if (!isAdmin(authed.user)) {
        return denyPrivileged(res, traceId, authed.user, {
          eventType: 'role_update',
          targetType: 'user',
          targetId,
          permission: 'platform:admin'
        })
      }
      if (!auditAllowsMutations(res, traceId)) return
      const body = await readSensitiveWriteBody(req, res, traceId)
      if (!body) return
      const next =
        body.role === 'developer' || body.role === 'auditor' || body.role === 'admin'
          ? body.role
          : null
      if (next === null) {
        return error(res, 400, 'ROLE_INVALID', '角色只能是普通、审计或管理员。', traceId)
      }
      const target = store.users.get(targetId)
      if (!target) {
        return error(res, 404, 'USER_NOT_FOUND', '用户不存在。', traceId)
      }
      const from = userPageRole(target.roles)
      // U135: a disabled account keeps its directory state until re-enabled;
      // re-roling it would pre-stage permissions for a login that must not work.
      if (target.status !== 'active') {
        audit.appendBestEffort({
          eventType: 'role_update',
          actor: authed.user.username,
          targetType: 'user',
          targetId: target.id,
          result: 'denied',
          traceId,
          metadata: { reason: 'USER_DISABLED', from, to: next, username: target.username }
        })
        return error(res, 409, 'USER_DISABLED', '账号已停用，不能修改角色。', traceId)
      }
      // 只有管理员降级需要撤凭证：旧云会话票据按 admin 旁路签发（位无上限），
      // 降级后必须重算——≤60s 心跳撤销闭环；升级只增不减，不撤销（§7.3）。
      const revoked = from === 'admin' && next !== 'admin'
      if (
        !(await recordAudit(
          res,
          {
            eventType: 'role_update',
            actor: authed.user.username,
            targetType: 'user',
            targetId: target.id,
            result: 'success',
            traceId,
            metadata: { from, to: next, username: target.username, revoked }
          },
          traceId
        ))
      ) {
        return
      }
      target.roleOverride = next
      target.roles = USER_PAGE_ROLES[next]
      if (revoked) {
        revokeUserCredentials(target.username, 'role_changed')
      }
      return json(res, 200, { ok: true, roles: target.roles, source: 'admin-override' })
    }

    // U244 / FR-1.6: admin force-offline — kill every platform session and the
    // host ticket, but not the devices (force-offline is not device loss).
    const userSessionsRevokePath = path.match(/^\/v1\/users\/([\w-]+)\/sessions\/revoke$/)
    if (userSessionsRevokePath && req.method === 'POST') {
      const authed = requireAuth()
      if (!authed) return
      const targetId = userSessionsRevokePath[1]
      if (!isAdmin(authed.user)) {
        return denyPrivileged(res, traceId, authed.user, {
          eventType: 'session_revoke',
          targetType: 'user',
          targetId,
          permission: 'platform:admin'
        })
      }
      if (!auditAllowsMutations(res, traceId)) return
      const body = await readJsonWithRes(req, res, FORCE_OFFLINE_BODY_MAX_BYTES)
      const rawReason = typeof body.reason === 'string' ? body.reason.trim() : ''
      const reason = rawReason.slice(0, AUDIT_REASON_MAX_CHARS)
      const target = store.users.get(targetId)
      if (!target) {
        return error(res, 404, 'USER_NOT_FOUND', '用户不存在。', traceId)
      }
      // Test-only barrier: both racing requests pause here before serialising.
      await config.beforeUserSessionRevoke?.()
      let revokedSessions: number
      try {
        revokedSessions = await withUserSessionRevokeLock(target.id, async (follower) => {
          // A follower re-enters after a successful leader already revoked,
          // audited and refreshed the marker; reporting 0 avoids a duplicate event.
          if (follower) return 0
          const live = [...store.sessions.values()].filter(
            (session) => session.userId === target.id && session.revokedAt === null
          )
          // Every admin action is audited, including a repeat that revokes nothing:
          // the marker refresh below is real state hosts act on. Remaining dedupe
          // against unrelated markers (grant_changed etc.) is wrong here.
          // The write-ahead event can only report the pre-audit target count.
          if (
            !(await recordAudit(
              res,
              {
                eventType: 'session_revoke',
                actor: authed.user.username,
                targetType: 'user',
                targetId: target.id,
                result: 'success',
                traceId,
                metadata: {
                  username: target.username,
                  revokedSessions: live.length,
                  ...(reason === '' ? {} : { reason })
                }
              },
              traceId
            ))
          ) {
            throw USER_SESSION_REVOKE_AUDIT_FAILED
          }
          // U249 P2-4: a login that lands during the audit await is absent from
          // `live` and would escape. Re-enumerate after the audit (no awaits in
          // the round, so a session cannot slip between enumeration and revoke)
          // until a round revokes nothing; capped so a broken invariant cannot spin.
          let count = 0
          for (let round = 0; round < 3; round += 1) {
            const pending = [...store.sessions.values()].filter(
              (session) => session.userId === target.id && session.revokedAt === null
            )
            if (pending.length === 0) break
            for (const session of pending) if (revokeSessionOnce(session)) count += 1
          }
          // Established WSS sessions bypass the platform, so the host ticket must die too.
          // Refreshing (not appending) moves `since` past any earlier grant marker,
          // so tickets issued after that marker are covered as well.
          appendRevocation('user', target.username, 'admin_force_offline')
          return count
        })
      } catch (failure) {
        // recordAudit already answered 503; the follower retries as leader instead.
        if (failure === USER_SESSION_REVOKE_AUDIT_FAILED) {
          return
        }
        throw failure
      }
      return json(res, 200, { ok: true, revokedSessions })
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
          installNonce: node.installNonce,
          port: node.port,
          online: now() - node.lastSeenAt <= relayAliveMs,
          lastSeenAt: node.lastSeenAt
        }))
      })
    }

    if (req.method === 'POST' && path === '/v1/relays/install-tokens') {
      const authed = requireAuth()
      if (!authed) return
      if (!isAdmin(authed.user)) {
        return denyPrivileged(res, traceId, authed.user, {
          eventType: 'install_download_token_create',
          targetType: 'install_script',
          permission: 'platform:admin'
        })
      }
      if (!auditAllowsMutations(res, traceId)) return
      if (
        !(await recordAudit(
          res,
          {
            eventType: 'install_download_token_create',
            actor: authed.user.username,
            targetType: 'install_script',
            targetId: 'relay.sh',
            result: 'success',
            traceId,
            metadata: { type: 'relay' }
          },
          traceId
        ))
      ) {
        return
      }
      // U115: relay.sh embeds the platform internal token, never a registration
      // token, so its download credential is platform-level (no host binding).
      return json(res, 201, issueInstallDownloadToken(authed.user, 'relay', null))
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
        hosts: [...store.hosts.values()].map((h) => {
          // U79 additive: the host↔relay binding, invisible to clients that
          // predate the fields. relayOnline is "a live relay serves routes" —
          // routes sync to every relay, so no healthy relay breaks the relay
          // path of every bound host at once.
          const route = h.relayRoute ? store.relayRoutes.get(h.relayRoute) : undefined
          const online = hostOnline(h)
          // U146/U151: freshness is independent of `online` — an offline host's
          // leftover route must still age out against the beat constant.
          const freshness = evaluateRelayRouteFreshness({
            route,
            directAddrs: h.directAddrs,
            now: now(),
            hostOfflineMs
          })
          return {
            ...h,
            credentialHash: undefined,
            online,
            browserEntryUrl: browserEntryUrlFor(h.relayRoute),
            relayTarget: route?.target ?? null,
            ...freshness,
            relayOnline: relayNodes.healthy(now(), relayAliveMs).length > 0
          }
        })
      })
    }

    if (req.method === 'GET' && path === '/v1/hosts/available') {
      const authed = requireAuth()
      if (!authed) return
      // Deliberately credential-free: developers may pick a host, not inspect one.
      // `provisionAllowed`/`accessLevel` are additive: an old client ignores them
      // and keeps its pre-grant behaviour; every other field stays byte-identical.
      const admin = isAdmin(authed.user)
      return json(res, 200, {
        hosts: [...store.hosts.values()].map((h) => ({
          id: h.id,
          name: h.name,
          online: hostOnline(h),
          provisionable: Boolean(h.projectsRoot),
          projectDirs: h.projectDirs ?? [],
          // U65/U67: creation needs projectsRoot AND the provision bit (admin
          // bypass); the legacy policy no longer gates.
          provisionAllowed:
            Boolean(h.projectsRoot) && canCreateProjectOnHost(store, h.id, authed.user, admin),
          accessLevel: admin ? null : hostAccessLevel(store, h.id, authed.user)
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
      const body = await readSensitiveWriteBody(req, res, traceId)
      if (!body) return
      const boundHostId =
        typeof body.hostId === 'string' && body.hostId.trim() ? body.hostId.trim() : null
      if (boundHostId && !store.hosts.has(boundHostId)) {
        return error(res, 404, 'HOST_NOT_FOUND', '主机不存在。', traceId)
      }
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
      // U115: the wizard one-liner must run on a machine with no session, so the
      // same response carries the one-time script-download credential.
      const download = issueInstallDownloadToken(authed.user, 'host', boundHostId)
      return json(res, 201, { token, expiresIn: 86400, ...download })
    }

    if (req.method === 'POST' && path === '/v1/hosts/register') {
      const bearer = req.headers.authorization?.slice(7) ?? ''
      const entry = store.hostTokens.find((t) => safeEqual(t.tokenHash, hashToken(bearer)))
      if (!entry || entry.usedAt || entry.expiresAt < now()) {
        return error(res, 401, 'HOST_TOKEN_INVALID', '注册令牌无效或已使用。', traceId)
      }
      // U250 tier 3: cross-version hosts share this wire. A body over the
      // register-specific cap is refused with 413 PAYLOAD_TOO_LARGE plus the
      // response traceId, so an old host's failure is diagnosable instead of a
      // silent disconnect. U252: register no longer reuses the 16 KiB command
      // cap, because the contract's 200 projectDirs can legitimately reach 52 KiB.
      const body = await readSensitiveWriteBody(req, res, traceId, REGISTER_BODY_MAX_BYTES)
      if (!body) return
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      // The token is single-use: refuse a nameless registration before spending it.
      if (name === '') {
        return error(res, 400, 'HOST_NAME_REQUIRED', 'name 为必填的主机标识。', traceId)
      }
      // U257: the name is indexed and audited; a 20k name used to 500 after the
      // token was spent. Refuse it while the token is still unused.
      if (name.length > HOST_NAME_MAX_CHARS) {
        audit.appendBestEffort({
          eventType: 'host_register',
          actor: 'agent',
          targetType: 'host',
          targetId: null,
          result: 'denied',
          traceId,
          metadata: { name: name.slice(0, HOST_NAME_MAX_CHARS), reason: 'HOST_NAME_INVALID' }
        })
        return error(
          res,
          400,
          'HOST_NAME_INVALID',
          `主机标识不能超过 ${HOST_NAME_MAX_CHARS} 个字符。`,
          traceId
        )
      }
      // U256: bound the root before the single-use token is spent. A 15,003-char
      // root is a field error (400), not an oversized-body refusal (413).
      if (
        typeof body.projectsRoot === 'string' &&
        body.projectsRoot.length > PROJECT_PATH_MAX_CHARS
      ) {
        audit.appendBestEffort({
          eventType: 'host_projects_root_rejected',
          actor: 'agent',
          targetType: 'host',
          targetId: null,
          result: 'failure',
          traceId,
          metadata: { reason: 'PROJECT_PATH_INVALID' }
        })
        return error(
          res,
          400,
          'PROJECTS_ROOT_INVALID',
          `主机项目根目录不能超过 ${PROJECT_PATH_MAX_CHARS} 个字符。`,
          traceId
        )
      }
      // U261 H8: an element check must run before the single-use token is spent.
      // A non-string reached `ipOfDirectAddr` and became a 500 after the spend.
      // U265: the URL parse check runs here too, still before the spend.
      if (
        body.directAddrs !== undefined &&
        (!Array.isArray(body.directAddrs) ||
          !body.directAddrs.every((addr) => typeof addr === 'string' && isDialableDirectAddr(addr)))
      ) {
        audit.appendBestEffort({
          eventType: 'host_register',
          actor: 'agent',
          targetType: 'host',
          targetId: null,
          result: 'denied',
          traceId,
          metadata: { reason: 'HOST_DIRECTADDRS_INVALID' }
        })
        return error(
          res,
          400,
          'HOST_DIRECTADDRS_INVALID',
          'directAddrs 必须是合法地址字符串数组。',
          traceId
        )
      }
      // U257: the body read yielded, so recheck here. Check and reserve are
      // synchronous, which is what closes the same-token registration race.
      if (entry.usedAt) {
        return error(res, 401, 'HOST_TOKEN_INVALID', '注册令牌无效或已使用。', traceId)
      }
      entry.usedAt = now()
      const existing = store.hostsByName.get(name)
      const zone = String(body.networkZone ?? 'intranet')
      // U143: a revoked host must not come back through name reuse. The token is
      // released only when the denial itself could not be audited.
      if (existing && existing.revokedAt !== null) {
        if (
          !(await recordAudit(
            res,
            {
              eventType: 'host_register',
              actor: 'agent',
              targetType: 'host',
              targetId: existing.id,
              result: 'denied',
              traceId,
              metadata: { name, reason: 'host_revoked' }
            },
            traceId
          ))
        ) {
          entry.usedAt = null
          return
        }
        return error(res, 409, 'HOST_REVOKED', '主机已被吊销，无法重新注册。', traceId)
      }
      const credential = randomBytes(32).toString('base64url')
      // U257: mutate a staged copy so a failed audit leaves the stored host and
      // the host index exactly as they were.
      const target: Host = existing
        ? { ...existing }
        : {
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
      // Write-ahead: the success event lands before any store mutation; a failed
      // audit releases the token so the host can retry instead of losing it.
      if (
        !(await recordAudit(
          res,
          {
            eventType: 'host_register',
            actor: 'agent',
            targetType: 'host',
            targetId: target.id,
            result: 'success',
            traceId,
            metadata: { name, zone }
          },
          traceId
        ))
      ) {
        entry.usedAt = null
        return
      }
      target.fingerprint = String(body.fingerprint ?? '')
      target.tlsFingerprint = String(body.tlsFingerprint ?? '') || null
      target.e2eePublicKey = String(body.e2eePublicKeyB64 ?? '')
      target.orcaVersion = String(body.orcaVersion ?? '')
      target.protocolVersion = Number(body.protocolVersion ?? 3)
      target.zone = zone
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
          version: store.policies.version,
          updatedAt: now()
        })
      }
      return json(res, 201, {
        hostId: target.id,
        credential,
        policyVersion: store.policies.version
      })
    }

    const hostAction = path.match(/^\/v1\/hosts\/([\w-]+)(\/[a-z-]+)?$/)
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
        // U251: a beat batches audit events, directories, and provision reports,
        // so it has its own cap instead of the 16 KiB single-command limit.
        const body = await readSensitiveWriteBody(req, res, traceId, HEARTBEAT_BODY_MAX_BYTES)
        if (!body) return
        // Bad addresses would be stored and later splice into every project view;
        // reject the beat before anything is persisted (U57 H14, U265).
        if (
          body.directAddrs !== undefined &&
          (!Array.isArray(body.directAddrs) ||
            !body.directAddrs.every(
              (addr) => typeof addr === 'string' && isDialableDirectAddr(addr)
            ))
        ) {
          return error(
            res,
            400,
            'HOST_DIRECTADDRS_INVALID',
            'directAddrs 必须是合法地址字符串数组。',
            traceId
          )
        }
        // U58 H12b: a typo used to be stored as offline, so a live host could be
        // reported dead. Only the two states a host may claim are accepted.
        if (body.status !== undefined && body.status !== 'online' && body.status !== 'offline') {
          return error(res, 400, 'HOST_STATUS_INVALID', 'status 仅支持 online/offline。', traceId)
        }
        // Why: a revoked host keeps its credential so this beat can deliver the
        // revocation; it must not look alive or accept any more reported state.
        // A refused root keeps the old one; the beat still answers so the host
        // can report why its own view of the root no longer matches.
        let projectsRootRejection: string | null = null
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
          // U147: the heartbeat heals registrations made without a version (a
          // registered host never re-registers). A beat without it keeps the value.
          if (typeof body.orcaVersion === 'string' && body.orcaVersion.length > 0) {
            target.orcaVersion = body.orcaVersion
          }
          if (typeof body.status === 'string' && target.status !== 'maintenance') {
            target.status = body.status === 'online' ? 'online' : 'offline'
          }
          projectsRootRejection = applyProjectsRoot(target, body.projectsRoot, traceId)
          applyProjectProvisionReports(target.id, body.provisioned, traceId)
          target.lastHeartbeatAt = now()
          // U146: an online beat confirms the route even when its target is unchanged.
          if (target.status === 'online' && target.relayRoute) {
            const confirmed = store.relayRoutes.get(target.relayRoute)
            if (confirmed) confirmed.updatedAt = now()
          }
        }
        // Why outside the revoked guard: a host's last refusal before it is cut
        // off still belongs in the chain, and this never fails the beat.
        // Why outside the revoked guard: a host's last refusal before it is cut
        // off still belongs in the chain, and this never fails the beat.
        appendHostAuditReports(
          audit,
          target,
          parseHostAuditReports(body.audit),
          traceId,
          resolveHostAuditActor
        )
        // §2.10.4 (U66-rfix NF-2): the host's own gap counters become visible
        // chain events; a beat without the field changes nothing.
        const auditGap = parseHostAuditGap(body.auditGap)
        if (auditGap) {
          noteHostAuditGap(target, auditGap, traceId)
        }
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
          ...(projectsRootRejection ? { projectsRootRejected: projectsRootRejection } : {}),
          // Same wire-additive guarantee as projectsRootRejected above (U21
          // precedent): an old host's sendHeartbeat whitelists the fields it knows
          // (cloud-host-enrollment.ts), so a key it has never heard of is structurally
          // invisible to it and its behaviour is byte-for-byte unchanged; the U37-B
          // executor picks it up via readField and parses it defensively.
          ...(provisionAssignments.length > 0 ? { provisionAssignments } : {}),
          // §2.9 (U66): declares the ingest understands the file-event families, so
          // a U68+ host gates delivery on this instead of the legacy absent-field
          // default; an old host's whitelist never sees the key at all.
          auditCapabilities: { fileEvents: true },
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
        // AA2: admins keep full power; a delegated subject needs the maintain bit.
        const viaHostGrant = !isAdmin(authed.user)
        if (viaHostGrant && !hasHostPermission(store, hostId, authed.user, 'maintain')) {
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
        const body = await readSensitiveWriteBody(req, res, traceId)
        if (!body) return
        // U58 H23 + U237: `enabled: "false"` used to enter maintenance, and a
        // missing `enabled` did too. Only a real boolean may steer this switch.
        if (typeof body.enabled !== 'boolean') {
          return error(res, 400, 'HOST_MAINTENANCE_INVALID', 'enabled 必须是布尔值（必填）。', traceId)
        }
        const nextStatus = body.enabled ? 'maintenance' : 'online'
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
              metadata: {
                enabled: nextStatus === 'maintenance',
                // U254: a 16 KiB note would push the event past the writer's 16 KiB cap.
                reason: nextReason.slice(0, AUDIT_REASON_MAX_CHARS),
                ...(viaHostGrant ? { via: 'host_grant' } : {})
              }
            },
            traceId
          ))
        ) {
          return
        }
        target.status = nextStatus
        // U58 H24c: the reason belongs to the window, not to the host.
        target.maintenanceReason = nextStatus === 'maintenance' ? nextReason : null
        return json(res, 200, { status: target.status })
      }

      // ---- host grants (AA2): platform-only delegation, never sent to the host ----
      if (req.method === 'GET' && action === '/grants') {
        if (!authed) {
          return error(res, 401, 'SESSION_EXPIRED', '登录已过期，请重新登录。', traceId)
        }
        if (!isAdmin(authed.user)) {
          // AC-18 + U62 B11: a read refusal gets a read event type, not the
          // write type the refused caller never reached.
          return denyPrivileged(res, traceId, authed.user, {
            eventType: 'host_grant_read',
            targetType: 'host',
            targetId: hostId,
            permission: 'platform:admin',
            metadata: { hostId }
          })
        }
        // User rows carry the username so the console names who was granted.
        return json(res, 200, {
          grants: store.hostGrants
            .filter((g) => g.hostId === hostId)
            .map((g) => {
              if (g.subjectType !== 'user') return g
              const user = store.users.get(g.subjectId)
              return user ? { ...g, username: user.username } : g
            })
        })
      }

      if (req.method === 'PUT' && action === '/grants') {
        if (!authed) {
          return error(res, 401, 'SESSION_EXPIRED', '登录已过期，请重新登录。', traceId)
        }
        if (!isAdmin(authed.user)) {
          // AC-18: a refused host grant write is a 403 *and* an audit event.
          // U62 G4: the event names the refused subject, so the body is read
          // here even though the caller never reaches the mutation.
          const body = await readJsonWithRes(req, res, DENIED_AUDIT_BODY_MAX_BYTES)
          return denyPrivileged(res, traceId, authed.user, {
            eventType: 'host_grant_update',
            targetType: 'host',
            targetId: hostId,
            permission: 'platform:admin',
            metadata: {
              ...deniedGrantMetadata(body, hostId),
              ...deniedHostGrantRevocationFields(body, hostId)
            }
          })
        }
        if (!auditAllowsMutations(res, traceId)) return
        const body = await readSensitiveWriteBody(req, res, traceId)
        if (!body) return
        // U62 B12: the contract is user|group; anything else is a caller bug
        // and must be refused, never silently stored as a user row.
        if (
          body.subjectType !== undefined &&
          body.subjectType !== 'user' &&
          body.subjectType !== 'group'
        ) {
          return error(
            res,
            400,
            'HOST_GRANT_SUBJECT_TYPE_INVALID',
            'subjectType 只支持 user 或 group。',
            traceId
          )
        }
        const subjectType = body.subjectType === 'group' ? 'group' : 'user'
        const submitted = String(body.subjectId ?? '').trim()
        // Same contract as project grants: malformed input must never delete a row.
        if (!Array.isArray(body.permissions)) {
          return error(
            res,
            400,
            'HOST_GRANT_PERMISSION_INVALID',
            '主机权限位不在允许范围内。',
            traceId
          )
        }
        const submittedPermissions: unknown[] = body.permissions
        // PUT replaces the whole row: one bad bit rejects the row, never partially stores it.
        const permissions = submittedPermissions.filter(
          (permission): permission is HostPermission =>
            typeof permission === 'string' && HOST_PERMISSION_SET.has(permission)
        )
        if (permissions.length !== submittedPermissions.length) {
          return error(
            res,
            400,
            'HOST_GRANT_PERMISSION_INVALID',
            '主机权限位不在允许范围内。',
            traceId
          )
        }
        // Same resolver as project grants (AA1): ids and exact group names only.
        const resolved = resolveGrantSubject(store, subjectType, submitted)
        if (!resolved.ok) {
          return error(res, 400, resolved.code, resolved.message, traceId)
        }
        const subjectId = resolved.subjectId
        const username = resolved.subjectType === 'user' ? resolved.username : null
        const previous = store.hostGrants.find(
          (g) => g.hostId === hostId && g.subjectType === subjectType && g.subjectId === subjectId
        )
        const removedPermissions = (previous?.permissions ?? []).filter(
          (permission) => !permissions.includes(permission)
        )
        // Shrink is judged on effective bits, not the row: a bit still supplied
        // by another row is not lost, and an added bit never revokes (§3.3).
        const rowsAfter = store.hostGrants.filter(
          (g) =>
            !(g.hostId === hostId && g.subjectType === subjectType && g.subjectId === subjectId)
        )
        if (permissions.length > 0) {
          rowsAfter.push({ hostId, subjectType, subjectId, permissions })
        }
        const revokedUsers = hostGrantSubjectUsers(subjectType, subjectId).filter((user) => {
          const after = hostBitsFromRows(rowsAfter, hostId, user)
          return [...hostBits(store, hostId, user)].some((bit) => !after.has(bit))
        })
        if (
          !(await recordAudit(
            res,
            {
              eventType: 'host_grant_update',
              actor: authed.user.username,
              targetType: 'host',
              targetId: hostId,
              result: 'success',
              traceId,
              metadata: {
                hostId,
                subjectType,
                subjectId,
                ...(username ? { username } : {}),
                permissions,
                accessLevel: hostLevelFromBits(new Set(permissions)),
                removedPermissions,
                revokedUsers: revokedUsers.length
              }
            },
            traceId
          ))
        ) {
          return
        }
        store.hostGrants = store.hostGrants.filter(
          (g) =>
            !(g.hostId === hostId && g.subjectType === subjectType && g.subjectId === subjectId)
        )
        if (permissions.length > 0) {
          store.hostGrants.push({ hostId, subjectType, subjectId, permissions })
        }
        // Host bits are platform-only, but tickets already minted carry the old
        // effective set; revoking the affected users closes them within the
        // heartbeat window (U65 §3.3 / AC-38).
        for (const user of revokedUsers) {
          revokeUserCredentials(user.username, 'host_grant_changed')
        }
        return json(res, 200, { ok: true })
      }

      if (req.method === 'PUT' && action === '/provision-policy') {
        if (!authed) {
          return error(res, 401, 'SESSION_EXPIRED', '登录已过期，请重新登录。', traceId)
        }
        if (!isAdmin(authed.user)) {
          // U62 G4: the refused event records the attempted mode, so the body
          // is read for the record even though the caller never gets a write.
          const body = await readJsonWithRes(req, res, DENIED_AUDIT_BODY_MAX_BYTES)
          return denyPrivileged(res, traceId, authed.user, {
            eventType: 'host_provision_policy_update',
            targetType: 'host',
            targetId: hostId,
            permission: 'platform:admin',
            metadata: {
              hostId,
              mode: typeof body.mode === 'string' ? body.mode : ''
            }
          })
        }
        if (!auditAllowsMutations(res, traceId)) return
        const body = await readSensitiveWriteBody(req, res, traceId)
        if (!body) return
        const mode = body.mode
        if (mode !== 'open' && mode !== 'restricted') {
          return error(
            res,
            400,
            'HOST_PROVISION_POLICY_INVALID',
            '自助建项目策略只能是 open 或 restricted。',
            traceId
          )
        }
        if (
          !(await recordAudit(
            res,
            {
              eventType: 'host_provision_policy_update',
              actor: authed.user.username,
              targetType: 'host',
              targetId: hostId,
              result: 'success',
              traceId,
              metadata: { hostId, mode }
            },
            traceId
          ))
        ) {
          return
        }
        target.provisionPolicy = mode
        return json(res, 200, { hostId, mode })
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

    // ---- audit: file event ingress (U66 §2.10) ----
    if (req.method === 'POST' && path === '/v1/internal/audit/file-events') {
      const token = req.headers['x-internal-token']
      if (token !== internalToken) {
        return error(res, 401, 'INTERNAL_TOKEN_INVALID', '内部令牌无效。', traceId)
      }
      const outcome = await recordFileEvent(await readInternalBody(req, res), traceId)
      if (outcome.retryAfter) res.setHeader('retry-after', '60')
      return json(res, outcome.status, outcome.body)
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
      const parsedQuery = parseAuditQuery(url.searchParams, now())
      if (!parsedQuery.ok) {
        return error(res, 400, parsedQuery.code, parsedQuery.message, traceId)
      }
      const {
        limit,
        actor,
        eventType,
        eventTypes,
        result,
        traceId: queryTraceId,
        fileName,
        keyword,
        since: querySince,
        until,
        username,
        projectId,
        hostId
      } = parsedQuery.value
      // U58 U13: `Number()` accepted "1e3"/"1.5" and NaN was silently dropped;
      // cursor is an event seq, so only decimal non-negative integers are valid.
      const rawCursor = url.searchParams.get('cursor')
      const cursor =
        rawCursor === null
          ? undefined
          : /^\d+$/.test(rawCursor) && Number.isSafeInteger(Number(rawCursor))
            ? Number(rawCursor)
            : null
      if (cursor === null) {
        return error(res, 400, 'INVALID_QUERY', 'cursor 必须是十进制非负整数。', traceId)
      }
      const page = await audit.query({
        actor,
        eventType,
        eventTypes,
        result,
        traceId: queryTraceId,
        since: querySince,
        until,
        fileName,
        keyword,
        username,
        projectId,
        hostId,
        limit,
        cursor
      })
      return json(res, 200, page)
    }

    // ---- audit: export acceptance (U202 E5) ----
    // Sync work only: validate, quota, record acceptance, then persist the queued
    // job. The worker (E6) drains the job; status/download endpoints are E7/E8.
    if (req.method === 'POST' && path === '/v1/audit/export') {
      // Every exit here is a token-bearing, per-request answer — never cached.
      res.setHeader('cache-control', 'no-store')
      const authed = requireAuth()
      if (!authed) {
        return
      }
      if (!isAdmin(authed.user) && !authed.user.roles.includes('platform:auditor')) {
        return denyPrivileged(res, traceId, authed.user, {
          eventType: 'audit_export',
          targetType: 'audit',
          permission: 'platform:auditor'
        })
      }

      const body = await readSensitiveWriteBody(req, res, traceId)
      if (!body) return
      if (body.confirm !== true) {
        return error(res, 400, 'EXPORT_CONFIRM_REQUIRED', '审计导出需要二次确认。', traceId)
      }
      const format = body.format
      if (format !== 'csv' && format !== 'jsonl') {
        return error(res, 400, 'INVALID_QUERY', 'format 仅支持 csv/jsonl。', traceId)
      }

      // Map the same-named body filters onto the shared parser so the export
      // filter semantics cannot drift from GET /v1/audit/events.
      const params = new URLSearchParams()
      if (body.eventTypes !== undefined) {
        if (
          !Array.isArray(body.eventTypes) ||
          body.eventTypes.some((type) => typeof type !== 'string')
        ) {
          return error(res, 400, 'INVALID_QUERY', 'eventTypes 必须是字符串数组。', traceId)
        }
        params.set('eventTypes', body.eventTypes.join(','))
      }
      const stringFilters = [
        'eventFamily',
        'eventType',
        'actor',
        'username',
        'projectId',
        'hostId',
        'fileName',
        'q',
        'keyword',
        'result',
        'traceId',
        'since'
      ] as const
      for (const key of stringFilters) {
        const value = body[key]
        if (value === undefined) {
          continue
        }
        if (typeof value !== 'string') {
          return error(res, 400, 'INVALID_QUERY', `${key} 必须是字符串。`, traceId)
        }
        params.set(key, value)
      }
      const nowMs = now()
      const rawUntil = body.until
      if (rawUntil !== undefined && typeof rawUntil !== 'string') {
        return error(res, 400, 'INVALID_QUERY', 'until 必须是字符串。', traceId)
      }
      if (rawUntil !== undefined) {
        const requestedUntil = Date.parse(rawUntil)
        if (Number.isNaN(requestedUntil)) {
          return error(res, 400, 'INVALID_QUERY', 'until 不是有效时间。', traceId)
        }
        // Clamp a future until; freezing below also caps an absent until at now.
        params.set('until', new Date(Math.min(requestedUntil, nowMs)).toISOString())
      }
      const parsedQuery = parseAuditQuery(params, nowMs)
      if (!parsedQuery.ok) {
        return error(res, 400, parsedQuery.code, parsedQuery.message, traceId)
      }
      // Freeze the exported set at acceptance: the worker must not page past what
      // the caller saw. Defaults stay q/fileName → 7d, everything else 31d.
      const frozenUntil = Math.min(parsedQuery.value.until ?? nowMs, nowMs)
      const recent =
        parsedQuery.value.keyword !== undefined || parsedQuery.value.fileName !== undefined
      parsedQuery.value.since =
        parsedQuery.value.since ?? frozenUntil - (recent ? AUDIT_RECENT_WINDOW_MS : AUDIT_WINDOW_MS)
      parsedQuery.value.until = frozenUntil

      const slot = reserveAuditExportSlot(authed.user.id)
      if (!slot.ok) {
        return error(res, 429, 'EXPORT_BUSY', '导出任务过多，请稍后再试。', traceId, {
          reason: slot.reason
        })
      }

      try {
        // F12: mint the id and record acceptance *before* the job directory
        // exists, so a crash can never leave an export that is not on the chain.
        const jobId = generateAuditExportJobId()
        const deleteAfterDownload = body.deleteAfterDownload === true
        try {
          await audit.append({
            eventType: 'audit_export',
            actor: authed.user.username,
            targetType: 'audit',
            targetId: jobId,
            result: 'success',
            traceId,
            metadata: {
              jobId,
              phase: 'accepted',
              format,
              query: parsedQuery.value,
              limits: {
                maxEvents: DEFAULT_AUDIT_EXPORT_MAX_EVENTS,
                maxBytes: DEFAULT_AUDIT_EXPORT_MAX_BYTES
              },
              expiresAt: nowMs + auditExportStore.ttlMs,
              deleteAfterDownload
            }
          })
        } catch {
          // Fail closed: without an acceptance record the job must not exist.
          return error(
            res,
            500,
            'EXPORT_AUDIT_UNAVAILABLE',
            '审计日志不可写，导出任务未创建。',
            traceId
          )
        }

        let job: AuditExportJob
        try {
          job = auditExportStore.create({
            jobId,
            requestedBy: authed.user.id,
            requestedByUsername: authed.user.username,
            query: parsedQuery.value,
            format,
            deleteAfterDownload
          })
        } catch {
          // Best effort: the 500 is the client-visible contract; never mask it.
          try {
            await audit.append({
              eventType: 'audit_export',
              actor: authed.user.username,
              targetType: 'audit',
              targetId: jobId,
              result: 'failure',
              traceId,
              metadata: { jobId, phase: 'accepted', format, errorCode: 'EXPORT_CREATE_FAILED' }
            })
          } catch {
            // The acceptance event is already on the chain; nothing else to do.
          }
          return error(res, 500, 'EXPORT_CREATE_FAILED', '导出任务创建失败。', traceId)
        }

        json(res, 202, {
          jobId: job.jobId,
          status: job.status,
          format: job.format,
          requestedAt: job.createdAt,
          expiresAt: job.expiresAt
        })
        // Response is written; run the job outside this handler so a slow export
        // or worker fault can never alter the accepted 202.
        scheduleAuditExportRun()
        return
      } finally {
        slot.release()
      }
    }

    // ---- audit: export status (U202 E7) ----
    // Ownership is the creator only (admins/auditors included): a foreign or
    // unknown id is the same 404, so this cannot probe job existence.
    const exportStatus = path.match(/^\/v1\/audit\/exports\/([^/]+)$/)
    if (req.method === 'GET' && exportStatus) {
      // The success response carries a fresh download token — never cached.
      res.setHeader('cache-control', 'no-store')
      const authed = requireAuth()
      if (!authed) {
        return
      }
      if (!isAdmin(authed.user) && !authed.user.roles.includes('platform:auditor')) {
        return denyPrivileged(res, traceId, authed.user, {
          eventType: 'audit_export',
          targetType: 'audit',
          permission: 'platform:auditor'
        })
      }
      const job = auditExportStore.read(exportStatus[1])
      if (!job || job.requestedBy !== authed.user.id) {
        return error(res, 404, 'EXPORT_NOT_FOUND', '导出任务不存在。', traceId)
      }
      if (auditExportStore.isExpired(job)) {
        return error(res, 410, 'EXPORT_EXPIRED', '导出任务已过期。', traceId)
      }

      const body: Record<string, unknown> = {
        jobId: job.jobId,
        status: job.status,
        format: job.format,
        requestedAt: job.createdAt,
        expiresAt: job.expiresAt
      }
      if (job.startedAt !== null) body.startedAt = job.startedAt
      if (job.finishedAt !== null) body.finishedAt = job.finishedAt
      if (job.totalEvents !== null) body.totalEvents = job.totalEvents
      if (job.bytes !== null) body.bytes = job.bytes
      if (job.error !== null) body.error = job.error

      if (job.status === 'succeeded') {
        // Every status read rotates the hash, invalidating the previous link.
        const issued = auditExportStore.issueDownloadToken(job.jobId, {
          ttlMs: auditExportTokenTtlMs
        })
        if (issued) {
          body.downloadUrl = `/v1/audit/exports/${job.jobId}/download?token=${encodeURIComponent(issued.token)}`
        } else if (job.deleteAfterDownload && job.downloadedAt !== null) {
          // The artifact was removed after the first download; report why no
          // link is sent instead of failing the status poll.
          body.downloaded = true
          body.downloadUnavailableReason = 'deleted_after_download'
        } else {
          return error(res, 410, 'EXPORT_EXPIRED', '导出任务已过期。', traceId)
        }
      }
      return json(res, 200, body)
    }

    // ---- audit: export download (U202 E8) ----
    // The link is self-contained: `token` is the credential, so no Bearer is
    // accepted and no role gate runs here (§2.3). Because expiry is checked
    // before the token, 410 vs 404 tells a caller whether a known id is expired
    // or live/unknown; ids are 96-bit random and only the owner receives them.
    const exportDownload = path.match(/^\/v1\/audit\/exports\/([^/]+)\/download$/)
    if (req.method === 'GET' && exportDownload) {
      res.setHeader('cache-control', 'no-store')
      const jobId = exportDownload[1]
      const job = auditExportStore.read(jobId)
      if (!job) {
        return error(res, 404, 'EXPORT_NOT_FOUND', '导出任务不存在。', traceId)
      }
      if (auditExportStore.isExpired(job)) {
        return error(res, 410, 'EXPORT_EXPIRED', '导出任务已过期。', traceId)
      }
      // Redemption is atomic and marks the token used before any byte is sent.
      const token = url.searchParams.get('token')
      if (token === null) {
        // No credential: answer as unknown. Expiry was checked first, so an
        // expired job still answers 410 above.
        return error(res, 404, 'EXPORT_NOT_FOUND', '导出任务不存在。', traceId)
      }
      // Resolve the artifact before redeeming the token: a missing/corrupt file
      // must not consume a one-shot link nor write a success audit event.
      const artifactPath = resolveAuditExportObjectPath(
        auditExportStore.root,
        job.jobId,
        job.format
      )
      if (!artifactPath) {
        return error(res, 410, 'EXPORT_DOWNLOAD_GONE', '导出产物已不可用。', traceId)
      }
      let artifactBytes: number
      try {
        // lstat rejects a symlink squatted on the artifact name.
        const info = await lstat(artifactPath)
        if (!info.isFile()) {
          throw new Error('artifact is not a regular file')
        }
        artifactBytes = info.size
      } catch {
        return error(res, 410, 'EXPORT_DOWNLOAD_GONE', '导出产物已不可用。', traceId)
      }
      const consumed = auditExportStore.consumeDownloadToken(jobId, token)
      if (!consumed.ok) {
        switch (consumed.reason) {
          case 'expired':
            return error(res, 410, 'EXPORT_EXPIRED', '导出任务已过期。', traceId)
          default:
            return error(res, 404, 'EXPORT_NOT_FOUND', '导出任务不存在。', traceId)
        }
      }
      // Audit before sending: a download that cannot be recorded must not
      // happen (fail-closed, like export creation). Never log the token; the
      // job id is the correlation key.
      try {
        await audit.append({
          eventType: 'audit_export_download',
          actor: job.requestedByUsername,
          targetType: 'audit',
          targetId: job.jobId,
          result: 'success',
          traceId,
          metadata: {
            jobId: job.jobId,
            format: job.format,
            totalEvents: job.totalEvents,
            bytes: job.bytes
          }
        })
      } catch {
        return error(res, 500, 'EXPORT_AUDIT_UNAVAILABLE', '审计日志不可写，下载已取消。', traceId)
      }
      res.writeHead(200, {
        ...STATIC_SECURITY_HEADERS,
        'content-type':
          job.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
        'content-disposition': `attachment; filename="audit-export-${job.jobId}.${job.format}"`,
        'content-length': String(artifactBytes),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff'
      })
      const stream = createReadStream(artifactPath)
      stream.on('error', () => {
        // Headers are already out; abort rather than leave a truncated 200.
        res.destroy()
      })
      if (job.deleteAfterDownload) {
        res.once('finish', () => {
          // Keep job.json for polling; only the one-shot artifact is removed.
          void rm(artifactPath, { force: true }).catch((error: unknown) => {
            console.error('[audit-export] artifact delete failed:', error)
          })
        })
      }
      stream.pipe(res)
      return
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
      // The summary comes from the writer in production; an unreachable writer
      // must not hide the health verdict this endpoint already served (AC-26).
      let summary: AuditSummary | null = null
      try {
        summary = await audit.summary()
      } catch {
        summary = null
      }
      return json(res, 200, {
        ...health,
        persisted: auditLogPath !== null,
        ...(summary === null
          ? {}
          : { chain: summary.chain, gaps: summary.gaps, capacity: summary.capacity }),
        // Ingress-side counters, separate from the writer's host-reported gaps.
        ingressGaps: {
          droppedTotal: fileEventGap.dropped,
          rateLimitedTotal: fileEventGap.rateLimited,
          suppressedTotal: fileEventGap.suppressed,
          lastGapAt: fileEventGap.lastGapAt
        },
        // U78 additive: the authoritative eventType catalog, so the console's
        // 操作类型 dropdown derives from the server instead of drifting from it.
        eventTypes: [...AUDIT_EVENT_TYPES],
        // U201 E10 additive capability probe: clients call export only when listed.
        auditExport: {
          formats: Object.keys(AUDIT_EXPORT_OBJECT_KEYS),
          maxWindowDays: AUDIT_WINDOW_MS / 86_400_000,
          maxRows: DEFAULT_AUDIT_EXPORT_MAX_EVENTS,
          maxBytes: DEFAULT_AUDIT_EXPORT_MAX_BYTES,
          jobTtlSeconds: auditExportStore.ttlMs / 1000,
          downloadTokenTtlSeconds: auditExportTokenTtlMs / 1000
        }
      })
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
        const body = await readSensitiveWriteBody(req, res, traceId)
        if (!body) return
        // U58 Y14 + U237: an unknown or missing value used to be coerced to
        // `deny`, silently changing the platform policy. Refuse it instead.
        if (body.downloadDefault !== 'allow' && body.downloadDefault !== 'deny') {
          return error(res, 400, 'POLICY_INVALID', 'downloadDefault 仅支持 allow/deny。', traceId)
        }
        const nextDefault = body.downloadDefault === 'allow' ? 'allow' : 'deny'
        const rate = parseReadRate(body.readRatePerHour)
        if (rate.kind === 'invalid' || rate.kind === 'clear') {
          return error(res, 400, 'POLICY_INVALID', '读取限速必须是大于 0 的 calls/bytes。', traceId)
        }
        return withPolicyWriteLock(async () => {
          // U136④a: a stale admin must not silently overwrite a newer policy.
          const expectedVersion = parseExpectedVersion(body.expectedVersion)
          if (expectedVersion.kind === 'invalid') {
            return error(res, 400, 'POLICY_INVALID', 'expectedVersion 必须是非负整数。', traceId)
          }
          if (
            expectedVersion.kind === 'set' &&
            expectedVersion.version !== store.policies.version
          ) {
            if (
              !(await recordAudit(
                res,
                {
                  eventType: 'policy_update',
                  actor: authed.user.username,
                  targetType: 'policy',
                  targetId: 'download',
                  result: 'failure',
                  traceId,
                  metadata: {
                    reason: 'POLICY_VERSION_CONFLICT',
                    expectedVersion: expectedVersion.version,
                    resultVersion: store.policies.version,
                    downloadDefault: store.policies.downloadDefault
                  }
                },
                traceId
              ))
            ) {
              return
            }
            return error(
              res,
              409,
              'POLICY_VERSION_CONFLICT',
              '下载策略已被他人修改，请刷新后重试。',
              traceId,
              {
                version: store.policies.version,
                downloadDefault: store.policies.downloadDefault,
                readRatePerHour: store.policies.readRatePerHour
              }
            )
          }
          const resultVersion = store.policies.version + 1
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
                  ...(rate.kind === 'set' ? { readRatePerHour: rate.rate } : {}),
                  ...(expectedVersion.kind === 'set'
                    ? { expectedVersion: expectedVersion.version, resultVersion }
                    : {})
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
          store.policies.version = resultVersion
          return json(res, 200, {
            downloadDefault: store.policies.downloadDefault,
            readRatePerHour: store.policies.readRatePerHour,
            version: store.policies.version
          })
        })
      }
    }

    if (path === '/v1/internal/relay-endpoint' && req.method === 'POST') {
      const token = req.headers['x-internal-token']
      if (token !== internalToken) {
        return error(res, 401, 'INTERNAL_TOKEN_INVALID', '内部令牌无效。', traceId)
      }
      const body = await readInternalBody(req, res)
      const installNonce = parseInstallNonce(body)
      if (installNonce === null) {
        return error(
          res,
          400,
          'RELAY_INSTALL_NONCE_INVALID',
          '中继安装 nonce 无效（最多 128 个字母、数字、_ 或 -）。',
          traceId
        )
      }
      const registration = parseRelayRegistration(body)
      if (!registration) {
        return error(res, 400, 'RELAY_PORT_INVALID', '中继端口无效。', traceId)
      }
      relayPort = registration.port
      // Where clients dial this relay: what it announced, else the address it
      // registered from. A co-located test relay keeps today's 127.0.0.1.
      const source = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '')
      const node = relayNodes.register(
        { ...registration, installNonce, ...(registration.host ? {} : { host: source }) },
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
  async function handleWebHandoff(
    req: IncomingMessage,
    res: ServerResponse,
    user: User,
    project: Project,
    traceId: string,
    platformOrigin: string
  ): Promise<void> {
    const body = await readSensitiveWriteBody(req, res, traceId)
    if (!body) return
    // Additive wire field: an old console sends no body and keeps the pre-U46
    // entry, URL shape, status gates, and reply fields byte-for-byte.
    const surface = body.surface === 'admin' ? 'admin' : 'web'
    const adminSurface = surface === 'admin'
    // Same grant predicate as redemption: adminAccess only widens which projects
    // a caller can see, never the right to open one, so a code that could only
    // ever redeem 403 is refused here instead of minting a dead entry.
    if (!effectiveProjectPermissions(store, project, user, isAdmin(user)).includes('open')) {
      audit.appendBestEffort({
        eventType: 'web_handoff',
        actor: user.username,
        targetType: 'project',
        targetId: project.id,
        result: 'denied',
        traceId,
        metadata: { reason: 'permission_lost', surface }
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
    // The embedded workspace cannot render a project the host has not prepared,
    // so the admin surface carries the same readiness gate as /connect. The web
    // surface keeps the pre-U46 behavior: an old console's request never gets
    // these new refusals.
    if (adminSurface && project.status === 'failed') {
      return error(res, 409, 'PROJECT_NOT_PREPARED', '项目准备失败，暂无法打开。', traceId, {
        status: project.status,
        ...(project.provisioningError ? { provisioningError: project.provisioningError } : {})
      })
    }
    if (adminSurface && project.status === 'provisioning') {
      return error(res, 409, 'PROJECT_PROVISIONING', '项目正在准备中，请稍后重试。', traceId, {
        status: project.status
      })
    }
    // A live browser edge serves the page through the relay, so the host's own
    // direct address stops being a precondition (a relayed host may list none).
    const browserEntry = browserEntryUrlFor(host.relayRoute)
    const directAddr = host.directAddrs[0]
    if (browserEntry === '' && (!directAddr || !isDialableDirectAddr(directAddr))) {
      audit.appendBestEffort({
        eventType: 'web_handoff',
        actor: user.username,
        targetType: 'project',
        targetId: project.id,
        result: 'denied',
        traceId,
        metadata: { reason: 'host_unavailable', hostId: host.id, surface }
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
        ttlSeconds: Math.ceil(handoffTtlMs / 1000),
        surface
      }
    })
    const entry = browserEntry !== '' ? browserEntry : `https://${directAddr}/web-index.html`
    // The admin surface swaps the host-served page only: same origin, same code
    // hash, plus the iframe/project query the embedded workspace needs.
    const page = new URL(
      adminSurface ? entry.replace(/web-index\.html$/, 'cloud-admin.html') : entry
    )
    // The page is served by the host or relay, so `?api=` is how it finds the
    // platform to trade the code on (same channel as the admin session page).
    page.searchParams.set('api', platformOrigin)
    if (adminSurface) {
      page.searchParams.set('embed', '1')
      page.searchParams.set('project', project.id)
    }
    return json(res, 201, {
      url: `${page.toString()}#handoff=${code}&project=${project.id}`,
      expiresIn: Math.ceil(handoffTtlMs / 1000),
      // Echoed only when the caller opted in, so an old console's reply keeps
      // its exact pre-U46 field set.
      ...(typeof body.surface === 'string' ? { surface } : {})
    })
  }

  async function handleConnect(
    req: IncomingMessage,
    res: ServerResponse,
    user: User,
    project: Project,
    traceId: string
  ): Promise<void> {
    const body = await readSensitiveWriteBody(req, res, traceId)
    if (!body) return
    // Same predicate as /web-handoff: adminAccess widens which projects a caller
    // can see, never the right to open one; `open` is an explicit bit.
    const permissions = effectiveProjectPermissions(store, project, user, isAdmin(user))
    if (!permissions.includes('open')) {
      await audit.append({
        eventType: 'project_connect',
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

  /** Host grants reach groups through user.groups; a group edit must land on each member. */
  function hostGrantSubjectUsers(subjectType: 'user' | 'group', subjectId: string): User[] {
    if (subjectType === 'user') {
      const user = store.users.get(subjectId)
      return user ? [user] : []
    }
    return [...store.users.values()].filter((user) => user.groups.includes(subjectId))
  }

  let relayPort = 18080
  const relayNodes = createRelayNodeRegistry()
  const relayAliveMs = Number(process.env.ORCA_CLOUD_RELAY_ALIVE_MS ?? RELAY_ALIVE_DEFAULT_MS)

  const webReleases = createWebReleaseStore({
    webRoot: config.webRoot ?? WEB_ROOT,
    ...(config.webReleaseArchiveDir ? { archiveDir: config.webReleaseArchiveDir } : {})
  })
  webReleases.archive()

  // U197 S6 / U224: report-only CSP, HTML documents only; `off` rolls back without a redeploy.
  const documentCspReportOnly =
    (process.env.ORCA_CLOUD_CSP_REPORT_ONLY ?? '').trim().toLowerCase() === 'off'
      ? undefined
      : STATIC_CSP_REPORT_ONLY
  const isHtmlDocument = (name: string): boolean => name.toLowerCase().endsWith('.html')

  /** Hashed assets are immutable; the hashed path is what makes an old page keep working. */
  function serveAsset(path: string, req: IncomingMessage, res: ServerResponse): boolean {
    // Nested names (router/routes.js) resolve the same way flat ones do.
    const match = path.match(/^\/assets\/([0-9a-f]{6,32})\/([\w./-]+)$/)
    if (!match) {
      return false
    }
    const asset = webReleases.resolve(match[1], match[2])
    if (!asset) {
      return false
    }
    sendStaticAsset(
      req,
      res,
      {
        name: asset.name,
        contentType: asset.contentType,
        cacheControl: STATIC_HASHED_CACHE_CONTROL,
        etag: `"${asset.sha256}"`,
        body: asset.bytes
      },
      isHtmlDocument(asset.name) ? documentCspReportOnly : undefined
    )
    return true
  }

  async function serveStatic(
    path: string,
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    if (serveAsset(path, req, res)) {
      return
    }
    let decoded: string
    try {
      decoded = decodeURIComponent(path)
    } catch (err) {
      // U58 W5: a malformed escape is a bad path, not a server fault — 404, no stack.
      if (err instanceof URIError) {
        sendStaticNotFound(res)
        return
      }
      throw err
    }
    const rel = path === '/' ? 'index.html' : decoded.replace(/^\//, '')
    // Release keys are posix names; normalize() would produce backslashes on Windows.
    const name = normalize(rel)
      .replace(/^(\.\.[/\\])+/, '')
      .replace(/\\/g, '/')
    const current = webReleases.current().files.get(name)
    if (current) {
      // Why no-cache on the entry point: a deploy must be picked up, but an
      // ETag revalidation keeps the cost at a 304.
      const isEntry = name === 'index.html'
      res.setHeader('x-orca-web-build', webReleases.current().build)
      sendStaticAsset(
        req,
        res,
        {
          name,
          contentType: current.contentType,
          cacheControl: isEntry ? STATIC_HTML_CACHE_CONTROL : STATIC_UNHASHED_CACHE_CONTROL,
          etag: `"${current.sha256}"`,
          body: isEntry ? Buffer.from(webReleases.indexHtml()) : current.bytes
        },
        isHtmlDocument(name) ? documentCspReportOnly : undefined
      )
      return
    }
    try {
      const target = join(config.webRoot ?? WEB_ROOT, name)
      const [fileStat, data] = await Promise.all([stat(target), readFile(target)])
      sendStaticAsset(
        req,
        res,
        {
          name,
          contentType: 'text/html; charset=utf-8',
          cacheControl: cacheControlForStaticName(name),
          etag: weakStaticEtag(fileStat.size, fileStat.mtimeMs),
          body: data
        },
        // The fallback labels every file text/html; the policy must follow the name.
        isHtmlDocument(name) ? documentCspReportOnly : undefined
      )
    } catch {
      sendStaticNotFound(res)
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
    auditExportStore,
    auditExportWorker,
    get signingKey() {
      return signingKeys.current()
    },
    close: async () => {
      auditExportSweep.stop()
      auditExportCleanup.stop()
      storePersistence?.flushNow()
      storePersistence?.stop()
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
  const installDownloadTtlMs = ttlFromEnv('ORCA_CLOUD_INSTALL_DOWNLOAD_TTL_MS')
  const app = createApp({
    port: Number(process.env.PORT ?? 18787),
    ...(accessTtlMs === undefined ? {} : { accessTtlMs }),
    ...(refreshTtlMs === undefined ? {} : { refreshTtlMs }),
    ...(handoffTtlMs === undefined ? {} : { handoffTtlMs }),
    ...(installDownloadTtlMs === undefined ? {} : { installDownloadTtlMs }),
    ...(process.env.ORCA_CLOUD_LOGIN_LOCKOUT_URL
      ? { loginLockoutUrl: process.env.ORCA_CLOUD_LOGIN_LOCKOUT_URL }
      : {}),
    ...(process.env.ORCA_CLOUD_LDAP_REQUIRED_GROUP
      ? { ldapRequiredGroup: process.env.ORCA_CLOUD_LDAP_REQUIRED_GROUP }
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
