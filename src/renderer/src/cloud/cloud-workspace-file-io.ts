import { detectLanguage } from '@/lib/language-detect'
import { readField, readNumber, readString } from '../../../shared/json-fields'
import { cloudWorktreeSelector, type CloudRpc } from '../../../shared/cloud-file-browser'
import type { CloudRpcOutcome } from '../../../shared/cloud-platform-ipc'

/**
 * Text read/write for a workspace editor tab (design §4.7).
 *
 * The host owns the path boundary (`cloud-path-guard`) and the read cap; this
 * module only maps the two RPCs and refuses a reply it cannot read rather than
 * showing an empty buffer that a save would then commit.
 */

export type CloudWorkspaceFileFailure = { ok: false; code: string; message?: string }

export type CloudWorkspaceFileRead =
  | {
      ok: true
      content: string
      /** >512KB reads come back truncated; such a buffer must never be written back. */
      truncated: boolean
      byteLength: number | null
      /** Host-flagged or NUL-containing content: never open it for writing (U59②). */
      binary: boolean
    }
  | CloudWorkspaceFileFailure

export type CloudWorkspaceFileWrite = { ok: true } | CloudWorkspaceFileFailure

function failure(outcome: Extract<CloudRpcOutcome, { ok: false }>): CloudWorkspaceFileFailure {
  return outcome.message === undefined
    ? { ok: false, code: outcome.code }
    : { ok: false, code: outcome.code, message: outcome.message }
}

/** Monaco language id for a workspace path, reusing the app-wide extension map. */
export function cloudWorkspaceFileLanguage(relativePath: string): string {
  return detectLanguage(relativePath)
}

/** Markdown-family files get the edit/preview switch (design §11.4). */
export function isCloudWorkspaceMarkdownPath(relativePath: string): boolean {
  const filename = relativePath.split(/[\\/]/).at(-1) ?? relativePath
  return /\.(md|markdown|mdx)$/i.test(filename)
}

export async function readCloudWorkspaceFile(
  rpc: CloudRpc,
  workspacePath: string,
  relativePath: string
): Promise<CloudWorkspaceFileRead> {
  const outcome = await rpc('files.read', {
    worktree: cloudWorktreeSelector(workspacePath),
    relativePath
  })
  if (!outcome.ok) {
    return failure(outcome)
  }
  const content = readString(outcome.result, 'content')
  if (content === null) {
    return { ok: false, code: 'malformed_reply' }
  }
  return {
    ok: true,
    content,
    truncated: readField(outcome.result, 'truncated') === true,
    byteLength: readNumber(outcome.result, 'byteLength'),
    binary:
      readField(outcome.result, 'binary') === true ||
      readField(outcome.result, 'isBinary') === true ||
      content.includes('\u0000')
  }
}

export async function writeCloudWorkspaceFile(
  rpc: CloudRpc,
  workspacePath: string,
  relativePath: string,
  content: string,
  /** The checkout lives on the host serving this session; the host refuses a mutation that does not name it. */
  executionHostId = 'local'
): Promise<CloudWorkspaceFileWrite> {
  const outcome = await rpc('files.write', {
    worktree: cloudWorktreeSelector(workspacePath),
    relativePath,
    content,
    expectedExecutionHostId: executionHostId
  })
  return outcome.ok ? { ok: true } : failure(outcome)
}

/** Inline copy for a refused read/save; codes stay visible for diagnosis. */
export function cloudWorkspaceFileFailureText(failure: { code: string; message?: string }): string {
  switch (failure.code) {
    case 'binary_file':
      return '二进制文件无法以文本方式打开。'
    case 'file_too_large':
      return '文件过大，简易工作区不支持编辑。'
    case 'forbidden':
    case 'path_denied':
      return '无权访问该文件。'
    case 'method_denied':
    case 'permission':
      return '当前项目未授予文件写入权限。'
    default:
      return failure.message === undefined ? failure.code : `${failure.code}：${failure.message}`
  }
}
