import * as React from 'react'
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { STATUS_COLORS, STATUS_LABELS } from '@/components/right-sidebar/status-display'
import { cloudWorktreeSelector, type CloudRpc } from '../../../shared/cloud-file-browser'
import type { CloudRpcOutcome } from '../../../shared/cloud-platform-ipc'
import type { GitFileStatus } from '../../../shared/git-status-types'
import {
  cloudGitRelativeTime,
  groupCloudGitChanges,
  parseCloudGitCommitCompare,
  parseCloudGitHistory,
  parseCloudGitStatus,
  shortHash,
  splitPath,
  type CloudWorkspaceGitChange,
  type CloudWorkspaceGitCommit,
  type CloudWorkspaceGitCommitFiles
} from './cloud-workspace-git-panel-model'
import type { CloudWorkspaceDiffSource } from './cloud-workspace-diff-tab-model'

/**
 * Git changes pane for the right rail (U46-6b, design §11.3): working-tree
 * changes grouped by status above, recent commits below. A file click asks the
 * shell for a diff tab; expanding a commit lazily lists its files through
 * `git.commitCompare`.
 *
 * Grouping reuses Source Control's dominant-status rule (`status-display.ts`),
 * and rows reuse its M/A/D letters and decoration colors, so the cloud rail and
 * the desktop rail read the same.
 */

export type CloudWorkspaceGitPanelProps = {
  rpc: CloudRpc
  /** The signed checkout root from `workspace.info`. */
  workspacePath: string
  /** False when the ticket lacks `file:read`; renders the §4.9 degraded pane. */
  canReadFiles?: boolean
  /**
   * Ask the shell to open a diff tab. Status is the git status the row was
   * filed under; commit rows also pass the commit identity (U50).
   */
  onOpenDiff?: (path: string, status: GitFileStatus, source?: CloudWorkspaceDiffSource) => void
}

const HISTORY_LIMIT = 30

const EMPTY_COMMIT_FILES: Record<string, PanelLoad<CloudWorkspaceGitCommitFiles>> = {}

type PanelLoad<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'failed'; code: string; message?: string }

function toPanelLoad<T>(
  outcome: CloudRpcOutcome | null,
  parse: (result: unknown) => T | null
): PanelLoad<T> {
  if (outcome === null) {
    return { status: 'failed', code: 'rpc_failed' }
  }
  if (!outcome.ok) {
    return { status: 'failed', code: outcome.code, message: outcome.message }
  }
  const data = parse(outcome.result)
  return data === null ? { status: 'failed', code: 'malformed_reply' } : { status: 'ready', data }
}

function failureText(code: string, message?: string): string {
  return message === undefined ? code : `${code}：${message}`
}

function GitFileRow({
  change,
  testId,
  onOpen
}: {
  change: CloudWorkspaceGitChange
  testId: string
  onOpen: (path: string, status: GitFileStatus) => void
}): React.JSX.Element {
  const { name, directory } = splitPath(change.path)
  return (
    <button
      type="button"
      data-testid={testId}
      title={change.path}
      className="flex w-full min-w-0 items-center gap-1.5 px-3 py-1 text-left text-xs hover:bg-accent/40"
      onClick={() => onOpen(change.path, change.status)}
    >
      <span className="min-w-0 flex-1 truncate">
        <span className="text-foreground">{name}</span>
        {directory === '' ? null : (
          <span className="ml-1.5 text-[11px] text-muted-foreground">{directory}</span>
        )}
      </span>
      <span
        className="w-4 shrink-0 text-center text-[10px] font-bold"
        style={{ color: STATUS_COLORS[change.status] }}
      >
        {STATUS_LABELS[change.status]}
      </span>
    </button>
  )
}

function LoadingRow({ text }: { text: string }): React.JSX.Element {
  return (
    <p className="flex items-center gap-2 px-3 py-2 text-[11px] text-muted-foreground">
      <RefreshCw className="size-3 animate-spin" />
      {text}
    </p>
  )
}

function FailedRow({
  code,
  message,
  onRetry
}: {
  code: string
  message?: string
  onRetry: () => void
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-destructive">
      <span className="min-w-0 flex-1 truncate">{failureText(code, message)}</span>
      <Button variant="ghost" size="sm" onClick={onRetry}>
        重试
      </Button>
    </div>
  )
}

