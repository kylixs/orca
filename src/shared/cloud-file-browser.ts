import { readArrayValue, readField, readString } from './json-fields'
import type { CloudRpcOutcome } from './cloud-platform-ipc'

/**
 * Directory browsing over a cloud link (design §8.3).
 *
 * The host answers `files.readDir` / `files.readPreview` for a worktree selector,
 * which for a cloud session is the path the platform signed as the user's
 * checkout. Everything here is a pure function of the RPC, so the same code runs
 * in the renderer and in the end-to-end test that talks to a real host.
 */

export type CloudFileEntry = {
  name: string
  kind: 'directory' | 'file'
  isSymlink: boolean
}

export type CloudFilePreview = {
  content: string
  isBinary: boolean
  isImage: boolean
  mimeType?: string
}

export type CloudBrowseOutcome =
  | { ok: true; entries: CloudFileEntry[] }
  | { ok: false; code: string; message?: string }

export type CloudPreviewOutcome =
  | { ok: true; preview: CloudFilePreview }
  | { ok: false; code: string; message?: string }

export type CloudRpc = (
  method: string,
  params?: Record<string, unknown>
) => Promise<CloudRpcOutcome>

/** The worktree selector a cloud session uses: the path inside its ticket. */
export function cloudWorktreeSelector(workspacePath: string): string {
  return `path:${workspacePath}`
}

/** Root is the empty relative path, which the host resolves to the worktree. */
export const CLOUD_FILE_ROOT = ''

/** Null for a name that could escape its directory; host entries never should. */
export function cloudChildPath(directory: string, name: string): string | null {
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    return null
  }
  return directory === CLOUD_FILE_ROOT ? name : `${directory}/${name}`
}

/** One level up; the root stays the root. */
export function cloudParentPath(relativePath: string): string {
  const cut = relativePath.lastIndexOf('/')
  return cut <= 0 ? CLOUD_FILE_ROOT : relativePath.slice(0, cut)
}

export function cloudPathSegments(relativePath: string): string[] {
  return relativePath === CLOUD_FILE_ROOT ? [] : relativePath.split('/')
}

const NAME_ORDER = new Intl.Collator(undefined, { sensitivity: 'base' })

/** Directories first, then files, each case-insensitively by name. */
export function sortCloudEntries(entries: CloudFileEntry[]): CloudFileEntry[] {
  return [...entries].sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === 'directory' ? -1 : 1
    }
    return NAME_ORDER.compare(left.name, right.name)
  })
}

/** VCS metadata is noise in a file pane and, in a worktree, is a gitfile pointer. */
const HIDDEN_ENTRIES: ReadonlySet<string> = new Set(['.git'])

function parseEntry(value: unknown): CloudFileEntry | null {
  const name = readString(value, 'name')
  if (name === null || name === '' || name === '.' || name === '..' || HIDDEN_ENTRIES.has(name)) {
    return null
  }
  const isDirectory = readField(value, 'isDirectory') === true
  return {
    name,
    kind: isDirectory ? 'directory' : 'file',
    isSymlink: readField(value, 'isSymlink') === true
  }
}

function failure(outcome: Extract<CloudRpcOutcome, { ok: false }>): {
  ok: false
  code: string
  message?: string
} {
  return outcome.message === undefined
    ? { ok: false, code: outcome.code }
    : { ok: false, code: outcome.code, message: outcome.message }
}

export async function browseCloudDirectory(
  rpc: CloudRpc,
  workspacePath: string,
  relativePath: string = CLOUD_FILE_ROOT
): Promise<CloudBrowseOutcome> {
  const outcome = await rpc('files.readDir', {
    worktree: cloudWorktreeSelector(workspacePath),
    relativePath
  })
  if (!outcome.ok) {
    return failure(outcome)
  }
  const raw = readArrayValue(outcome.result)
  if (raw === null) {
    // A reply this client cannot read is not an empty directory: saying so would
    // hide a host-version mismatch behind a blank panel.
    return { ok: false, code: 'malformed_reply' }
  }
  const entries: CloudFileEntry[] = []
  for (const value of raw) {
    const entry = parseEntry(value)
    if (entry !== null) {
      entries.push(entry)
    }
  }
  return { ok: true, entries: sortCloudEntries(entries) }
}

export async function previewCloudFile(
  rpc: CloudRpc,
  workspacePath: string,
  relativePath: string
): Promise<CloudPreviewOutcome> {
  const outcome = await rpc('files.readPreview', {
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
  const mimeType = readString(outcome.result, 'mimeType')
  return {
    ok: true,
    preview: {
      content,
      isBinary: readField(outcome.result, 'isBinary') === true,
      isImage: readField(outcome.result, 'isImage') === true,
      ...(mimeType === null ? {} : { mimeType })
    }
  }
}
