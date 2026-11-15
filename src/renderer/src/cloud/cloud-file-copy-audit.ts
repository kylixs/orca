import { readField } from '../../../shared/json-fields'
import type { CloudRpc } from '../../../shared/cloud-file-browser'
import { createBrowserUuid } from '@/lib/browser-uuid'

/**
 * U66 §2.10 `audit.recordFileEvent` client seam for the web workspace.
 *
 * The host fills device/subject/host/project/captureConfidence (§2.10.2); this
 * module only declares the action. Reporting is best-effort: a refused or
 * dropped RPC never blocks the clipboard, and nothing is retried.
 */

export const CLOUD_FILE_EVENT_METHOD = 'audit.recordFileEvent'

/** Same budget as the host (§2.10.2); beyond it we drop instead of hammering. */
export const CLOUD_FILE_COPY_RATE_LIMIT = 120
export const CLOUD_FILE_COPY_RATE_WINDOW_MS = 60_000
const DUPLICATE_COPY_WINDOW_MS = 1_500

export type CloudFileAuditSurface = 'desktop' | 'web' | 'admin-embed'
export type CloudFileCopyKind = 'content-whole' | 'content-selection' | 'file-object'
export type CloudFileCopyCapturePoint =
  | 'web-clipboard-api'
  | 'desktop-clipboard-ipc'
  | 'dom-copy-listener'
export type CloudFileCopyFailureReason = 'clipboard_denied' | 'clipboard_write_failed'

export type CloudFileCopyInput = {
  path: string
  /** Copied text. Only hashed/counted; never serialized onto the wire (FR-9.16). */
  text: string
  copyKind: CloudFileCopyKind
  capturePoint: CloudFileCopyCapturePoint
  sizeBytes?: number
  mime?: string
  isBinary?: boolean
  surface?: CloudFileAuditSurface
}

export type CloudFileCopyFailureInput = Omit<CloudFileCopyInput, 'text'> & {
  text?: string
  reason: CloudFileCopyFailureReason
}

export type CloudFileAuditSkipReason =
  | 'non-cloud-session'
  | 'rate-limited'
  | 'duplicate'
  | 'empty'
  | 'rpc-failed'
  | 'host-rejected'

export type CloudFileAuditResult =
  | { reported: true }
  | { reported: false; reason: CloudFileAuditSkipReason }

/** The admin console iframe is a distinct `surface` (§2.2/§2.3); the desktop shell its own. */
export function cloudFileAuditSurface(search?: string): CloudFileAuditSurface {
  const query = search ?? (typeof window === 'undefined' ? '' : (window.location?.search ?? ''))
  if (new URLSearchParams(query).get('embed') === '1') {
    return 'admin-embed'
  }
  // Positive desktop signal only: the full client's preload API without the web flag.
  // Browsers and tests have neither, so they stay 'web'.
  const desktop =
    (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ !== true &&
    typeof window !== 'undefined' &&
    typeof window.api?.ui?.writeClipboardText === 'function'
  return desktop ? 'desktop' : 'web'
}

/** Where the copy actually wrote, so the audit names the real seam (§2.3). */
export function cloudCopyCapturePoint(
  surface: CloudFileAuditSurface
): Extract<CloudFileCopyCapturePoint, 'web-clipboard-api' | 'desktop-clipboard-ipc'> {
  return surface === 'desktop' ? 'desktop-clipboard-ipc' : 'web-clipboard-api'
}

export function cloudFileBaseName(relativePath: string): string {
  return relativePath.split(/[\\/]/).at(-1) ?? relativePath
}

/** UTF-8 byte count; the schema fixes one unit for copiedBytes (§2.3). */
export function cloudFileUtf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length
}

async function cloudFileTextSha256(text: string): Promise<string | null> {
  try {
    const subtle = globalThis.crypto?.subtle
    if (!subtle) {
      return null
    }
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text))
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  } catch {
    // Best effort: the host accepts events without a fingerprint.
    return null
  }
}

function cloudFileTraceId(): string {
  return `tr_${createBrowserUuid().replace(/-/g, '')}`.slice(0, 40)
}

function copyMetadata(
  input: CloudFileCopyInput,
  sha256: string | null,
  capturedBytes: number
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    fileName: cloudFileBaseName(input.path),
    path: input.path,
    copyKind: input.copyKind,
    copiedChars: capturedBytes === 0 ? 0 : input.text.length,
    copiedBytes: capturedBytes,
    surface: input.surface ?? cloudFileAuditSurface(),
    capturePoint: input.capturePoint,
    captureConfidence: 'client-declared',
    occurredAt: Date.now()
  }
  if (input.sizeBytes !== undefined) {
    metadata.sizeBytes = input.sizeBytes
  }
  if (input.mime !== undefined) {
    metadata.mime = input.mime
  }
  if (input.isBinary !== undefined) {
    metadata.isBinary = input.isBinary
  }
  if (sha256 !== null) {
    metadata.sha256 = sha256
    metadata.sha256Source = 'client'
  }
  return metadata
}

export type CloudFileCopyReporterOptions = {
  now?: () => number
  rateLimit?: number
  rateWindowMs?: number
  sha256?: (text: string) => Promise<string | null>
}

