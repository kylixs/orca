import { Buffer } from 'buffer/index.js'
import type {
  FileActionTarget,
  TerminalArtifactFileActionTarget,
  WorktreeFileActionTarget
} from './mobile-file-actions'
import {
  fileActionTargetKey,
  TERMINAL_IMAGE_MAX_BYTES,
  TERMINAL_TEXT_MAX_BYTES
} from './mobile-file-actions'
import { mimeTypeForFileName, utiForFileName } from './file-download-naming'
import {
  appendChunkBase64,
  completedCachedFile,
  createPreparedCacheFile,
  createSha256Digest,
  deletePreparedCacheDirectory,
  DOWNLOAD_CHUNK_BYTES,
  DOWNLOAD_MAX_BYTES,
  type PreparedCachedFile,
  writePreparedText
} from './mobile-file-download-cache'
import {
  fileActionChunkRead,
  fileActionStatRead,
  type MobileFileActionRpcSender
} from './mobile-file-action-operations'
import { loadMobileFilePreview } from './mobile-file-preview-request'
import { previewError } from './mobile-file-preview-response'
import type { MobileTerminalArtifactPreviewSource } from './mobile-terminal-artifact-grant-refresh'
import {
  FILE_TOO_LARGE_DESKTOP_MESSAGE,
  FileActionError,
  TERMINAL_TOO_LARGE_MESSAGE
} from './file-action-error'

export {
  FILE_TOO_LARGE_DESKTOP_MESSAGE,
  FileActionError,
  TERMINAL_TOO_LARGE_MESSAGE,
  type FileActionFailureCode
} from './file-action-error'

export type PrepareProgress = {
  action: 'save' | 'open'
  bytes: number
  total: number | null
}

export type PrepareCallbacks = {
  action: 'save' | 'open'
  signal: AbortSignal
  onProgress: (progress: PrepareProgress) => void
  onTerminalArtifactSourceRefreshed?: (source: MobileTerminalArtifactPreviewSource) => void
}

export async function prepareFileForAction(
  client: MobileFileActionRpcSender,
  target: FileActionTarget,
  callbacks: PrepareCallbacks
): Promise<PreparedCachedFile> {
  if (target.kind === 'directory') {
    throw new FileActionError('unavailable', 'Folders cannot be saved')
  }
  return target.source === 'worktree'
    ? prepareWorktreeFile(client, target, callbacks)
    : prepareTerminalArtifact(client, target, callbacks)
}

async function prepareWorktreeFile(
  client: MobileFileActionRpcSender,
  target: WorktreeFileActionTarget,
  callbacks: PrepareCallbacks
): Promise<PreparedCachedFile> {
  const params = { worktree: `id:${target.worktreeId}`, relativePath: target.relativePath }
  const options = { failWhenDisconnected: true, timeoutMs: 30_000 }
  let directoryUri: string | null = null
  try {
    throwIfCancelled(callbacks.signal)
    const stat = fileActionStatRead.interpret(
      await fileActionStatRead.request(client, params, options)
    )
    if (stat.isDirectory) {
      throw new FileActionError('unavailable', 'This path is a folder')
    }
    if (stat.size > DOWNLOAD_MAX_BYTES) {
      throw new FileActionError('too_large', FILE_TOO_LARGE_DESKTOP_MESSAGE)
    }
    const mimeType = mimeTypeForFileName(target.name)
    const cache = createPreparedCacheFile(target.name)
    directoryUri = cache.directory.uri
    const digest = createSha256Digest()
    let offset = 0
    callbacks.onProgress({ action: callbacks.action, bytes: 0, total: stat.size })
    while (offset < stat.size) {
      throwIfCancelled(callbacks.signal)
      const length = Math.min(DOWNLOAD_CHUNK_BYTES, stat.size - offset)
      const chunk = fileActionChunkRead.interpret(
        await fileActionChunkRead.request(client, { ...params, offset, length }, options)
      )
      throwIfCancelled(callbacks.signal)
      const bytes = Buffer.from(chunk.contentBase64, 'base64')
      if (
        bytes.byteLength !== chunk.bytesRead ||
        chunk.bytesRead === 0 ||
        chunk.bytesRead > length ||
        (chunk.eof && offset + chunk.bytesRead !== stat.size)
      ) {
        throw new FileActionError('changed', 'File changed during download. Retry.')
      }
      appendChunkBase64(cache.file, chunk.contentBase64)
      digest.update(bytes)
      offset += chunk.bytesRead
      callbacks.onProgress({ action: callbacks.action, bytes: offset, total: stat.size })
    }
    const latest = fileActionStatRead.interpret(
      await fileActionStatRead.request(client, params, options)
    )
    throwIfCancelled(callbacks.signal)
    if (
      latest.isDirectory ||
      latest.size !== stat.size ||
      latest.mtime !== stat.mtime ||
      (stat.ctime !== undefined && latest.ctime !== stat.ctime)
    ) {
      throw new FileActionError('changed', 'File changed during download. Retry.')
    }
    const writtenSize = cache.file.size
    if (writtenSize !== stat.size) {
      throw new FileActionError('changed', 'File changed during download. Retry.')
    }
    return completedCachedFile({
      targetKey: fileActionTargetKey(target),
      fileName: cache.fileName,
      file: cache.file,
      directory: cache.directory,
      size: stat.size,
      sha256: digest.hex(),
      mimeType,
      uti: utiForFileName(target.name)
    })
  } catch (error) {
    if (directoryUri) {
      deletePreparedCacheDirectory(directoryUri)
    }
    throw normalizePrepareError(error)
  }
}

