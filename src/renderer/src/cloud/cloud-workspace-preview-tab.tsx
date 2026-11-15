import * as React from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  previewCloudFile,
  type CloudFilePreview,
  type CloudRpc
} from '../../../shared/cloud-file-browser'
import type { CloudProjectPermission } from '../../../shared/cloud-platform-ipc'
import type { CloudSimpleWorkspaceTabComponentProps } from './cloud-simple-workspace'
import type { CloudSimpleWorkspaceTab } from './cloud-simple-workspace-tabs'
import {
  cloudImageMimeType,
  resolveCloudFileFormat,
  type CloudFileMode
} from './file-renderers/registry'

/**
 * Binary host for the embedded workspace (U46-7b, FS-1).
 *
 * The registry picks the renderer; images/PDF/binaries stay here, while text
 * formats (Markdown/HTML/drawio) are opened by the editor host. Everything
 * previewable comes from one `files.readPreview` call. PDF is classified before
 * the read so an unrenderable file never spends the project's read budget.
 */

type PreviewTab = Extract<CloudSimpleWorkspaceTab, { kind: 'preview' }>

export type CloudWorkspacePreviewKind = 'image' | 'html' | 'drawio' | 'pdf' | 'binary'

/** Legacy classifier retained for callers/tests; backed by the registry. */
export function cloudWorkspacePreviewKind(relativePath: string): CloudWorkspacePreviewKind {
  const id = resolveCloudFileFormat(relativePath).id
  if (id === 'image' || id === 'html' || id === 'drawio' || id === 'pdf') {
    return id
  }
  return 'binary'
}

/** True for a known binary extension; unknown files fall back to the read heuristic. */
export function isCloudWorkspaceBinaryPath(relativePath: string): boolean {
  return resolveCloudFileFormat(relativePath).id === 'binary'
}

type Loaded =
  | { status: 'loading' }
  | { status: 'ready'; preview: CloudFilePreview }
  | { status: 'failed'; code: string; message?: string }

export type CloudWorkspacePreviewTabApi = {
  rpc: CloudRpc
  workspacePath: string
  permissions?: readonly CloudProjectPermission[] | null
}

export type CloudWorkspacePreviewTabProps = CloudSimpleWorkspaceTabComponentProps &
  CloudWorkspacePreviewTabApi

function failureText(code: string, message?: string): string {
  return message === undefined ? code : `${code}：${message}`
}

