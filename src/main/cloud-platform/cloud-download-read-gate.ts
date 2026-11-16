import { downloadRebuildDenialDetails, type CloudDenialDetails } from './cloud-denial-details'
import {
  DOWNLOAD_DENIED_READ_WINDOW_MAX_BYTES,
  type CloudDownloadReadGuard
} from './cloud-download-read-guard'
import type { CloudHostAuditSink } from './cloud-host-audit'

/**
 * U66 phase 2 (OQ-6): the dispatcher's download hard block on the real
 * data-fetch path — a `files.readChunk` run that rebuilds an entire multi-chunk
 * file is the download itself, so for a session that may not download the
 * completing window is refused before any bytes move and lands as
 * `file_download denied` (host-attested). U70: single windows are additionally
 * capped at 64KB; the first prefix window and out-of-order windows stay open.
 */

export type DownloadReadTarget = {
  worktree: string
  relativePath: string
  offset: number
  length: number
}

export type DownloadReadRefusal = {
  details: CloudDenialDetails
  /** The user-facing refusal message the RPC error carries. */
  message: string
  fileName: string
  relativePath: string
  fileSize: number
}

/** Whether this call is a readChunk a download-denied session can still serve. */
export function isDownloadReadEnforcementCandidate(
  method: string,
  session: { projectId: string; permissions: readonly string[] },
  downloadAllowed: boolean
): boolean {
  return (
    method === 'files.readChunk' &&
    session.permissions.includes('file:read') &&
    !(session.permissions.includes('download') && downloadAllowed)
  )
}

/**
 * Stats the target and consults the guard; null lets the call through. An
 * unstattable target or malformed params is not a provable download, and the
 * handler's own path/read errors are the honest verdicts there.
 */
export async function downloadReadRefusal(
  guard: CloudDownloadReadGuard,
  statRuntimeFile: (
    worktree: string,
    relativePath: string
  ) => Promise<{ size: number; isDirectory: boolean }>,
  params: unknown,
  projectId: string,
  deviceId: string,
  hasDownloadPermission: boolean
): Promise<DownloadReadRefusal | null> {
  if (!params || typeof params !== 'object') {
    return null
  }
  const field = (key: string): string | null => {
    const value: unknown = Reflect.get(params, key)
    return typeof value === 'string' ? value : null
  }
  const number = (key: string): number | null => {
    const value: unknown = Reflect.get(params, key)
    return typeof value === 'number' ? value : null
  }
  const worktree = field('worktree')
  const relativePath = field('relativePath')
  const offset = number('offset')
  const length = number('length')
  if (worktree === null || relativePath === null || offset === null || length === null) {
    return null
  }
  let fileSize: number
  try {
    const stat = await statRuntimeFile(worktree, relativePath)
    if (stat.isDirectory) {
      return null
    }
    fileSize = stat.size
  } catch {
    return null
  }
  const verdict = guard.check({
    projectId,
    deviceId,
    worktree,
    relativePath,
    offset,
    length,
    fileSize
  })
  if (verdict === 'allow') {
    return null
  }
  const maxKb = DOWNLOAD_DENIED_READ_WINDOW_MAX_BYTES / 1024
  return {
    details: downloadRebuildDenialDetails(hasDownloadPermission),
    message:
      verdict === 'window_too_large'
        ? hasDownloadPermission
          ? `Refused: a single read is capped at ${maxKb} KB when downloads are disabled for this project by platform policy.`
          : `Refused: a single read is capped at ${maxKb} KB, because reading a larger window needs the 'download' project permission, which this cloud session was not granted.`
        : hasDownloadPermission
          ? 'Refused: reading this whole file rebuilds a download, and downloads are disabled for this project by platform policy.'
          : "Reading this whole file rebuilds a download, which needs the 'download' project permission, which this cloud session was not granted.",
    fileName: relativePath.split(/[\\/]/).pop() ?? relativePath,
    relativePath,
    fileSize
  }
}

/** Emits the host-attested `file_download denied` the refusal must land as. */
export function reportDownloadReadRefusal(
  sink: CloudHostAuditSink | null | undefined,
  refusal: DownloadReadRefusal,
  identity: { deviceId: string; subject: string; projectId: string }
): void {
  sink?.({
    eventType: 'file_download',
    result: 'denied',
    deviceId: identity.deviceId,
    // The ticket's sub is already `user:<username>` (§2.1 subject form).
    subject: identity.subject,
    projectId: identity.projectId,
    method: 'files.readChunk',
    denial: refusal.details.denial,
    reason: refusal.details.denial,
    metadata: {
      captureConfidence: 'host-attested',
      ...(refusal.details.denial === 'DOWNLOAD_DISABLED' ? { policy: 'deny' } : {}),
      fileName: refusal.fileName,
      path: refusal.relativePath,
      sizeBytes: refusal.fileSize
    }
  })
}
