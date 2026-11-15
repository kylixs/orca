import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { isCloudSessionEnvironmentId } from '@/lib/cloud-session-environment-membership'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { useAppStore } from '@/store'
import {
  CLOUD_FILE_EVENT_METHOD,
  cloudFileAuditSurface,
  cloudFileBaseName,
  type CloudFileAuditResult
} from './cloud-file-copy-audit'

/**
 * U66 §3.2 C3 desktop download capture (AC-41) and C8 frontend interception
 * (R-03): the real desktop path is `files.readChunk` plus a local save, so the
 * download outcome is client-declared and rides `audit.recordFileEvent`.
 * Reporting is best-effort — a refused audit never blocks or retries the
 * download it describes.
 */

export type DesktopDownloadAudit = {
  /** Save dialog cancelled or transfer failed: one failure event, no success after. */
  failure: (path: string, fileName: string, reason: 'client_cancelled' | 'read_failed') => void
  /** Bytes delivered and (best-effort) the name the file landed under locally. */
  success: (input: {
    path: string
    fileName: string
    /** Omit when the delivery path cannot count the bytes honestly (§2.7). */
    sizeBytes?: number
    savedName?: string
  }) => void
  /** The client refused before any download RPC reached the host (§2.4). */
  blocked: (path: string, fileName: string, reason: string) => void
}

function traceId(): string {
  // Why not crypto.randomUUID: it is missing in non-secure contexts (Remote Web).
  return `tr_${createBrowserUuid().replace(/-/g, '')}`.slice(0, 40)
}

/** `audit.recordFileEvent` over the session; every failure is swallowed. */
async function report(
  target: RuntimeClientTarget,
  body: Record<string, unknown>
): Promise<CloudFileAuditResult> {
  try {
    const outcome = await callRuntimeRpc<Record<string, unknown>>(
      target,
      CLOUD_FILE_EVENT_METHOD,
      body,
      { timeoutMs: 5_000 }
    )
    if (outcome.queued === false) {
      return { reported: false, reason: 'host-rejected' }
    }
    return { reported: true }
  } catch {
    return { reported: false, reason: 'rpc-failed' }
  }
}

/** Null outside a desktop cloud session: SSH, local, and web clients stay silent. */
export function desktopCloudFileDownloadAudit(
  target: RuntimeClientTarget
): DesktopDownloadAudit | null {
  if (
    target.kind !== 'environment' ||
    !isCloudSessionEnvironmentId(useAppStore.getState().runtimeEnvironments, target.environmentId)
  ) {
    return null
  }
  const send = (body: Record<string, unknown>): void => {
    void report(target, body)
  }
  return {
    failure: (path, fileName, reason) =>
      send(desktopFileDownloadEventBody({ path, fileName, result: 'failure', reason })),
    success: (input) =>
      send(
        desktopFileDownloadEventBody({
          path: input.path,
          fileName: input.fileName,
          result: 'success',
          sizeBytes: input.sizeBytes,
          savedName: input.savedName
        })
      ),
    blocked: (path, fileName, reason) =>
      send(desktopDownloadBlockedEventBody({ path, fileName, reason }))
  }
}

/** The saved-name tail of a local destination, POSIX or Windows form. */
export function localSavedName(destinationPath: string): string {
  return cloudFileBaseName(destinationPath)
}

/** §2.2/§2.10.2 body for one download outcome (desktop, `files.readChunk` path). */
export function desktopFileDownloadEventBody(input: {
  path: string
  fileName: string
  result: 'success' | 'failure'
  reason?: string
  sizeBytes?: number
  savedName?: string
  surface?: 'desktop' | 'web' | 'admin-embed'
}): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    fileName: input.fileName,
    path: input.path,
    method: 'files.readChunk',
    kind: 'file',
    surface: input.surface ?? cloudFileAuditSurface(),
    capturePoint: 'download-runtime-client',
    captureConfidence: 'client-declared',
    occurredAt: Date.now()
  }
  if (input.sizeBytes !== undefined) {
    metadata.sizeBytes = input.sizeBytes
  }
  if (input.savedName !== undefined) {
    metadata.savedName = input.savedName
  }
  if (input.reason !== undefined) {
    metadata.reason = input.reason
  }
  return { eventType: 'file_download', result: input.result, traceId: traceId(), metadata }
}

/** §2.4 frontend interception: refused before any download RPC reached the host. */
export function desktopDownloadBlockedEventBody(input: {
  path: string
  fileName: string
  reason: string
  surface?: 'desktop' | 'web' | 'admin-embed'
}): Record<string, unknown> {
  return {
    eventType: 'download_blocked',
    result: 'denied',
    traceId: traceId(),
    metadata: {
      fileName: input.fileName,
      path: input.path,
      method: 'files.readChunk',
      kind: 'file',
      surface: input.surface ?? cloudFileAuditSurface(),
      capturePoint: 'frontend-block',
      captureConfidence: 'client-declared',
      policy: 'deny',
      reason: input.reason,
      occurredAt: Date.now()
    }
  }
}
