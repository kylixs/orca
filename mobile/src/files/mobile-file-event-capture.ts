import { Buffer } from 'buffer/index.js'
import { sha256 } from '@noble/hashes/sha256'
import type { RpcResponse } from '../transport/types'
import { fileActionPath, type FileActionTarget } from './mobile-file-actions'

/**
 * U66 §2.10 `audit.recordFileEvent` capture for mobile Save to phone / Copy content (AC-56/AC-57).
 *
 * Mirrors `src/renderer/src/cloud/cloud-file-copy-audit.ts`; the mobile bundle cannot import it.
 * The host fills device/project/captureConfidence (§2.10.2). Reporting is best-effort: every
 * failure is swallowed so the user action never waits on the audit channel.
 */

export const MOBILE_FILE_EVENT_METHOD = 'audit.recordFileEvent'
export const MOBILE_FILE_EVENT_SURFACE = 'mobile'
export const MOBILE_SAVE_METHOD = 'mobile.saveToPhone'
export const MOBILE_SAVE_CAPTURE_POINT = 'mobile-save'
export const MOBILE_COPY_CAPTURE_POINT = 'mobile-copy-content'

export type MobileFileAuditSender = {
  sendRequest: (method: string, params?: unknown) => Promise<RpcResponse>
}

export type MobileFileSaveOutcome = 'saved' | 'shared' | 'cancelled' | 'failed'

export type MobileFileSaveReport = {
  target: FileActionTarget
  outcome: MobileFileSaveOutcome
  /** Only a confirmed SAF write names a local file; a share-sheet result never does. */
  savedName?: string
  sizeBytes?: number
  sha256?: string
  reason?: string
  occurredAt?: number
}

export type MobileFileCopyReport = {
  target: FileActionTarget
  /** The text actually written to the clipboard, already truncated at the copy budget. */
  content: string
  occurredAt?: number
}

export type MobileFileCopyFailureReason = 'read_failed' | 'clipboard_write_failed'

export type MobileFileCopyFailureReport = {
  target: FileActionTarget
  reason: MobileFileCopyFailureReason
  occurredAt?: number
}

export type MobileFileSaveFailureCode =
  | 'cancelled'
  | 'too_large'
  | 'changed'
  | 'read_failed'
  | 'unavailable'
  | 'no_app'
  | 'save_failed'

