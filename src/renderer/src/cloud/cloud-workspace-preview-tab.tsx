import * as React from 'react'
import { buildImageDataUri } from '../../../shared/image-data-uri'
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

/**
 * Preview tab for the embedded workspace (U46-7b, design §4.8 + §11.4).
 *
 * Everything previewable comes from one `files.readPreview` call: the host
 * returns base64 for known image MIME types and text otherwise. Images render
 * from a data URL; HTML renders in an empty-sandbox iframe (no scripts, no
 * same-origin); drawio degrades to its source because the embedded viewer would
 * need a third-party script this surface refuses to load; other binaries are a
 * download prompt. PDF is classified before the read so an unrenderable file
 * never spends the project's read budget.
 */

type PreviewTab = Extract<CloudSimpleWorkspaceTab, { kind: 'preview' }>

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml'
}
const IMAGE_EXTENSIONS = new Set(Object.keys(IMAGE_MIME_BY_EXTENSION))

export type CloudWorkspacePreviewKind = 'image' | 'html' | 'drawio' | 'pdf' | 'binary'

/**
 * Extensions the text editor must never open (U59②). Previewable types
 * (images/HTML/drawio/PDF) are classified first, so this set only diverts files
 * the host's `files.read` would otherwise return as raw bytes.
 */
const CLOUD_WORKSPACE_BINARY_EXTENSIONS = new Set([
  'bin',
  'exe',
  'dll',
  'so',
  'dylib',
  'zip',
  'tar',
  'gz',
  'tgz',
  'bz2',
  'xz',
  '7z',
  'rar',
  'class',
  'jar',
  'wasm',
  'pyc',
  'pyo',
  'o',
  'a',
  'lib',
  'node',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'mp3',
  'mp4',
  'mov',
  'avi',
  'mkv',
  'wav',
  'flac',
  'ogg',
  'webm',
  'sqlite',
  'db',
  'iso',
  'dmg',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'odt',
  'ods',
  'odp'
])

/** True for a known binary extension; unknown files fall back to the read heuristic. */
export function isCloudWorkspaceBinaryPath(relativePath: string): boolean {
  return CLOUD_WORKSPACE_BINARY_EXTENSIONS.has(extensionOf(relativePath))
}

function fileName(relativePath: string): string {
  return relativePath.split(/[\\/]/).at(-1) ?? relativePath
}

function extensionOf(relativePath: string): string {
  const name = fileName(relativePath).toLowerCase()
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1)
}

/** `.drawio.svg` is a plain SVG for rendering; bare `.drawio` is XML source. */
export function cloudWorkspacePreviewKind(relativePath: string): CloudWorkspacePreviewKind {
  const name = fileName(relativePath).toLowerCase()
  if (name.endsWith('.html') || name.endsWith('.htm')) {
    return 'html'
  }
  if (name.endsWith('.drawio')) {
    return 'drawio'
  }
  const extension = extensionOf(relativePath)
  if (IMAGE_EXTENSIONS.has(extension)) {
    return 'image'
  }
  if (extension === 'pdf') {
    return 'pdf'
  }
  return 'binary'
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

function Placeholder({
  testId,
  message,
  detail,
  hint
}: {
  testId: string
  message: string
  detail?: string
  hint?: string
}): React.JSX.Element {
  return (
    <div
      data-testid={testId}
      className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center text-xs text-muted-foreground"
    >
      <p className="text-foreground">{message}</p>
      {detail === undefined ? null : <p className="break-all font-mono">{detail}</p>}
      {hint === undefined ? null : <p>{hint}</p>}
    </div>
  )
}

function failureText(code: string, message?: string): string {
  return message === undefined ? code : `${code}：${message}`
}

function ImagePreview({ src, path }: { src: string | null; path: string }): React.JSX.Element {
  const [broken, setBroken] = React.useState(false)
  if (src === null || broken) {
    return (
      <Placeholder
        testId="cloud-workspace-preview-image-failed"
        message="无法预览该图片。"
        hint="文件可能已损坏或尺寸超出预览限制。"
      />
    )
  }
  return (
    <div className="flex h-full min-h-0 items-center justify-center overflow-auto scrollbar-sleek p-3">
      <img
        data-testid="cloud-workspace-preview-image"
        src={src}
        alt={fileName(path)}
        className="max-h-full max-w-full object-contain"
        onError={() => setBroken(true)}
      />
    </div>
  )
}

function HtmlPreview({
  content,
  path,
  mode
}: {
  content: string
  path: string
  mode: 'preview' | 'source'
}): React.JSX.Element {
  if (mode === 'source') {
    return (
      <pre
        data-testid="cloud-workspace-preview-html-source"
        className="min-h-0 flex-1 overflow-auto scrollbar-editor p-3 font-mono text-xs text-foreground"
      >
        {content}
      </pre>
    )
  }
  // Empty sandbox: no allow-scripts and no allow-same-origin (design §4.8).
  return (
    <iframe
      data-testid="cloud-workspace-preview-html-frame"
      title={`预览 ${fileName(path)}`}
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={content}
      className="h-full w-full border-0"
    />
  )
}

function DrawioPreview({ content }: { content: string }): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <p
        data-testid="cloud-workspace-preview-drawio-degraded"
        className="shrink-0 border-b border-border px-3 py-2 text-[11px] leading-relaxed text-muted-foreground"
      >
        drawio 嵌入查看器需要加载第三方脚本，简易工作区不加载；以下为文件源码，可下载后用 drawio
        打开。
      </p>
      <pre
        data-testid="cloud-workspace-preview-drawio-source"
        className="min-h-0 flex-1 overflow-auto scrollbar-editor p-3 font-mono text-xs text-foreground"
      >
        {content}
      </pre>
    </div>
  )
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
  const kind = cloudWorkspacePreviewKind(tab.path)
  const [loaded, setLoaded] = React.useState<Loaded>({ status: 'loading' })
  const [retryToken, setRetryToken] = React.useState(0)
  const [htmlMode, setHtmlMode] = React.useState<'preview' | 'source'>('preview')

  React.useEffect(() => {
    if (!canRead || kind === 'pdf') {
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
  }, [canRead, kind, retryToken, rpc, tab.path, workspacePath])

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
    kind === 'image'
      ? '图片'
      : kind === 'html'
        ? 'HTML'
        : kind === 'drawio'
          ? 'drawio 源码'
          : kind === 'pdf'
            ? 'PDF'
            : '二进制'

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
        {kind === 'html' ? (
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
        {kind === 'pdf' ? (
          <Placeholder
            testId="cloud-workspace-preview-pdf"
            message="PDF 预览不在简易版范围。"
            detail="application/pdf"
            hint="请下载后打开。"
          />
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
        ) : kind === 'html' ? (
          <HtmlPreview content={loaded.preview.content} path={tab.path} mode={htmlMode} />
        ) : kind === 'drawio' ? (
          <DrawioPreview content={loaded.preview.content} />
        ) : kind === 'image' ||
          (loaded.preview.isImage && loaded.preview.mimeType?.startsWith('image/')) ? (
          <ImagePreview
            src={buildImageDataUri(
              loaded.preview.mimeType ?? IMAGE_MIME_BY_EXTENSION[extensionOf(tab.path)],
              loaded.preview.content
            )}
            path={tab.path}
          />
        ) : (
          <Placeholder
            testId="cloud-workspace-preview-binary"
            message="该文件为二进制格式，简易工作区不支持预览。"
            detail={loaded.preview.mimeType ?? extensionOf(tab.path)}
            hint="请下载后打开。"
          />
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
