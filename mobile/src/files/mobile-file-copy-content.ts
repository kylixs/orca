import { Buffer } from 'buffer/index.js'
import type {
  FileActionTarget,
  TerminalArtifactFileActionTarget,
  WorktreeFileActionTarget
} from './mobile-file-actions'
import { TERMINAL_TEXT_MAX_BYTES } from './mobile-file-actions'
import { FileActionError, TERMINAL_TOO_LARGE_MESSAGE } from './file-action-error'
import {
  filePreviewTextRead,
  type MobileFilePreviewRpcSender
} from './mobile-file-preview-operations'
import { loadMobileFilePreview } from './mobile-file-preview-request'
import type { RpcFailure } from '../transport/types'
import type { MobileTerminalArtifactPreviewSource } from './mobile-terminal-artifact-grant-refresh'

export type CopiedFileContent = {
  content: string
  truncated: boolean
  byteLength: number
}

export const COPY_CONTENT_MAX_BYTES = 512 * 1024

/**
 * Reads the text on demand, never from a preview that may have been truncated for a different
 * budget. Worktree reads use `files.read` (which truncates at 512 KB and says so); terminal
 * artifacts refuse past 512 KB and must not be faked into a truncated copy.
 */
export async function readFileContentForCopy(
  client: MobileFilePreviewRpcSender,
  target: FileActionTarget,
  options: {
    onTerminalArtifactSourceRefreshed?: (source: MobileTerminalArtifactPreviewSource) => void
  } = {}
): Promise<CopiedFileContent> {
  return target.source === 'worktree'
    ? readWorktreeText(client, target)
    : readTerminalText(client, target, options)
}

async function readWorktreeText(
  client: MobileFilePreviewRpcSender,
  target: WorktreeFileActionTarget
): Promise<CopiedFileContent> {
  const reply = await filePreviewTextRead.request(client, {
    worktree: `id:${target.worktreeId}`,
    relativePath: target.relativePath
  })
  const accepted = filePreviewTextRead.interpret(reply)
  if (!accepted.accepted) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an unaccepted success-result-or-skip reply is the failure envelope.
    throw readFailure((reply as RpcFailure).error)
  }
  const value = accepted.value
  if (
    Buffer.byteLength(value.content, 'utf8') > COPY_CONTENT_MAX_BYTES &&
    value.truncated !== true
  ) {
    return {
      content: truncateUtf8(value.content, COPY_CONTENT_MAX_BYTES),
      truncated: true,
      byteLength: Buffer.byteLength(value.content, 'utf8')
    }
  }
  const byteLength =
    typeof value.byteLength === 'number'
      ? value.byteLength
      : Buffer.byteLength(value.content, 'utf8')
  return { content: value.content, truncated: value.truncated === true, byteLength }
}

async function readTerminalText(
  client: MobileFilePreviewRpcSender,
  target: TerminalArtifactFileActionTarget,
  options: {
    onTerminalArtifactSourceRefreshed?: (source: MobileTerminalArtifactPreviewSource) => void
  }
): Promise<CopiedFileContent> {
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
    onTerminalArtifactSourceRefreshed: options.onTerminalArtifactSourceRefreshed
  })
  if (preview.status === 'error' || preview.status === 'waiting') {
    if (isTooLargeMessage(preview.message)) {
      throw new FileActionError('too_large', TERMINAL_TOO_LARGE_MESSAGE)
    }
    throw new FileActionError('read_failed', preview.message)
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
  const byteLength = Buffer.byteLength(content, 'utf8')
  if (byteLength > TERMINAL_TEXT_MAX_BYTES) {
    throw new FileActionError('too_large', TERMINAL_TOO_LARGE_MESSAGE)
  }
  return { content, truncated: false, byteLength }
}

function isTooLargeMessage(message: string): boolean {
  const normalized = message.toLowerCase()
  return normalized.includes('file_too_large') || normalized.includes('too large')
}

function readFailure(error: RpcFailure['error']): FileActionError {
  const message = error.message || error.code
  if (isTooLargeMessage(message)) {
    return new FileActionError('too_large', TERMINAL_TOO_LARGE_MESSAGE)
  }
  return new FileActionError('read_failed', message)
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = ''
  let used = 0
  for (const character of value) {
    const bytes = Buffer.byteLength(character, 'utf8')
    if (used + bytes > maxBytes) {
      break
    }
    result += character
    used += bytes
  }
  return result
}
