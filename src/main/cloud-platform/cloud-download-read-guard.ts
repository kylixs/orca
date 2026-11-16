/**
 * U66 phase 2 (OQ-6): a `files.readChunk` sequence that rebuilds an entire
 * multi-chunk file is download-equivalent, so a cloud session without the
 * ticket's `download` bit — or under a project deny policy — is refused at the
 * completing window and the refusal lands as `file_download denied`
 * (host-attested, `method=files.readChunk`).
 *
 * U70 (C+②): a download-denied session's single window is also capped at 64KB,
 * so the declared residual no longer exposes whole files of ordinary size.
 * Still open: the first window (≤64KB prefix) and out-of-order windows, since
 * only a contiguous rebuild from byte 0 accumulates coverage.
 */

export type DownloadReadWindow = {
  projectId: string
  deviceId: string
  worktree: string
  relativePath: string
  offset: number
  length: number
  fileSize: number
}

export type CloudDownloadReadVerdict = 'allow' | 'deny' | 'window_too_large'

/**
 * U70: a download-denied session cannot ask for one window large enough to hold
 * most files. 64KB keeps the boundary check meaningful for small configs/docs.
 */
export const DOWNLOAD_DENIED_READ_WINDOW_MAX_BYTES = 64 * 1024

export type CloudDownloadReadGuard = {
  /** 'deny' when this window would complete a multi-window rebuild of the file. */
  check: (window: DownloadReadWindow) => CloudDownloadReadVerdict
}

/** Bounded memory: one coverage entry per (session, worktree, file). */
const MAX_TRACKED_FILES = 256
const ENTRY_TTL_MS = 10 * 60_000

export function createCloudDownloadReadGuard(now: () => number = Date.now): CloudDownloadReadGuard {
  // Contiguous coverage from byte 0; a window only extends it when it starts at
  // or before the covered edge, so an editor's sequential chunk reads track
  // exactly and a searcher's skipped windows never accumulate coverage.
  const coverage = new Map<string, { coveredTo: number; updatedAt: number }>()

  return {
    check: (window) => {
      if (
        !Number.isSafeInteger(window.fileSize) ||
        window.fileSize <= 0 ||
        !Number.isSafeInteger(window.offset) ||
        window.offset < 0 ||
        !Number.isSafeInteger(window.length) ||
        window.length < 1
      ) {
        return 'allow'
      }
      if (window.length > DOWNLOAD_DENIED_READ_WINDOW_MAX_BYTES) {
        return 'window_too_large'
      }
      const key = `${window.projectId}\u0000${window.deviceId}\u0000${window.worktree}\u0000${window.relativePath}`
      const current = now()
      const entry = coverage.get(key)
      const expired = entry === undefined || current - entry.updatedAt >= ENTRY_TTL_MS
      const coveredTo = expired ? 0 : entry.coveredTo
      // The completing window: continues coverage and reaches the end. The first
      // window (offset 0) is deliberately exempt — a one-window read is the
      // editor/preview path the residual gap keeps open.
      if (
        window.offset > 0 &&
        window.offset <= coveredTo &&
        window.offset + window.length >= window.fileSize
      ) {
        return 'deny'
      }
      if (window.offset <= coveredTo) {
        coverage.set(key, {
          coveredTo: Math.min(window.offset + window.length, window.fileSize),
          updatedAt: current
        })
      } else if (expired) {
        coverage.delete(key)
      } else {
        entry.updatedAt = current
      }
      if (coverage.size > MAX_TRACKED_FILES) {
        const oldest = [...coverage.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0]
        if (oldest !== undefined) {
          coverage.delete(oldest[0])
        }
      }
      return 'allow'
    }
  }
}
