import { readField, readNumber, readObjectValue, readString } from '../../../shared/json-fields'

/**
 * Wire parsing for the workspace diff tab (U46-7b, design §11.3).
 *
 * `git.diff` and `git.commitDiff` both return the shared `GitDiffResult`
 * (text with an optional large-diff notice, or binary with base64 image sides),
 * so one tolerant parser serves both. The parser never coerces a reply it
 * cannot read into an empty diff, which would look like "no changes".
 */

export type CloudWorkspaceDiffSource =
  | { kind: 'working' }
  | {
      kind: 'commit'
      commitOid: string
      /** Omitted = resolve from `git.commitCompare.summary`; null = root commit. */
      parentOid?: string | null
      oldPath?: string
    }

export type CloudWorkspaceLargeDiff = {
  reason: string | null
  lineCounts: { original: number; modified: number } | null
  characterCount: number | null
}

export type CloudWorkspaceTextDiff = {
  kind: 'text'
  originalContent: string
  modifiedContent: string
  largeDiff: CloudWorkspaceLargeDiff | null
}

export type CloudWorkspaceBinaryDiff = {
  kind: 'binary'
  originalContent: string
  modifiedContent: string
  isImage: boolean
  mimeType?: string
  modifiedDeleted: boolean
}

export type CloudWorkspaceDiff = CloudWorkspaceTextDiff | CloudWorkspaceBinaryDiff

function parseLargeDiff(value: unknown): CloudWorkspaceLargeDiff | null {
  const object = readObjectValue(value)
  if (object === null || readField(object, 'limited') !== true) {
    return null
  }
  const counts = readObjectValue(readField(object, 'lineCounts'))
  const original = counts === null ? null : readNumber(counts, 'original')
  const modified = counts === null ? null : readNumber(counts, 'modified')
  return {
    reason: readString(object, 'reason'),
    lineCounts: original === null || modified === null ? null : { original, modified },
    characterCount: readNumber(object, 'characterCount')
  }
}

export function parseCloudWorkspaceDiff(result: unknown): CloudWorkspaceDiff | null {
  const kind = readString(result, 'kind')
  const originalContent = readString(result, 'originalContent')
  const modifiedContent = readString(result, 'modifiedContent')
  if (kind === null || originalContent === null || modifiedContent === null) {
    return null
  }
  if (kind === 'binary') {
    const mimeType = readString(result, 'mimeType')
    return {
      kind: 'binary',
      originalContent,
      modifiedContent,
      isImage: readField(result, 'isImage') === true,
      ...(mimeType === null ? {} : { mimeType }),
      modifiedDeleted: readField(result, 'modifiedDeleted') === true
    }
  }
  if (kind !== 'text') {
    return null
  }
  return {
    kind: 'text',
    originalContent,
    modifiedContent,
    largeDiff: parseLargeDiff(readField(result, 'largeDiffRenderLimit'))
  }
}

/** Parent of the commit being inspected, or null for a root commit/malformed reply. */
export function parseCloudCommitParentOid(result: unknown): { parentOid: string | null } | null {
  const summary = readObjectValue(readField(result, 'summary'))
  if (summary === null) {
    return null
  }
  return { parentOid: readString(summary, 'parentOid') }
}
