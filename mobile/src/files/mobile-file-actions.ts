import type { RuntimeNativeChatFileContext } from '../../../src/shared/runtime-types'
import { availableHtmlOpenActions, type HtmlOpenActionState } from './mobile-file-open-mode-actions'
import type { MobileHtmlPreviewMode } from './mobile-html-open-mode'

export type FileActionTargetKind =
  | 'text'
  | 'markdown'
  | 'html'
  | 'image'
  | 'media'
  | 'binary'
  | 'directory'

export type WorktreeFileActionTarget = {
  source: 'worktree'
  /** The paired host; part of the single-flight key when two hosts expose the same worktree id. */
  hostId?: string
  worktreeId: string
  relativePath: string
  name: string
  kind: FileActionTargetKind
  size?: number
  previewable: boolean
  readFailed?: boolean
}

export type TerminalArtifactFileActionTarget = {
  source: 'terminalArtifact'
  hostId?: string
  worktreeId: string
  absolutePath: string
  grantId: string
  pathText?: string
  cwd?: string
  terminalHandle?: string
  nativeChatContext?: RuntimeNativeChatFileContext
  displayPath: string
  name: string
  kind: 'text' | 'image'
  size?: number
  readOnly?: boolean
  readFailed?: boolean
}

/** The one target shape both the explorer and the preview screen build actions from. */
export type FileActionTarget = WorktreeFileActionTarget | TerminalArtifactFileActionTarget

export type FileActionContext = 'list' | 'preview'

export type FileHtmlOpenMode = MobileHtmlPreviewMode

export type FileActionCapabilities = {
  saveToPhone: boolean
  openWith: boolean
}

export const FULL_FILE_ACTION_CAPABILITIES: FileActionCapabilities = {
  saveToPhone: true,
  openWith: true
}

export type FileActionId =
  | 'retry'
  | 'preview'
  | 'source'
  | 'save'
  | 'open'
  | 'copy-content'
  | 'copy-path'
  | 'cancel'

export type FileAction = {
  id: FileActionId
  label: string
  hint?: string
}

export type FileActionOptions = {
  context: FileActionContext
  /** Present whenever the caller knows the target is HTML, including a source-only artifact. */
  htmlActionState?: HtmlOpenActionState
  capabilities: FileActionCapabilities
}

/** `files.readTerminalArtifact` refuses anything larger, so the sheet never offers a fake copy. */
export const TERMINAL_TEXT_MAX_BYTES = 512 * 1024
/** The mobile outbound JSON budget for a terminal image preview. */
export const TERMINAL_IMAGE_MAX_BYTES = 3 * 1024 * 1024

const ACTION_LABELS: Record<FileActionId, string> = {
  retry: 'Retry read',
  preview: 'Preview',
  source: 'Source',
  save: 'Save to phone',
  open: 'Open with',
  'copy-content': 'Copy content',
  'copy-path': 'Copy path',
  cancel: 'Cancel'
}

export function buildFileActions(
  target: FileActionTarget,
  options: FileActionOptions
): FileAction[] {
  if (target.kind === 'directory') {
    return [action('copy-path'), action('cancel')]
  }
  // Terminal artifacts cannot be streamed past these caps: the RPC refuses and the read image
  // budget is 3 MB. Only the path remains actionable, never a truncated fake.
  if (terminalArtifactTooLarge(target)) {
    return [action('copy-path'), action('cancel')]
  }
  if (target.readFailed) {
    const actions: FileAction[] = [action('retry')]
    if (options.capabilities.saveToPhone) {
      actions.push(action('save'))
    }
    if (options.capabilities.openWith) {
      actions.push(action('open'))
    }
    actions.push(action('copy-path'), action('cancel'))
    return actions
  }

  const actions: FileAction[] = []
  // A terminal artifact keeps `kind: 'text'` for its size budget, so the caller's HTML state is
  // the signal that this text file is the HTML source-only surface.
  const html =
    options.htmlActionState ?? (target.kind === 'html' ? defaultHtmlActionState(target) : null)
  if (html) {
    // The HTML feature replaces the generic Preview with its two open modes. Both contexts show
    // the same pair; only a mode screen knows which one is current, and it never duplicates.
    for (const htmlAction of availableHtmlOpenActions(html)) {
      actions.push(action(htmlAction.id))
    }
  } else if (options.context === 'list' && target.source === 'worktree' && target.previewable) {
    actions.push(action('preview'))
  }

  if (options.capabilities.saveToPhone) {
    actions.push(action('save'))
  }
  if (options.capabilities.openWith) {
    actions.push(action('open'))
  }
  if (supportsCopyContent(target)) {
    actions.push(
      action('copy-content', html?.previewDisabled ? 'Copies the first 512 KB' : undefined)
    )
  }
  actions.push(action('copy-path'), action('cancel'))
  return actions
}

function defaultHtmlActionState(target: FileActionTarget): HtmlOpenActionState {
  return {
    source: target.source,
    previewDisabled: false,
    readFailed: Boolean(target.readFailed)
  }
}

export function terminalArtifactTooLarge(target: FileActionTarget): boolean {
  return (
    target.source === 'terminalArtifact' &&
    target.size !== undefined &&
    target.size > terminalArtifactMaxBytes(target.kind)
  )
}

export function terminalArtifactMaxBytes(kind: 'text' | 'image'): number {
  return kind === 'image' ? TERMINAL_IMAGE_MAX_BYTES : TERMINAL_TEXT_MAX_BYTES
}

export function supportsCopyContent(target: FileActionTarget): boolean {
  if (target.kind === 'directory' || target.kind === 'image' || target.kind === 'media') {
    return false
  }
  if (target.kind === 'binary') {
    return false
  }
  return true
}

/** Stable identity for the single-flight prepare registry across the list and preview screens. */
export function fileActionTargetKey(target: FileActionTarget): string {
  const host = target.hostId ?? ''
  if (target.source === 'terminalArtifact') {
    const chat = target.nativeChatContext
      ? `${target.nativeChatContext.tabId}/${target.nativeChatContext.sessionId}`
      : ''
    return JSON.stringify(['terminal', host, target.worktreeId, target.absolutePath, chat])
  }
  return JSON.stringify(['worktree', host, target.worktreeId, target.relativePath])
}

/** Copy path copies what the user sees, even after a grant refresh changed the absolute path. */
export function fileActionPath(target: FileActionTarget): string {
  return target.source === 'terminalArtifact'
    ? (target.pathText ?? target.displayPath)
    : target.relativePath
}

export function fileActionCapabilityNotice(
  target: FileActionTarget,
  options: FileActionOptions
): string | null {
  if (options.capabilities.saveToPhone && options.capabilities.openWith) {
    return null
  }
  // Only a hidden Save/Open the target would otherwise offer is a degradation; directories and
  // over-budget terminal artifacts never have those actions.
  const fullCapabilityActions = buildFileActions(target, {
    ...options,
    capabilities: FULL_FILE_ACTION_CAPABILITIES
  })
  return fullCapabilityActions.some(({ id }) => id === 'save' || id === 'open')
    ? 'Update Orca on this device to use file actions'
    : null
}

function action(id: FileActionId, hint?: string): FileAction {
  return { id, label: ACTION_LABELS[id], ...(hint ? { hint } : {}) }
}
