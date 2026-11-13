import * as React from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  CLOUD_FILE_ROOT,
  browseCloudDirectory,
  cloudChildPath,
  cloudParentPath,
  cloudPathSegments,
  previewCloudFile,
  type CloudFileEntry,
  type CloudFilePreview,
  type CloudRpc
} from '../../../shared/cloud-file-browser'

/**
 * The file pane for a cloud workspace: the directories and files under the
 * user's checkout on the development host (design §8.3, T206).
 *
 * Every action goes through `files.readDir` / `files.readPreview` over the cloud
 * link, so the host decides what is reachable; this component never resolves a
 * path itself beyond joining a name the host just listed.
 */

export type CloudFilePanelProps = {
  rpc: CloudRpc
  /** The user's checkout, as returned by `cloud:openWorkspace`. */
  workspacePath: string
}

type Listing =
  | { kind: 'loading' }
  | { kind: 'ready'; entries: CloudFileEntry[] }
  | { kind: 'failed'; code: string; message?: string }

type Preview =
  | { kind: 'idle' }
  | { kind: 'loading'; path: string }
  | { kind: 'ready'; path: string; preview: CloudFilePreview }
  | { kind: 'failed'; path: string; code: string; message?: string }

function failureText(code: string, message?: string): string {
  if (code === 'forbidden') {
    return message ?? '无权访问该路径'
  }
  return message ? `${code}：${message}` : code
}

function Breadcrumb({
  relativePath,
  onNavigate
}: {
  relativePath: string
  onNavigate: (path: string) => void
}): React.JSX.Element {
  const segments = cloudPathSegments(relativePath)
  return (
    <nav className="flex flex-wrap items-center gap-1 text-xs" aria-label="路径">
      <button
        type="button"
        className="rounded px-1 py-0.5 font-mono text-foreground hover:bg-muted"
        onClick={() => onNavigate(CLOUD_FILE_ROOT)}
      >
        工作区
      </button>
      {segments.map((segment, index) => {
        const target = segments.slice(0, index + 1).join('/')
        return (
          <React.Fragment key={target}>
            <span className="text-muted-foreground">/</span>
            <button
              type="button"
              className="rounded px-1 py-0.5 font-mono text-foreground hover:bg-muted"
              onClick={() => onNavigate(target)}
            >
              {segment}
            </button>
          </React.Fragment>
        )
      })}
    </nav>
  )
}

function EntryRow({
  entry,
  onOpen
}: {
  entry: CloudFileEntry
  onOpen: (entry: CloudFileEntry) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={`cloud-file-entry-${entry.name}`}
      className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted"
      onClick={() => onOpen(entry)}
    >
      <span className="font-mono text-xs text-muted-foreground">
        {entry.kind === 'directory' ? '目录' : '文件'}
      </span>
      <span className="min-w-0 flex-1 truncate text-foreground">{entry.name}</span>
      {entry.isSymlink ? <Badge variant="outline">链接</Badge> : null}
    </button>
  )
}

function PreviewBody({ preview }: { preview: CloudFilePreview }): React.JSX.Element {
  if (preview.isImage) {
    // Why not "use download": managed projects have no download by policy (AC-10),
    // so pointing there would advertise an entry that does not exist.
    return (
      <p className="text-xs text-muted-foreground">
        图片文件{preview.mimeType ? `（${preview.mimeType}）` : ''}，托管项目不提供图片预览与下载。
      </p>
    )
  }
  if (preview.isBinary) {
    return (
      <p className="text-xs text-muted-foreground">
        二进制文件{preview.mimeType ? `（${preview.mimeType}）` : ''}，无法以文本显示。
      </p>
    )
  }
  return (
    <pre
      data-testid="cloud-file-content"
      className="scrollbar-sleek max-h-96 overflow-auto rounded border border-border bg-muted/40 p-3 font-mono text-xs text-foreground"
    >
      {preview.content}
    </pre>
  )
}

export function CloudFilePanel({ rpc, workspacePath }: CloudFilePanelProps): React.JSX.Element {
  const [directory, setDirectory] = React.useState(CLOUD_FILE_ROOT)
  const [listing, setListing] = React.useState<Listing>({ kind: 'loading' })
  const [preview, setPreview] = React.useState<Preview>({ kind: 'idle' })
  // Why a counter: a slow reply from a directory the user already left must not
  // overwrite the listing they are now looking at.
  const requestSeq = React.useRef(0)

  React.useEffect(() => {
    const seq = ++requestSeq.current
    setListing({ kind: 'loading' })
    void browseCloudDirectory(rpc, workspacePath, directory).then((outcome) => {
      if (seq !== requestSeq.current) {
        return
      }
      setListing(
        outcome.ok
          ? { kind: 'ready', entries: outcome.entries }
          : { kind: 'failed', code: outcome.code, message: outcome.message }
      )
    })
  }, [rpc, workspacePath, directory])

  const openEntry = React.useCallback(
    (entry: CloudFileEntry) => {
      if (entry.kind === 'directory') {
        const next = cloudChildPath(directory, entry.name)
        if (next !== null) {
          setDirectory(next)
          setPreview({ kind: 'idle' })
        }
        return
      }
      const target = cloudChildPath(directory, entry.name)
      if (target === null) {
        return
      }
      setPreview({ kind: 'loading', path: target })
      void previewCloudFile(rpc, workspacePath, target).then((outcome) => {
        setPreview(
          outcome.ok
            ? { kind: 'ready', path: target, preview: outcome.preview }
            : { kind: 'failed', path: target, code: outcome.code, message: outcome.message }
        )
      })
    },
    [directory, rpc, workspacePath]
  )

  return (
    <section
      data-testid="cloud-file-panel"
      className="flex min-h-0 flex-1 flex-col gap-3 rounded border border-border bg-card p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-foreground">文件</h2>
        <Button
          variant="ghost"
          size="sm"
          disabled={directory === CLOUD_FILE_ROOT}
          onClick={() => {
            setDirectory(cloudParentPath(directory))
            setPreview({ kind: 'idle' })
          }}
        >
          上一级
        </Button>
      </div>
      <Breadcrumb
        relativePath={directory}
        onNavigate={(path) => {
          setDirectory(path)
          setPreview({ kind: 'idle' })
        }}
      />

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek" role="list">
        {listing.kind === 'loading' ? (
          <p className="px-2 py-1 text-xs text-muted-foreground">正在读取…</p>
        ) : listing.kind === 'failed' ? (
          <p data-testid="cloud-file-error" className="px-2 py-1 text-xs text-destructive">
            {failureText(listing.code, listing.message)}
          </p>
        ) : listing.entries.length === 0 ? (
          <p className="px-2 py-1 text-xs text-muted-foreground">空目录</p>
        ) : (
          listing.entries.map((entry) => (
            <div role="listitem" key={entry.name}>
              <EntryRow entry={entry} onOpen={openEntry} />
            </div>
          ))
        )}
      </div>

      <div data-testid="cloud-file-preview" className="flex flex-col gap-2">
        {preview.kind === 'idle' ? (
          <p className="text-xs text-muted-foreground">选择文件查看内容</p>
        ) : preview.kind === 'loading' ? (
          <p className="text-xs text-muted-foreground">正在打开 {preview.path}…</p>
        ) : preview.kind === 'failed' ? (
          <p data-testid="cloud-file-preview-error" className="text-xs text-destructive">
            {failureText(preview.code, preview.message)}
          </p>
        ) : (
          <>
            <p className="truncate font-mono text-xs text-muted-foreground">{preview.path}</p>
            <PreviewBody preview={preview.preview} />
          </>
        )}
      </div>
    </section>
  )
}
