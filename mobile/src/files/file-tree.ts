import { MEDIA_FILE_MIME_TYPES } from '../../../src/shared/media-file-extensions'
// Pure tree projection for the mobile file explorer. Mobile mirrors desktop
// browse semantics by flattening cached files.readDir results as folders open.
import { compareFileNames } from '../../../src/shared/file-name-sort'
import { matchesFileCategory, type MobileFileCategory } from './file-category'

export type MobileDirEntry = {
  name: string
  isDirectory: boolean
  isSymlink?: boolean
}

export type MobileFileKind = 'text' | 'binary'

export type TreeNode = {
  id: string
  name: string
  relativePath: string
  depth: number
  kind: 'directory' | MobileFileKind
  isSymlink?: boolean
  /** A directory whose contents are not in the cache, retained while a filter is active. */
  filterNote?: 'not loaded'
}

export type DirectoryState = {
  entries: MobileDirEntry[]
  loading?: boolean
  error?: string
}

export type DirectoryCache = Record<string, DirectoryState | undefined>

export type InlineStatusNode = {
  id: string
  relativePath: string
  depth: number
  kind: 'loading' | 'error'
  message?: string
}

export type FileExplorerRow = TreeNode | InlineStatusNode

const DESKTOP_EXCLUDED_NAMES = new Set(['.git', 'node_modules'])
const BINARY_EXTENSIONS = new Set([
  ...Object.keys(MEDIA_FILE_MIME_TYPES),
  '.avif',
  '.bmp',
  '.gif',
  '.heic',
  '.ico',
  '.jpeg',
  '.jpg',
  '.mov',
  '.mp3',
  '.mp4',
  '.pdf',
  '.png',
  '.webp',
  '.zip'
])

export function flattenDirectoryCache(
  cache: DirectoryCache,
  expanded: ReadonlySet<string>,
  category: MobileFileCategory = 'all'
): FileExplorerRow[] {
  const rows: FileExplorerRow[] = []
  visitDirectory('', 0, cache, expanded, rows, category)
  return rows
}

function visitDirectory(
  relativePath: string,
  depth: number,
  cache: DirectoryCache,
  expanded: ReadonlySet<string>,
  rows: FileExplorerRow[],
  category: MobileFileCategory
): void {
  const state = getDirectoryCacheState(cache, relativePath)
  const entries = state?.entries ?? []
  const visibleEntries = entries
    .filter(shouldIncludeMobileFileExplorerEntry)
    .sort(compareDirectoryEntries)

  for (const entry of visibleEntries) {
    const childPath = joinRelativePath(relativePath, entry.name)
    if (entry.isDirectory) {
      // A loaded directory with no matching descendant disappears; an unloaded one is kept
      // because the client cannot know what it contains (and says so on the row).
      if (
        category !== 'all' &&
        !directoryHasFilteredDescendant(childPath, cache, category, new Set())
      ) {
        continue
      }
    } else if (!matchesFileCategory(childPath, category)) {
      continue
    }
    const node = toTreeNode(entry, childPath, depth)
    if (
      entry.isDirectory &&
      category !== 'all' &&
      getDirectoryCacheState(cache, childPath) === undefined
    ) {
      node.filterNote = 'not loaded'
    }
    rows.push(node)
    if (entry.isDirectory && expanded.has(childPath)) {
      const childState = getDirectoryCacheState(cache, childPath)
      if (childState?.loading) {
        rows.push({
          id: `loading:${childPath}`,
          relativePath: childPath,
          depth: depth + 1,
          kind: 'loading'
        })
      } else if (childState?.error) {
        rows.push({
          id: `error:${childPath}`,
          relativePath: childPath,
          depth: depth + 1,
          kind: 'error',
          message: childState.error
        })
      } else {
        visitDirectory(childPath, depth + 1, cache, expanded, rows, category)
      }
    }
  }
}

function directoryHasFilteredDescendant(
  relativePath: string,
  cache: DirectoryCache,
  category: MobileFileCategory,
  seen: Set<string>
): boolean {
  if (seen.has(relativePath)) {
    return false
  }
  const state = getDirectoryCacheState(cache, relativePath)
  // Not loaded, loading, or failed: keep the directory so the user can expand/retry it.
  if (!state || state.loading || state.error) {
    return true
  }
  seen.add(relativePath)
  const matches = state.entries.some((entry) => {
    if (!shouldIncludeMobileFileExplorerEntry(entry)) {
      return false
    }
    const childPath = joinRelativePath(relativePath, entry.name)
    return entry.isDirectory
      ? directoryHasFilteredDescendant(childPath, cache, category, seen)
      : matchesFileCategory(childPath, category)
  })
  seen.delete(relativePath)
  return matches
}

function toTreeNode(entry: MobileDirEntry, relativePath: string, depth: number): TreeNode {
  return {
    id: `${entry.isDirectory ? 'dir' : 'file'}:${relativePath}`,
    name: entry.name,
    relativePath,
    depth,
    kind: entry.isDirectory ? 'directory' : getMobileFileKind(relativePath),
    isSymlink: entry.isSymlink
  }
}

function compareDirectoryEntries(a: MobileDirEntry, b: MobileDirEntry): number {
  if (a.isDirectory !== b.isDirectory) {
    return a.isDirectory ? -1 : 1
  }
  return compareFileNames(a.name, b.name)
}

export function shouldIncludeMobileFileExplorerEntry(entry: MobileDirEntry): boolean {
  return !DESKTOP_EXCLUDED_NAMES.has(entry.name)
}

export function getDirectoryCacheState(
  cache: DirectoryCache,
  relativePath: string
): DirectoryState | undefined {
  // Why: repository paths are arbitrary object keys; inherited keys like
  // "constructor" must not masquerade as loaded directory state.
  return Object.hasOwn(cache, relativePath) ? cache[relativePath] : undefined
}

export function joinRelativePath(parentPath: string, name: string): string {
  return parentPath ? `${parentPath}/${name}` : name
}

export function getMobileFileKind(relativePath: string): MobileFileKind {
  const basename = relativePath.split('/').pop() ?? relativePath
  const dotIndex = basename.lastIndexOf('.')
  if (dotIndex <= 0) {
    return 'text'
  }
  return BINARY_EXTENSIONS.has(basename.slice(dotIndex).toLowerCase()) ? 'binary' : 'text'
}

export function isMarkdownPath(relativePath: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(relativePath)
}
