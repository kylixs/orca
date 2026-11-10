import { classifyMobileArtifact } from '../session/mobile-artifact-kind'
import {
  TERMINAL_IMAGE_MAX_BYTES,
  TERMINAL_TEXT_MAX_BYTES,
  type FileActionTarget
} from './mobile-file-actions'
import { fileTargetKindForPreviewPath } from './mobile-file-target-kind'
import {
  displayNameFromPreviewPath,
  type MobileFilePreviewRouteParams
} from './mobile-file-preview-route'
import type { MobileTerminalArtifactPreviewSource } from './mobile-terminal-artifact-grant-refresh'

/**
 * The action target for a preview route. Kept out of the screen so the list and preview produce
 * the same target shape from the same route params.
 */
export function previewActionTarget(
  params: MobileFilePreviewRouteParams | null,
  options: {
    title: string
    size?: number
    readOnly: boolean
    readFailed?: boolean
    terminalTooLarge?: boolean
    /** The refreshed grant, when a preview reload has already re-minted one. */
    terminalSource?: MobileTerminalArtifactPreviewSource | null
  }
): FileActionTarget | null {
  if (!params) {
    return null
  }
  if (params.source === 'terminalArtifact') {
    const absolutePath = options.terminalSource?.absolutePath ?? params.absolutePath
    const grantId = options.terminalSource?.grantId ?? params.grantId
    if (!absolutePath || !grantId) {
      return null
    }
    const kind = classifyMobileArtifact(absolutePath) === 'image' ? 'image' : 'text'
    return {
      source: 'terminalArtifact',
      hostId: params.hostId,
      worktreeId: params.worktreeId,
      absolutePath,
      grantId,
      ...(params.pathText ? { pathText: params.pathText } : {}),
      ...(params.cwd ? { cwd: params.cwd } : {}),
      ...(params.terminal ? { terminalHandle: params.terminal } : {}),
      ...(params.nativeChatTab && params.nativeChatSession
        ? {
            nativeChatContext: {
              tabId: params.nativeChatTab,
              sessionId: params.nativeChatSession
            }
          }
        : {}),
      displayPath: absolutePath,
      name: options.title || displayNameFromPreviewPath(absolutePath),
      kind,
      size: options.terminalTooLarge
        ? (kind === 'image' ? TERMINAL_IMAGE_MAX_BYTES : TERMINAL_TEXT_MAX_BYTES) + 1
        : options.size,
      readOnly: options.readOnly,
      ...(options.readFailed ? { readFailed: true } : {})
    }
  }
  if (!params.relativePath) {
    return null
  }
  const kind = fileTargetKindForPreviewPath(params.relativePath)
  return {
    source: 'worktree',
    hostId: params.hostId,
    worktreeId: params.worktreeId,
    relativePath: params.relativePath,
    name: options.title || displayNameFromPreviewPath(params.relativePath),
    kind,
    size: options.size,
    previewable: kind !== 'binary',
    ...(options.readFailed ? { readFailed: true } : {})
  }
}