export type CloudFileCopyReporter = {
  report: (input: CloudFileCopyInput) => Promise<CloudFileAuditResult>
  reportFailure: (input: CloudFileCopyFailureInput) => Promise<CloudFileAuditResult>
}

/**
 * One reporter per tab. `rpc` null means no cloud session, so no event is sent.
 * The host's own 429/queue-full answers are terminal — never retried.
 */
export function createCloudFileCopyReporter(
  rpc: CloudRpc | null,
  options: CloudFileCopyReporterOptions = {}
): CloudFileCopyReporter {
  const now = options.now ?? (() => Date.now())
  const rateLimit = options.rateLimit ?? CLOUD_FILE_COPY_RATE_LIMIT
  const rateWindowMs = options.rateWindowMs ?? CLOUD_FILE_COPY_RATE_WINDOW_MS
  const hash = options.sha256 ?? cloudFileTextSha256
  const sentAt: number[] = []
  let lastCopy: { key: string; at: number } | null = null

  async function send(
    body: Record<string, unknown>,
    dedupeKey: string | null
  ): Promise<CloudFileAuditResult> {
    if (!rpc) {
      return { reported: false, reason: 'non-cloud-session' }
    }
    const current = now()
    while (sentAt.length > 0 && current - sentAt[0] >= rateWindowMs) {
      sentAt.shift()
    }
    if (sentAt.length >= rateLimit) {
      return { reported: false, reason: 'rate-limited' }
    }
    if (
      dedupeKey !== null &&
      lastCopy !== null &&
      lastCopy.key === dedupeKey &&
      current - lastCopy.at < DUPLICATE_COPY_WINDOW_MS
    ) {
      return { reported: false, reason: 'duplicate' }
    }
    sentAt.push(current)
    if (dedupeKey !== null) {
      lastCopy = { key: dedupeKey, at: current }
    }
    try {
      const outcome = await rpc(CLOUD_FILE_EVENT_METHOD, body)
      if (!outcome.ok) {
        return { reported: false, reason: 'rpc-failed' }
      }
      if (readField(outcome.result, 'queued') === false) {
        return { reported: false, reason: 'host-rejected' }
      }
      return { reported: true }
    } catch {
      return { reported: false, reason: 'rpc-failed' }
    }
  }

  return {
    async report(input) {
      if (input.text.length === 0) {
        return { reported: false, reason: 'empty' }
      }
      const sha256 = await hash(input.text)
      const body = {
        eventType: 'file_copy',
        result: 'success',
        traceId: cloudFileTraceId(),
        // No `excerpt`: the FR-9.16 switch is off by default and the client never
        // ships a body it cannot justify (AC-53).
        metadata: copyMetadata(input, sha256, cloudFileUtf8Bytes(input.text))
      }
      return send(
        body,
        `${input.path}\u0000${input.copyKind}\u0000${sha256 ?? ''}\u0000${input.text.length}`
      )
    },

    async reportFailure(input) {
      const sha256 = null
      const metadata = copyMetadata({ ...input, text: '' }, sha256, 0)
      metadata.reason = input.reason
      const body = {
        eventType: 'file_copy',
        result: 'failure',
        traceId: cloudFileTraceId(),
        metadata
      }
      return send(body, null)
    }
  }
}

export type CloudFileDownloadAuditInput = {
  fileName: string
  path: string
  sizeBytes?: number
  method: string
  kind: 'file' | 'folder' | 'artifact' | 'browser'
  result: 'success' | 'failure' | 'denied'
  reason?: string
  sha256?: string
  occurredAt?: number
  surface?: CloudFileAuditSurface
}

/**
 * Reserved for the download entry the web workspace does not have yet (phase 1
 * exposes copy only). When that entry lands, call this after the save settles;
 * do not also send a `download_blocked` for the same action (§2.4).
 */
export async function recordFileDownload(
  rpc: CloudRpc | null,
  input: CloudFileDownloadAuditInput
): Promise<CloudFileAuditResult> {
  if (!rpc) {
    return { reported: false, reason: 'non-cloud-session' }
  }
  const metadata: Record<string, unknown> = {
    fileName: input.fileName,
    path: input.path,
    method: input.method,
    kind: input.kind,
    surface: input.surface ?? cloudFileAuditSurface(),
    capturePoint: 'download-runtime-client',
    captureConfidence: 'client-declared',
    occurredAt: input.occurredAt ?? Date.now()
  }
  if (input.sizeBytes !== undefined) {
    metadata.sizeBytes = input.sizeBytes
  }
  if (input.reason !== undefined) {
    metadata.reason = input.reason
  }
  if (input.sha256 !== undefined) {
    metadata.sha256 = input.sha256
    metadata.sha256Source = 'client'
  }
  try {
    const outcome = await rpc(CLOUD_FILE_EVENT_METHOD, {
      eventType: 'file_download',
      result: input.result,
      traceId: cloudFileTraceId(),
      metadata
    })
    if (!outcome.ok || readField(outcome.result, 'queued') === false) {
      return { reported: false, reason: 'host-rejected' }
    }
    return { reported: true }
  } catch {
    return { reported: false, reason: 'rpc-failed' }
  }
}