/** §2.10.3: the trace is per action, so a savedName supplement merges into the success event. */
export function mobileFileEventTraceId(): string {
  const uuid = globalThis.crypto?.randomUUID
  const entropy =
    typeof uuid === 'function'
      ? uuid.call(globalThis.crypto).replaceAll('-', '')
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}${Math.random()
          .toString(36)
          .slice(2, 10)}`
  return `tr_${entropy}`.slice(0, 40)
}

/** SAF writes may rename on collision; the tail of the visible path is what landed. */
export function mobileSavedFileName(savedPath: string, fallback: string): string {
  const name = savedPath.replaceAll('\\', '/').split('/').pop()
  return name !== undefined && name.length > 0 ? name : fallback
}

function baseMetadata(target: FileActionTarget, occurredAt: number): Record<string, unknown> {
  return {
    fileName: target.name,
    path: fileActionPath(target),
    surface: MOBILE_FILE_EVENT_SURFACE,
    captureConfidence: 'client-declared',
    occurredAt
  }
}

function withFingerprint(
  metadata: Record<string, unknown>,
  fingerprint: string | undefined
): Record<string, unknown> {
  if (fingerprint !== undefined && fingerprint.length > 0) {
    metadata.sha256 = fingerprint
    metadata.sha256Source = 'client'
  }
  return metadata
}

export function buildMobileFileDownloadEvent(
  report: Pick<MobileFileSaveReport, 'target' | 'outcome' | 'sizeBytes' | 'sha256' | 'reason'> & {
    occurredAt: number
    traceId: string
  }
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    ...baseMetadata(report.target, report.occurredAt),
    method: MOBILE_SAVE_METHOD,
    kind: report.target.source === 'terminalArtifact' ? 'artifact' : 'file',
    capturePoint: MOBILE_SAVE_CAPTURE_POINT
  }
  const success = report.outcome === 'saved' || report.outcome === 'shared'
  const reason =
    report.outcome === 'shared'
      ? 'share_sheet'
      : report.outcome === 'cancelled'
        ? 'client_cancelled'
        : report.outcome === 'failed'
          ? (report.reason ?? 'read_failed')
          : undefined
  if (success) {
    if (report.sizeBytes !== undefined) {
      metadata.sizeBytes = report.sizeBytes
    }
    withFingerprint(metadata, report.sha256)
  }
  if (reason !== undefined) {
    metadata.reason = reason
  }
  return {
    eventType: 'file_download',
    result: success ? 'success' : 'failure',
    traceId: report.traceId,
    metadata
  }
}

/** The supplement carries only `savedName`: the host merges it into the same-trace event. */
export function buildMobileSavedNameEvent(
  traceId: string,
  savedName: string
): Record<string, unknown> {
  return {
    eventType: 'file_download',
    result: 'success',
    traceId,
    metadata: { savedName }
  }
}

function copiedTextSha256(content: string): string | undefined {
  try {
    const digest = sha256(Buffer.from(content, 'utf8'))
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
  } catch {
    return undefined
  }
}

export function buildMobileFileCopyEvent(report: {
  target: FileActionTarget
  content: string
  occurredAt: number
  traceId: string
}): Record<string, unknown> {
  const copiedBytes = Buffer.byteLength(report.content, 'utf8')
  return {
    eventType: 'file_copy',
    result: 'success',
    traceId: report.traceId,
    metadata: withFingerprint(
      {
        ...baseMetadata(report.target, report.occurredAt),
        copyKind: 'content-whole',
        copiedChars: report.content.length,
        copiedBytes,
        capturePoint: MOBILE_COPY_CAPTURE_POINT
      },
      copiedTextSha256(report.content)
    )
  }
}

export function buildMobileFileCopyFailureEvent(report: {
  target: FileActionTarget
  reason: MobileFileCopyFailureReason
  occurredAt: number
  traceId: string
}): Record<string, unknown> {
  return {
    eventType: 'file_copy',
    result: 'failure',
    traceId: report.traceId,
    metadata: {
      ...baseMetadata(report.target, report.occurredAt),
      copyKind: 'content-whole',
      copiedChars: 0,
      copiedBytes: 0,
      capturePoint: MOBILE_COPY_CAPTURE_POINT,
      reason: report.reason
    }
  }
}

/** `{queued:false}` is a host refusal (rate limit, non-cloud, duplicate): nothing reached the chain. */
function hostQueued(result: unknown): boolean {
  return (
    typeof result !== 'object' ||
    result === null ||
    !('queued' in result) ||
    result.queued !== false
  )
}

async function send(
  sender: MobileFileAuditSender,
  body: Record<string, unknown>
): Promise<boolean> {
  try {
    const reply = await sender.sendRequest(MOBILE_FILE_EVENT_METHOD, body)
    return reply.ok && hostQueued(reply.result)
  } catch {
    return false
  }
}

/** AC-56: success/failure/cancel, plus the savedName supplement when the SAF write confirms it. */
export async function reportMobileFileSave(
  sender: MobileFileAuditSender | null,
  report: MobileFileSaveReport
): Promise<void> {
  if (!sender) {
    return
  }
  const traceId = mobileFileEventTraceId()
  const delivered = await send(
    sender,
    buildMobileFileDownloadEvent({
      ...report,
      occurredAt: report.occurredAt ?? Date.now(),
      traceId
    })
  )
  const savedName = report.savedName
  if (delivered && report.outcome === 'saved' && savedName !== undefined && savedName.length > 0) {
    await send(sender, buildMobileSavedNameEvent(traceId, savedName))
  }
}

/** AC-57: one `file_copy` per copyContent, carrying the actual copied length. */
export async function reportMobileFileCopy(
  sender: MobileFileAuditSender | null,
  report: MobileFileCopyReport
): Promise<void> {
  if (!sender) {
    return
  }
  await send(
    sender,
    buildMobileFileCopyEvent({
      ...report,
      occurredAt: report.occurredAt ?? Date.now(),
      traceId: mobileFileEventTraceId()
    })
  )
}

export async function reportMobileFileCopyFailure(
  sender: MobileFileAuditSender | null,
  report: MobileFileCopyFailureReport
): Promise<void> {
  if (!sender) {
    return
  }
  await send(
    sender,
    buildMobileFileCopyFailureEvent({
      ...report,
      occurredAt: report.occurredAt ?? Date.now(),
      traceId: mobileFileEventTraceId()
    })
  )
}