function CloudWorkspacePreviewTabBody({
  tab,
  rpc,
  workspacePath,
  permissions
}: {
  tab: PreviewTab
  rpc: CloudRpc
  workspacePath: string
  permissions?: readonly CloudProjectPermission[] | null
}): React.JSX.Element {
  const canRead = permissions?.includes('file:read') ?? true
  const renderer = React.useMemo(() => resolveCloudFileFormat(tab.path), [tab.path])
  const Renderer = renderer.component
  const [loaded, setLoaded] = React.useState<Loaded>({ status: 'loading' })
  const [retryToken, setRetryToken] = React.useState(0)
  const [htmlMode, setHtmlMode] = React.useState<CloudFileMode>('preview')

  React.useEffect(() => {
    if (!canRead || renderer.id === 'pdf') {
      return
    }
    let cancelled = false
    setLoaded({ status: 'loading' })
    void previewCloudFile(rpc, workspacePath, tab.path).then((outcome) => {
      if (cancelled) {
        return
      }
      setLoaded(
        outcome.ok
          ? { status: 'ready', preview: outcome.preview }
          : { status: 'failed', code: outcome.code, message: outcome.message }
      )
    })
    return () => {
      cancelled = true
    }
  }, [canRead, renderer.id, retryToken, rpc, tab.path, workspacePath])

  if (!canRead) {
    return (
      <p
        data-testid="cloud-workspace-preview-denied"
        className="p-3 text-xs leading-relaxed text-muted-foreground"
      >
        当前项目未授予文件读取权限，预览不可用。
      </p>
    )
  }

  const badgeLabel =
    renderer.id === 'image'
      ? '图片'
      : renderer.id === 'html'
        ? 'HTML'
        : renderer.id === 'drawio'
          ? 'drawio 源码'
          : renderer.id === 'pdf'
            ? 'PDF'
            : renderer.id === 'markdown'
              ? 'Markdown'
              : '二进制'

  const canSwitchHtml = renderer.id === 'html' && renderer.canPreview && renderer.canEditSource

  return (
    <section
      data-testid="cloud-workspace-preview-tab"
      className="flex h-full min-h-0 flex-col bg-background"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1">
        <span
          data-testid="cloud-workspace-preview-path"
          title={tab.path}
          className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground"
        >
          {tab.path}
        </span>
        {canSwitchHtml ? (
          <div role="group" aria-label="HTML 显示模式" className="flex items-center gap-1">
            <Button
              variant={htmlMode === 'preview' ? 'secondary' : 'ghost'}
              size="sm"
              data-testid="cloud-workspace-preview-mode-preview"
              aria-pressed={htmlMode === 'preview'}
              onClick={() => setHtmlMode('preview')}
            >
              预览
            </Button>
            <Button
              variant={htmlMode === 'source' ? 'secondary' : 'ghost'}
              size="sm"
              data-testid="cloud-workspace-preview-mode-source"
              aria-pressed={htmlMode === 'source'}
              onClick={() => setHtmlMode('source')}
            >
              源码
            </Button>
          </div>
        ) : null}
        <Badge variant="outline" data-testid="cloud-workspace-preview-kind">
          {badgeLabel}
        </Badge>
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
        {renderer.id === 'pdf' ? (
          <React.Suspense fallback={<p className="p-3 text-xs text-muted-foreground">加载中…</p>}>
            <Renderer
              path={tab.path}
              mode="preview"
              readOnly
              testId="cloud-workspace-preview-pdf"
            />
          </React.Suspense>
        ) : loaded.status === 'loading' ? (
          <p
            data-testid="cloud-workspace-preview-loading"
            className="p-3 text-xs text-muted-foreground"
          >
            读取预览…
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
        ) : renderer.source === 'binary' ? (
          <React.Suspense fallback={<p className="p-3 text-xs text-muted-foreground">加载中…</p>}>
            <Renderer
              path={tab.path}
              mode="preview"
              readOnly
              binary={{
                base64: loaded.preview.content,
                mimeType:
                  loaded.preview.mimeType ??
                  (renderer.id === 'image' ? cloudImageMimeType(tab.path) : null)
              }}
              testId={renderer.id === 'image' ? undefined : 'cloud-workspace-preview-binary'}
            />
          </React.Suspense>
        ) : (
          <React.Suspense fallback={<p className="p-3 text-xs text-muted-foreground">加载中…</p>}>
            <Renderer
              path={tab.path}
              mode={renderer.id === 'html' ? htmlMode : 'preview'}
              readOnly
              text={loaded.preview.content}
            />
          </React.Suspense>
        )}
      </div>
    </section>
  )
}

export function CloudWorkspacePreviewTab(props: CloudWorkspacePreviewTabProps): React.JSX.Element {
  const { tab, rpc, workspacePath, permissions } = props
  if (tab.kind !== 'preview') {
    return (
      <p
        data-testid="cloud-workspace-preview-unsupported"
        className="p-3 text-xs text-muted-foreground"
      >
        该标签不是预览标签。
      </p>
    )
  }
  return (
    <CloudWorkspacePreviewTabBody
      key={tab.path}
      tab={tab}
      rpc={rpc}
      workspacePath={workspacePath}
      permissions={permissions}
    />
  )
}

/** Adapts the shell's per-tab props to one preview tab bound to an RPC. */
export function createCloudWorkspacePreviewTab(
  api: CloudWorkspacePreviewTabApi
): React.ComponentType<CloudSimpleWorkspaceTabComponentProps> {
  function CloudWorkspacePreviewTabFromApi({
    tab,
    active,
    dispatch
  }: CloudSimpleWorkspaceTabComponentProps): React.JSX.Element {
    return <CloudWorkspacePreviewTab tab={tab} active={active} dispatch={dispatch} {...api} />
  }
  return CloudWorkspacePreviewTabFromApi
}