async function prepareTerminalArtifact(
  client: MobileFileActionRpcSender,
  target: TerminalArtifactFileActionTarget,
  callbacks: PrepareCallbacks
): Promise<PreparedCachedFile> {
  const maxBytes = target.kind === 'image' ? TERMINAL_IMAGE_MAX_BYTES : TERMINAL_TEXT_MAX_BYTES
  if (target.size !== undefined && target.size > maxBytes) {
    throw new FileActionError('too_large', TERMINAL_TOO_LARGE_MESSAGE)
  }
  let directoryUri: string | null = null
  try {
    throwIfCancelled(callbacks.signal)
    const source: MobileTerminalArtifactPreviewSource = {
      source: 'terminalArtifact',
      worktreeId: target.worktreeId,
      absolutePath: target.absolutePath,
      grantId: target.grantId,
      ...(target.terminalHandle ? { terminalHandle: target.terminalHandle } : {}),
      ...(target.pathText ? { pathText: target.pathText } : {}),
      ...(target.cwd ? { cwd: target.cwd } : {}),
      ...(target.nativeChatContext ? { nativeChatContext: target.nativeChatContext } : {}),
      ...(target.readOnly ? { readOnly: true as const } : {})
    }
    const preview = await loadMobileFilePreview(client, source, undefined, {
      refreshGrant: true,
      onTerminalArtifactSourceRefreshed: callbacks.onTerminalArtifactSourceRefreshed
    })
    throwIfCancelled(callbacks.signal)
    if (preview.status === 'error' || preview.status === 'waiting') {
      throw new FileActionError(
        terminalPreviewTooLarge(preview.message) ? 'too_large' : 'read_failed',
        terminalPreviewTooLarge(preview.message) ? TERMINAL_TOO_LARGE_MESSAGE : preview.message
      )
    }
    const mimeType = mimeTypeForFileName(target.name)
    const cache = createPreparedCacheFile(target.name)
    directoryUri = cache.directory.uri
    if (target.kind === 'image') {
      if (preview.status !== 'ready' || preview.kind !== 'image') {
        throw new FileActionError('read_failed', 'Unable to read this image')
      }
      const base64 = preview.dataUri.slice(preview.dataUri.indexOf(',') + 1)
      const bytes = Buffer.from(base64, 'base64')
      if (bytes.byteLength > TERMINAL_IMAGE_MAX_BYTES) {
        throw new FileActionError('too_large', TERMINAL_TOO_LARGE_MESSAGE)
      }
      cache.file.write(base64, { encoding: 'base64' })
      callbacks.onProgress({
        action: callbacks.action,
        bytes: bytes.byteLength,
        total: bytes.byteLength
      })
      const imageDigest = createSha256Digest()
      imageDigest.update(bytes)
      return completedCachedFile({
        targetKey: fileActionTargetKey(target),
        fileName: cache.fileName,
        file: cache.file,
        directory: cache.directory,
        size: bytes.byteLength,
        sha256: imageDigest.hex(),
        mimeType,
        uti: utiForFileName(target.name)
      })
    }

    const content =
      preview.status === 'empty'
        ? ''
        : preview.status === 'ready' && preview.kind !== 'image' && preview.kind !== 'media'
          ? preview.content
          : null
    if (content === null) {
      throw new FileActionError('read_failed', 'Unable to read this file')
    }
    const bytes = Buffer.from(content, 'utf8')
    if (bytes.byteLength > TERMINAL_TEXT_MAX_BYTES) {
      throw new FileActionError('too_large', TERMINAL_TOO_LARGE_MESSAGE)
    }
    writePreparedText(cache.file, content)
    callbacks.onProgress({
      action: callbacks.action,
      bytes: bytes.byteLength,
      total: bytes.byteLength
    })
    const digest = createSha256Digest()
    digest.update(bytes)
    return completedCachedFile({
      targetKey: fileActionTargetKey(target),
      fileName: cache.fileName,
      file: cache.file,
      directory: cache.directory,
      size: bytes.byteLength,
      sha256: digest.hex(),
      mimeType,
      uti: utiForFileName(target.name)
    })
  } catch (error) {
    if (directoryUri) {
      deletePreparedCacheDirectory(directoryUri)
    }
    throw normalizePrepareError(error)
  }
}

function terminalPreviewTooLarge(message: string): boolean {
  const normalized = message.toLowerCase()
  return normalized.includes('file_too_large') || normalized.includes('too large')
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new FileActionError('cancelled', 'Cancelled')
  }
}

function normalizePrepareError(error: unknown): unknown {
  if (error instanceof FileActionError) {
    return error
  }
  if (error instanceof Error) {
    if (error.message === 'Media download cancelled' || error.message === 'Cancelled') {
      return new FileActionError('cancelled', 'Cancelled')
    }
    const preview = previewError(error.message)
    if (preview.status === 'error') {
      if (preview.message === 'File too large for mobile preview') {
        return new FileActionError('too_large', TERMINAL_TOO_LARGE_MESSAGE)
      }
      return new FileActionError('read_failed', preview.message)
    }
  }
  return error
}