export function CloudWorkspaceGitPanel({
  rpc,
  workspacePath,
  canReadFiles = true,
  onOpenDiff
}: CloudWorkspaceGitPanelProps): React.JSX.Element {
  const [changes, setChanges] = React.useState<PanelLoad<CloudWorkspaceGitChange[]>>({
    status: 'loading'
  })
  const [history, setHistory] = React.useState<PanelLoad<CloudWorkspaceGitCommit[]>>({
    status: 'loading'
  })
  const [refreshToken, setRefreshToken] = React.useState(0)
  // Expansion and its file cache are keyed by this; a refresh or workspace
  // change invalidates them without a prop-change state reset in the effect.
  const requestKey = `${workspacePath}\u0000${refreshToken}`
  const [expanded, setExpanded] = React.useState<{ key: string; commitId: string | null }>({
    key: '',
    commitId: null
  })
  const [commitFiles, setCommitFiles] = React.useState<{
    key: string
    files: Record<string, PanelLoad<CloudWorkspaceGitCommitFiles>>
  }>({ key: '', files: {} })
  const generation = React.useRef(0)
  const expandedCommitId = expanded.key === requestKey ? expanded.commitId : null
  const filesByCommit = commitFiles.key === requestKey ? commitFiles.files : EMPTY_COMMIT_FILES

  const refresh = React.useCallback(() => setRefreshToken((token) => token + 1), [])

  React.useEffect(() => {
    if (!canReadFiles) {
      return
    }
    const token = ++generation.current
    setChanges({ status: 'loading' })
    setHistory({ status: 'loading' })
    void Promise.all([
      rpc('git.status', { worktree: cloudWorktreeSelector(workspacePath) }).catch(() => null),
      rpc('git.history', {
        worktree: cloudWorktreeSelector(workspacePath),
        limit: HISTORY_LIMIT
      }).catch(() => null)
    ]).then(([statusOutcome, historyOutcome]) => {
      if (token !== generation.current) {
        return
      }
      setChanges(toPanelLoad(statusOutcome, parseCloudGitStatus))
      setHistory(toPanelLoad(historyOutcome, parseCloudGitHistory))
    })
  }, [canReadFiles, rpc, refreshToken, workspacePath])

  const loadCommitFiles = React.useCallback(
    (commitId: string) => {
      const token = generation.current
      setCommitFiles((previous) => ({
        key: requestKey,
        files: {
          ...(previous.key === requestKey ? previous.files : {}),
          [commitId]: { status: 'loading' }
        }
      }))
      void rpc('git.commitCompare', {
        worktree: cloudWorktreeSelector(workspacePath),
        commitId
      })
        .catch(() => null)
        .then((outcome) => {
          if (token !== generation.current) {
            return
          }
          setCommitFiles((previous) => ({
            key: requestKey,
            files: {
              ...(previous.key === requestKey ? previous.files : {}),
              [commitId]: toPanelLoad(outcome, parseCloudGitCommitCompare)
            }
          }))
        })
    },
    [rpc, workspacePath, requestKey]
  )

  const toggleCommit = (commit: CloudWorkspaceGitCommit): void => {
    if (expandedCommitId === commit.id) {
      setExpanded({ key: requestKey, commitId: null })
      return
    }
    setExpanded({ key: requestKey, commitId: commit.id })
    if (filesByCommit[commit.id] === undefined) {
      loadCommitFiles(commit.id)
    }
  }

  const openDiff = (path: string, status: GitFileStatus): void => {
    onOpenDiff?.(path, status)
  }

  if (!canReadFiles) {
    return (
      <p
        data-testid="cloud-workspace-git-no-permission"
        className="p-3 text-xs leading-relaxed text-muted-foreground"
      >
        当前项目未授予文件读取权限，无法查看变更与提交记录。
      </p>
    )
  }

  const groups = changes.status === 'ready' ? groupCloudGitChanges(changes.data) : []

  return (
    <div data-testid="cloud-workspace-git-panel" className="flex min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between px-3 py-2">
        <span className="text-[11px] font-medium text-muted-foreground">工作区变更</span>
        <Button
          variant="ghost"
          size="sm"
          data-testid="cloud-workspace-git-refresh"
          title="刷新变更与提交记录"
          onClick={refresh}
        >
          <RefreshCw className="size-3.5" />
        </Button>
      </div>

      <section
        data-testid="cloud-workspace-git-changes"
        className="shrink-0 border-b border-border pb-2"
      >
        {changes.status === 'loading' ? <LoadingRow text="读取变更…" /> : null}
        {changes.status === 'failed' ? (
          <FailedRow code={changes.code} message={changes.message} onRetry={refresh} />
        ) : null}
        {changes.status === 'ready' && groups.length === 0 ? (
          <p className="px-3 py-2 text-[11px] text-muted-foreground">工作区没有未提交的变更。</p>
        ) : null}
        {groups.map((group) => (
          <div key={group.status} data-testid={`cloud-workspace-git-group-${group.status}`}>
            <p className="flex items-center gap-1 px-3 py-1 text-[11px] text-muted-foreground">
              <span>{group.label}</span>
              <span>{group.changes.length}</span>
            </p>
            {group.changes.map((change) => (
              <GitFileRow
                key={change.path}
                change={change}
                testId={`cloud-workspace-git-change-${change.path}`}
                onOpen={openDiff}
              />
            ))}
          </div>
        ))}
      </section>

      <section data-testid="cloud-workspace-git-history" className="min-h-0 flex-1 pb-2">
        <p className="px-3 py-2 text-[11px] font-medium text-muted-foreground">提交记录</p>
        {history.status === 'loading' ? <LoadingRow text="读取提交记录…" /> : null}
        {history.status === 'failed' ? (
          <FailedRow code={history.code} message={history.message} onRetry={refresh} />
        ) : null}
        {history.status === 'ready' && history.data.length === 0 ? (
          <p className="px-3 py-2 text-[11px] text-muted-foreground">暂无提交记录。</p>
        ) : null}
        {history.status === 'ready'
          ? history.data.map((commit) => {
              const expanded = expandedCommitId === commit.id
              const files = filesByCommit[commit.id]
              return (
                <div key={commit.id}>
                  <button
                    type="button"
                    data-testid={`cloud-workspace-git-commit-${commit.id}`}
                    aria-expanded={expanded}
                    title={commit.subject}
                    className="flex w-full min-w-0 items-start gap-1.5 px-3 py-1.5 text-left text-xs hover:bg-accent/40"
                    onClick={() => toggleCommit(commit)}
                  >
                    {expanded ? (
                      <ChevronDown className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-foreground">{commit.subject}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {shortHash(commit)}
                        {commit.author === undefined ? '' : ` · ${commit.author}`}
                        {commit.timestamp === undefined
                          ? ''
                          : ` · ${cloudGitRelativeTime(commit.timestamp)}`}
                      </span>
                    </span>
                  </button>
                  {expanded ? (
                    <div data-testid={`cloud-workspace-git-commit-files-${commit.id}`}>
                      {files === undefined || files.status === 'loading' ? (
                        <LoadingRow text="读取提交文件…" />
                      ) : null}
                      {files?.status === 'failed' ? (
                        <FailedRow
                          code={files.code}
                          message={files.message}
                          onRetry={() => loadCommitFiles(commit.id)}
                        />
                      ) : null}
                      {files?.status === 'ready' && files.data.changes.length === 0 ? (
                        <p className="px-6 py-1 text-[11px] text-muted-foreground">
                          该提交没有文件变更。
                        </p>
                      ) : null}
                      {files?.status === 'ready'
                        ? files.data.changes.map((change) => (
                            <GitFileRow
                              key={change.path}
                              change={change}
                              testId={`cloud-workspace-git-commit-file-${change.path}`}
                              onOpen={(path, status) =>
                                onOpenDiff?.(path, status, {
                                  kind: 'commit',
                                  commitOid: commit.id,
                                  parentOid: files.data.parentOid
                                })
                              }
                            />
                          ))
                        : null}
                    </div>
                  ) : null}
                </div>
              )
            })
          : null}
      </section>
    </div>
  )
}
