import * as React from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { buildImageDataUri } from '../../../shared/image-data-uri'
import { cloudWorktreeSelector, type CloudRpc } from '../../../shared/cloud-file-browser'
import type { CloudProjectPermission, CloudRpcOutcome } from '../../../shared/cloud-platform-ipc'
import type { CloudSimpleWorkspaceTabComponentProps } from './cloud-simple-workspace'
import type { CloudSimpleWorkspaceTab } from './cloud-simple-workspace-tabs'
import { cloudWorkspaceFileLanguage } from './cloud-workspace-file-io'
import {
  parseCloudCommitParentOid,
  parseCloudWorkspaceDiff,
  type CloudWorkspaceDiff,
  type CloudWorkspaceDiffSource
} from './cloud-workspace-diff-tab-model'
import type { CloudWorkspaceDiffEditorProps } from './cloud-workspace-diff-tab-monaco'

/**
 * Diff tab for the embedded workspace (U46-7b, design §11.3 + §4.4).
 *
 * A working-tree row asks `git.diff` for staged:false + compareAgainstHead:true;
 * a commit row resolves its parent from `git.commitCompare.summary` (when the
 * caller did not already supply it) and reads both sides through
 * `git.commitDiff`. Text diffs render in Monaco's DiffEditor (side-by-side or
 * inline); binary image sides render as data URLs; an oversized diff renders a
 * metadata card instead of the editor, as the host already returns empty sides
 * plus `largeDiffRenderLimit`.
 */

type DiffTab = Extract<CloudSimpleWorkspaceTab, { kind: 'diff' }>

const WORKING_SOURCE: CloudWorkspaceDiffSource = { kind: 'working' }

const LazyDiffEditor = React.lazy(async () => {
  const module = await import('./cloud-workspace-diff-tab-monaco')
  return { default: module.CloudWorkspaceDiffMonaco }
})

type Loaded =
  | { status: 'loading' }
  | { status: 'ready'; diff: CloudWorkspaceDiff }
  | { status: 'failed'; code: string; message?: string }

export type CloudWorkspaceDiffTabApi = {
  rpc: CloudRpc
  workspacePath: string
  permissions?: readonly CloudProjectPermission[] | null
  /** Defaults to the working tree; commit rows pass the commit identity. */
  source?: CloudWorkspaceDiffSource
  /** Test/embedding seam; defaults to the lazy Monaco surface. */
  diffEditor?: React.ComponentType<CloudWorkspaceDiffEditorProps>
}

export type CloudWorkspaceDiffTabProps = CloudSimpleWorkspaceTabComponentProps &
  CloudWorkspaceDiffTabApi

function failure(outcome: Extract<CloudRpcOutcome, { ok: false }>): Loaded {
  return outcome.message === undefined
    ? { status: 'failed', code: outcome.code }
    : { status: 'failed', code: outcome.code, message: outcome.message }
}

function toLoaded(outcome: CloudRpcOutcome | null): Loaded {
  if (outcome === null) {
    return { status: 'failed', code: 'rpc_failed' }
  }
  if (!outcome.ok) {
    return failure(outcome)
  }
  const diff = parseCloudWorkspaceDiff(outcome.result)
  return diff === null ? { status: 'failed', code: 'malformed_reply' } : { status: 'ready', diff }
}

async function loadCloudWorkspaceDiff(
  rpc: CloudRpc,
  workspacePath: string,
  filePath: string,
  source: CloudWorkspaceDiffSource
): Promise<Loaded> {
  const worktree = cloudWorktreeSelector(workspacePath)
  if (source.kind === 'working') {
    return toLoaded(
      await rpc('git.diff', {
        worktree,
        filePath,
        staged: false,
        compareAgainstHead: true
      }).catch(() => null)
    )
  }
  if (source.commitOid === '') {
    return { status: 'failed', code: 'invalid_source', message: '缺少提交 ID' }
  }

  let parentOid = source.parentOid
  if (parentOid === undefined) {
    const compared = await rpc('git.commitCompare', {
      worktree,
      commitId: source.commitOid
    }).catch(() => null)
    if (compared === null) {
      return { status: 'failed', code: 'rpc_failed' }
    }
    if (!compared.ok) {
      return failure(compared)
    }
    const parsed = parseCloudCommitParentOid(compared.result)
    if (parsed === null) {
      return { status: 'failed', code: 'malformed_reply', message: '提交比较结果无法解析' }
    }
    parentOid = parsed.parentOid
  }

  return toLoaded(
    await rpc('git.commitDiff', {
      worktree,
      filePath,
      commitOid: source.commitOid,
      parentOid,
      ...(source.oldPath === undefined ? {} : { oldPath: source.oldPath })
    }).catch(() => null)
  )
}

