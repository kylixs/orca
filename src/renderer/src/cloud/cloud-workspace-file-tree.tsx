import * as React from 'react'
import { ChevronDown, ChevronRight, File, Folder, FolderOpen, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { FileExplorerNameFilter } from '@/components/right-sidebar/FileExplorerNameFilter'
import {
  CLOUD_FILE_ROOT,
  browseCloudDirectory,
  cloudChildPath,
  type CloudFileEntry,
  type CloudRpc
} from '../../../shared/cloud-file-browser'

/**
 * Lazily-loaded file tree for the right rail of the embedded workspace (U46-6,
 * design §4.6 / §11.2). Directories load one level on first expand and stay
 * cached until "刷新"; the host decides reachability through `files.readDir`.
 *
 * Adapted from the Orca web explorer (`useFileExplorerTree` + FileExplorer):
 * per-directory cache, per-directory loading set, refresh re-reads the root and
 * every expanded level, and superseded replies are dropped. That explorer cannot
 * be imported here — its listing path goes through the desktop store and the
 * preload runtime client, while this surface speaks `files.readDir` over the
 * cloud link. Its name-filter bar is pure, so it IS reused as-is below.
 * Sorting comes from `browseCloudDirectory` (`sortCloudEntries`), the cloud twin
 * of the explorer's `sortDirEntries`.
 *
 * Filtering is client-side over what has been loaded. Directories that were
 * never expanded are reported with a hint rather than searched, because
 * walking the whole checkout would turn a keystroke into an unbounded crawl.
 */

type DirectoryState =
  | { status: 'loading' }
  | { status: 'ready'; entries: CloudFileEntry[] }
  | { status: 'failed'; code: string; message?: string }

type FilterMatch = { path: string; kind: CloudFileEntry['kind'] }

export type CloudWorkspaceFileTreeProps = {
  rpc: CloudRpc
  /** The signed checkout root from `workspace.info`. */
  workspacePath: string
  /** False when the ticket lacks `file:read`; renders the §4.9 degraded pane. */
  canReadFiles?: boolean
  /** Called with the checkout-relative path of a clicked file. */
  onOpenFile: (path: string) => void
}

// Same wording as the file pane (cloud-file-panel.tsx) so the two surfaces agree.
function failureText(code: string, message?: string): string {
  if (code === 'forbidden') {
    return message ?? '无权访问该路径'
  }
  return message ? `${code}：${message}` : code
}

export function CloudWorkspaceFileTree({
  rpc,
  workspacePath,
  canReadFiles = true,
  onOpenFile
}: CloudWorkspaceFileTreeProps): React.JSX.Element {
  const [directories, setDirectories] = React.useState<Record<string, DirectoryState>>({})
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(() => new Set())
  const [filter, setFilter] = React.useState('')
  const [refreshToken, setRefreshToken] = React.useState(0)
  // Generation discards replies that belong to a previous workspace or refresh.
  const generation = React.useRef(0)
  const inFlight = React.useRef(new Set<string>())
  const expandedRef = React.useRef<ReadonlySet<string>>(expanded)
  const directoriesRef = React.useRef(directories)
  const lastWorkspace = React.useRef<string | null>(null)

  React.useEffect(() => {
    directoriesRef.current = directories
  }, [directories])

  const loadDirectory = React.useCallback(
    (relativePath: string, requestGeneration: number) => {
      if (inFlight.current.has(relativePath)) {
        return
      }
      inFlight.current.add(relativePath)
      setDirectories((previous) => ({ ...previous, [relativePath]: { status: 'loading' } }))
      void browseCloudDirectory(rpc, workspacePath, relativePath)
        .then((outcome) => {
          inFlight.current.delete(relativePath)
          if (requestGeneration !== generation.current) {
            return
          }
          setDirectories((previous) => ({
            ...previous,
            [relativePath]: outcome.ok
              ? { status: 'ready', entries: outcome.entries }
              : { status: 'failed', code: outcome.code, message: outcome.message }
          }))
        })
        .catch(() => {
          inFlight.current.delete(relativePath)
          if (requestGeneration !== generation.current) {
            return
          }
          setDirectories((previous) => ({
            ...previous,
            [relativePath]: { status: 'failed', code: 'rpc_failed' }
          }))
        })
    },
    [rpc, workspacePath]
  )

  React.useEffect(() => {
    if (!canReadFiles) {
      return
    }
    const requestGeneration = ++generation.current
    inFlight.current.clear()
    let targets = [CLOUD_FILE_ROOT]
    if (lastWorkspace.current !== workspacePath) {
      // A different checkout shares no relative paths, so start collapsed.
      lastWorkspace.current = workspacePath
      expandedRef.current = new Set()
      setExpanded(expandedRef.current)
    } else {
      // Refresh keeps the user's expansions and re-pulls each open level.
      targets = [CLOUD_FILE_ROOT, ...expandedRef.current]
    }
    setDirectories({})
    for (const path of targets) {
      loadDirectory(path, requestGeneration)
    }
  }, [canReadFiles, loadDirectory, refreshToken, workspacePath])

  const retryOrLoad = (path: string): void => {
    const state = directoriesRef.current[path]
    if (state === undefined || state.status === 'failed') {
      loadDirectory(path, generation.current)
    }
  }

  const toggleDirectory = (path: string): void => {
    const next = new Set(expandedRef.current)
    if (next.has(path)) {
      next.delete(path)
    } else {
      next.add(path)
      retryOrLoad(path)
    }
    expandedRef.current = next
    setExpanded(next)
  }

  const revealDirectory = (path: string): void => {
    const next = new Set(expandedRef.current)
    const segments = path.split('/')
    for (let index = 1; index <= segments.length; index += 1) {
      const ancestor = segments.slice(0, index).join('/')
      next.add(ancestor)
      retryOrLoad(ancestor)
    }
    expandedRef.current = next
    setExpanded(next)
    setFilter('')
  }

  if (!canReadFiles) {
    return (
      <p
        data-testid="cloud-workspace-file-tree-no-permission"
        className="p-3 text-xs leading-relaxed text-muted-foreground"
      >
        当前项目未授予文件读取权限，文件面板不可用。
      </p>
    )
  }

  const query = filter.trim().toLowerCase()
  const matches: FilterMatch[] = []
  if (query !== '') {
    for (const [directory, state] of Object.entries(directories)) {
      if (state.status !== 'ready') {
        continue
      }
      for (const entry of state.entries) {
        if (!entry.name.toLowerCase().includes(query)) {
          continue
        }
        const path = cloudChildPath(directory, entry.name)
        if (path !== null) {
          matches.push({ path, kind: entry.kind })
        }
      }
    }
    matches.sort((left, right) => left.path.localeCompare(right.path))
  }
  // Directories whose contents were never fetched are outside the filter's reach.
  const hasUnloadedDirectories = Object.entries(directories).some(
    ([directory, state]) =>
      state.status === 'ready' &&
      state.entries.some((entry) => {
        if (entry.kind !== 'directory') {
          return false
        }
        const path = cloudChildPath(directory, entry.name)
        return path !== null && directories[path] === undefined
      })
  )
  const loading = Object.values(directories).some((state) => state.status === 'loading')

  function renderNode(entry: CloudFileEntry, parentPath: string): React.JSX.Element | null {
    const path = cloudChildPath(parentPath, entry.name)
    if (path === null) {
      return null
    }
    if (entry.kind === 'directory') {
      const open = expanded.has(path)
      return (
        <div key={path} role="treeitem" aria-expanded={open} aria-label={entry.name}>
          <button
            type="button"
            data-testid={`cloud-workspace-file-tree-node-${path}`}
            className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs text-foreground hover:bg-muted"
            onClick={() => toggleDirectory(path)}
          >
            {open ? (
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            {open ? (
              <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <Folder className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            {entry.isSymlink ? <span className="text-muted-foreground">链接</span> : null}
          </button>
          {open ? renderEntries(path) : null}
        </div>
      )
    }
    return (
      <div key={path} role="treeitem" aria-label={entry.name}>
        <button
          type="button"
          data-testid={`cloud-workspace-file-tree-node-${path}`}
          className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs text-foreground hover:bg-muted"
          onClick={() => onOpenFile(path)}
        >
          <File className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{entry.name}</span>
          {entry.isSymlink ? <span className="text-muted-foreground">链接</span> : null}
        </button>
      </div>
    )
  }

  function renderEntries(directory: string): React.JSX.Element {
    const state = directories[directory]
    if (state === undefined || state.status === 'loading') {
      return (
        <p className="flex items-center gap-1.5 px-1.5 py-1 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          正在读取…
        </p>
      )
    }
    if (state.status === 'failed') {
      return (
        <p
          data-testid={`cloud-workspace-file-tree-error-${directory}`}
          className="px-1.5 py-1 text-xs text-destructive"
        >
          {failureText(state.code, state.message)}
        </p>
      )
    }
    if (state.entries.length === 0) {
      return <p className="px-1.5 py-1 text-xs text-muted-foreground">空目录</p>
    }
    return (
      <div className="pl-3" role="group">
        {state.entries.map((entry) => renderNode(entry, directory))}
      </div>
    )
  }

  return (
    <div
      data-testid="cloud-workspace-file-tree"
      className="flex min-h-0 flex-1 flex-col gap-2 p-2"
      aria-label="工作区文件树"
    >
      <div className="flex items-center gap-1.5">
        <div className="min-w-0 flex-1" data-testid="cloud-workspace-file-tree-filter">
          <FileExplorerNameFilter
            query={filter}
            loading={loading}
            onQueryChange={setFilter}
            onClear={() => setFilter('')}
          />
        </div>
        <Button
          variant="ghost"
          size="xs"
          data-testid="cloud-workspace-file-tree-refresh"
          onClick={() => setRefreshToken((token) => token + 1)}
        >
          刷新
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
        {query === '' ? (
          <div role="tree" aria-label="工作区文件" data-testid="cloud-workspace-file-tree-nodes">
            {renderEntries(CLOUD_FILE_ROOT)}
          </div>
        ) : (
          <div data-testid="cloud-workspace-file-tree-matches" className="flex flex-col">
            {matches.length === 0 ? (
              <p className="px-1.5 py-1 text-xs text-muted-foreground">
                {loading ? '正在读取…' : '没有匹配的文件'}
              </p>
            ) : (
              matches.map((match) => (
                <button
                  key={match.path}
                  type="button"
                  data-testid={`cloud-workspace-file-tree-match-${match.path}`}
                  className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs text-foreground hover:bg-muted"
                  onClick={() => {
                    if (match.kind === 'directory') {
                      revealDirectory(match.path)
                    } else {
                      onOpenFile(match.path)
                    }
                  }}
                >
                  {match.kind === 'directory' ? (
                    <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <File className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1 truncate font-mono">{match.path}</span>
                </button>
              ))
            )}
            {hasUnloadedDirectories ? (
              <p
                data-testid="cloud-workspace-file-tree-filter-hint"
                className="px-1.5 py-1 text-xs text-muted-foreground"
              >
                未展开的目录中可能还有匹配
              </p>
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}