function failureText(code: string, message?: string): string {
  return message === undefined ? code : `${code}：${message}`
}

function ImageDiffPane({
  label,
  side,
  content,
  mimeType,
  missingText
}: {
  label: string
  side: 'original' | 'modified'
  content: string
  mimeType: string | undefined
  missingText: string
}): React.JSX.Element {
  const src = buildImageDataUri(mimeType, content)
  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-md bg-muted/10">
      <div className="px-3 py-2 text-xs font-medium text-muted-foreground">{label}</div>
      <div className="flex min-h-32 flex-1 items-center justify-center overflow-auto scrollbar-sleek p-3">
        {src === null ? (
          <span className="text-xs text-muted-foreground">{missingText}</span>
        ) : (
          <img
            data-testid={`cloud-workspace-diff-image-${side}`}
            src={src}
            alt={label}
            className="max-h-full max-w-full object-contain"
          />
        )}
      </div>
    </div>
  )
}

function BinaryDiffBody({
  diff,
  sideBySide
}: {
  diff: Extract<CloudWorkspaceDiff, { kind: 'binary' }>
  sideBySide: boolean
}): React.JSX.Element {
  if (diff.isImage && diff.mimeType?.startsWith('image/')) {
    return (
      <div
        data-testid="cloud-workspace-diff-image"
        className={
          sideBySide
            ? 'grid min-h-0 flex-1 grid-cols-2 gap-3 p-3'
            : 'grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto scrollbar-sleek p-3'
        }
      >
        <ImageDiffPane
          label="原始"
          side="original"
          content={diff.originalContent}
          mimeType={diff.mimeType}
          missingText="无原始文件"
        />
        <ImageDiffPane
          label="修改后"
          side="modified"
          content={diff.modifiedContent}
          mimeType={diff.mimeType}
          missingText={diff.modifiedDeleted ? '文件已删除' : '无修改后文件'}
        />
      </div>
    )
  }
  return (
    <div
      data-testid="cloud-workspace-diff-binary"
      className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center text-xs text-muted-foreground"
    >
      <p className="text-foreground">二进制文件的差异无法以文本方式显示。</p>
      {diff.mimeType === undefined ? null : <p className="font-mono">{diff.mimeType}</p>}
      <p>请下载后比较，或使用本地客户端查看。</p>
    </div>
  )
}

function LargeDiffBody({
  path,
  diff
}: {
  path: string
  diff: Extract<CloudWorkspaceDiff, { kind: 'text' }>
}): React.JSX.Element {
  const notice = diff.largeDiff
  return (
    <div
      data-testid="cloud-workspace-diff-large"
      className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center text-xs text-muted-foreground"
    >
      <p className="text-foreground">该文件差异过大，已降级为概要。</p>
      <p className="break-all font-mono">{path}</p>
      {notice?.lineCounts === null || notice?.lineCounts === undefined ? null : (
        <p>
          原始 {notice.lineCounts.original} 行 · 修改后 {notice.lineCounts.modified} 行
        </p>
      )}
      {notice?.characterCount === null || notice?.characterCount === undefined ? null : (
        <p>合计字符数 {notice.characterCount}</p>
      )}
      {notice?.reason === null || notice?.reason === undefined ? null : (
        <p>原因：{notice.reason === 'line-count' ? '行数超限' : '字符数超限'}</p>
      )}
      <p>请使用本地客户端查看完整差异。</p>
    </div>
  )
}

function CloudWorkspaceDiffTabBody({
  tab,
  rpc,
  workspacePath,
  permissions,
  source,
  diffEditor
}: {
  tab: DiffTab
  rpc: CloudRpc
  workspacePath: string
  permissions?: readonly CloudProjectPermission[] | null
  source: CloudWorkspaceDiffSource
  diffEditor?: React.ComponentType<CloudWorkspaceDiffEditorProps>
}): React.JSX.Element {
  const canRead = permissions?.includes('file:read') ?? true
  const language = React.useMemo(() => cloudWorkspaceFileLanguage(tab.path), [tab.path])
  const [loaded, setLoaded] = React.useState<Loaded>({ status: 'loading' })
  const [sideBySide, setSideBySide] = React.useState(true)
  const [retryToken, setRetryToken] = React.useState(0)

  const sourceKind = source.kind
  const commitOid = source.kind === 'commit' ? source.commitOid : null
  const parentOid = source.kind === 'commit' ? source.parentOid : undefined
  const oldPath = source.kind === 'commit' ? source.oldPath : undefined
  const resolvedSource = React.useMemo<CloudWorkspaceDiffSource>(() => {
    if (sourceKind === 'working' || commitOid === null) {
      return WORKING_SOURCE
    }
    return {
      kind: 'commit',
      commitOid,
      ...(parentOid === undefined ? {} : { parentOid }),
      ...(oldPath === undefined ? {} : { oldPath })
    }
  }, [commitOid, oldPath, parentOid, sourceKind])

  React.useEffect(() => {
    if (!canRead) {
      return
    }
    let cancelled = false
    setLoaded({ status: 'loading' })
    void loadCloudWorkspaceDiff(rpc, workspacePath, tab.path, resolvedSource).then((next) => {
      if (!cancelled) {
        setLoaded(next)
      }
    })
    return () => {
      cancelled = true
    }
  }, [canRead, resolvedSource, retryToken, rpc, tab.path, workspacePath])

  if (!canRead) {
    return (
      <p
        data-testid="cloud-workspace-diff-denied"
        className="p-3 text-xs leading-relaxed text-muted-foreground"
      >
        当前项目未授予文件读取权限，无法查看差异。
      </p>
    )
  }

  const EditorComponent = diffEditor ?? LazyDiffEditor
  const sourceLabel =
    resolvedSource.kind === 'working' ? '工作区' : `提交 ${resolvedSource.commitOid.slice(0, 7)}`

  return (
    <section
      data-testid="cloud-workspace-diff-tab"
      className="flex h-full min-h-0 flex-col bg-background"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1">
        <span
          data-testid="cloud-workspace-diff-path"
          title={tab.path}
          className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground"
        >
          {tab.path}
        </span>
        <div role="group" aria-label="Diff 显示模式" className="flex items-center gap-1">
          <Button
            variant={sideBySide ? 'secondary' : 'ghost'}
            size="sm"
            data-testid="cloud-workspace-diff-mode-side-by-side"
            aria-pressed={sideBySide}
            onClick={() => setSideBySide(true)}
          >
            左右
          </Button>
          <Button
            variant={sideBySide ? 'ghost' : 'secondary'}
            size="sm"
            data-testid="cloud-workspace-diff-mode-inline"
            aria-pressed={!sideBySide}
            onClick={() => setSideBySide(false)}
          >
            合并
          </Button>
        </div>
        <Badge variant="outline" data-testid="cloud-workspace-diff-source">
          {sourceLabel}
        </Badge>
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
        {loaded.status === 'loading' ? (
          <p
            data-testid="cloud-workspace-diff-loading"
            className="p-3 text-xs text-muted-foreground"
          >
            读取差异…
          </p>
        ) : loaded.status === 'failed' ? (
          <div className="flex items-center gap-2 p-3 text-xs text-destructive">
            <span className="min-w-0 flex-1 break-all">
              {failureText(loaded.code, loaded.message)}
            </span>
            <Button variant="ghost" size="sm" onClick={() => setRetryToken((token) => token + 1)}>
              重试
            </Button>
          </div>
        ) : loaded.diff.kind === 'binary' ? (
          <BinaryDiffBody diff={loaded.diff} sideBySide={sideBySide} />
        ) : loaded.diff.largeDiff !== null ? (
          <LargeDiffBody path={tab.path} diff={loaded.diff} />
        ) : (
          <React.Suspense
            fallback={<p className="p-3 text-xs text-muted-foreground">正在加载编辑器…</p>}
          >
            <EditorComponent
              filePath={tab.path}
              original={loaded.diff.originalContent}
              modified={loaded.diff.modifiedContent}
              language={language}
              sideBySide={sideBySide}
            />
          </React.Suspense>
        )}
      </div>
    </section>
  )
}

export function CloudWorkspaceDiffTab(props: CloudWorkspaceDiffTabProps): React.JSX.Element {
  const { tab, rpc, workspacePath, permissions, source, diffEditor } = props
  if (tab.kind !== 'diff') {
    return (
      <p
        data-testid="cloud-workspace-diff-unsupported"
        className="p-3 text-xs text-muted-foreground"
      >
        该标签不是 Diff 标签。
      </p>
    )
  }
  return (
    <CloudWorkspaceDiffTabBody
      key={tab.path}
      tab={tab}
      rpc={rpc}
      workspacePath={workspacePath}
      permissions={permissions}
      source={source ?? WORKING_SOURCE}
      diffEditor={diffEditor}
    />
  )
}

/** Adapts the shell's per-tab props to one diff tab bound to an RPC. */
export function createCloudWorkspaceDiffTab(
  api: CloudWorkspaceDiffTabApi
): React.ComponentType<CloudSimpleWorkspaceTabComponentProps> {
  function CloudWorkspaceDiffTabFromApi({
    tab,
    active,
    dispatch
  }: CloudSimpleWorkspaceTabComponentProps): React.JSX.Element {
    return <CloudWorkspaceDiffTab tab={tab} active={active} dispatch={dispatch} {...api} />
  }
  return CloudWorkspaceDiffTabFromApi
}
