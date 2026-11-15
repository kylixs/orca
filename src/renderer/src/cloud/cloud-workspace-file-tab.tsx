import * as React from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { CloudRpc } from '../../../shared/cloud-file-browser'
import type { CloudProjectPermission } from '../../../shared/cloud-platform-ipc'
import type { CloudSimpleWorkspaceTabComponentProps } from './cloud-simple-workspace'
import type { CloudSimpleWorkspaceTab } from './cloud-simple-workspace-tabs'
import type { CloudWorkspaceEditorProps } from './cloud-workspace-monaco-editor'
import {
  cloudWorkspaceFileFailureText,
  cloudWorkspaceFileLanguage,
  readCloudWorkspaceFile,
  writeCloudWorkspaceFile,
  type CloudWorkspaceFileFailure
} from './cloud-workspace-file-io'
import { CloudFileCopyButton, useCloudFileCopyCapture } from './cloud-file-copy-capture'
import { CloudWorkspaceFileConflictBanner } from './cloud-workspace-file-conflict'
import {
  CLOUD_BINARY_FILE_RENDERER,
  CLOUD_CODE_FILE_RENDERER,
  resolveCloudFileFormat,
  type CloudFileMode
} from './file-renderers/registry'
import {
  initialCloudFileMode,
  writeCloudFileModePreference
} from './file-renderers/viewer-mode-preference'

/**
 * Editor tab for the embedded workspace (U46-7a, design §4.7 + §11.4).
 *
 * Read/write go through the host's `files.read`/`files.write`; the buffer is
 * dirty until a save succeeds. A save re-reads first because the platform has
 * no etag: a mismatch opens the three-way conflict box instead of overwriting.
 * Monaco and the markdown pipeline stay in lazy chunks, as in orca web.
 */

type EditorTab = Extract<CloudSimpleWorkspaceTab, { kind: 'editor' }>

type Loaded =
  | { kind: 'loading' }
  | { kind: 'ready'; baseContent: string; readOnly: boolean; notice: string | null }
  /** Host refused the read as binary; show the 7b placeholder instead of an editor. */
  | { kind: 'binary'; detail: string }
  | { kind: 'failed'; code: string; message?: string }

type Conflict = { latestContent: string }

function fileExtension(relativePath: string): string {
  const name = relativePath.split(/[\\/]/).at(-1) ?? relativePath
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? name : name.slice(dot + 1)
}
const SourceRenderer = CLOUD_CODE_FILE_RENDERER.component
const BinaryRenderer = CLOUD_BINARY_FILE_RENDERER.component

export type CloudWorkspaceFileTabApi = {
  rpc: CloudRpc
  workspacePath: string
  permissions?: readonly CloudProjectPermission[] | null
  /** Test/embedding seam; defaults to the lazy Monaco surface. */
  editor?: React.ComponentType<CloudWorkspaceEditorProps>
}

export type CloudWorkspaceFileTabProps = CloudSimpleWorkspaceTabComponentProps &
  CloudWorkspaceFileTabApi

type CloudWorkspaceFileTabBodyProps = {
  tab: EditorTab
  dispatch: CloudSimpleWorkspaceTabComponentProps['dispatch']
  registerSave?: CloudSimpleWorkspaceTabComponentProps['registerSave']
  rpc: CloudRpc
  workspacePath: string
  permissions?: readonly CloudProjectPermission[] | null
  editor?: React.ComponentType<CloudWorkspaceEditorProps>
}

function CloudWorkspaceFileTabBody({
  tab,
  dispatch,
  registerSave,
  rpc,
  workspacePath,
  permissions,
  editor
}: CloudWorkspaceFileTabBodyProps): React.JSX.Element {
  const canRead = permissions?.includes('file:read') ?? true
  const canWrite = permissions?.includes('file:write') ?? true
  const renderer = React.useMemo(() => resolveCloudFileFormat(tab.path), [tab.path])
  const language = renderer.language ?? cloudWorkspaceFileLanguage(tab.path)

  const [loaded, setLoaded] = React.useState<Loaded>({ kind: 'loading' })
  const [content, setContent] = React.useState('')
  const [mode, setMode] = React.useState<CloudFileMode>(() => initialCloudFileMode(renderer))
  const [saving, setSaving] = React.useState(false)
  const [saveError, setSaveError] = React.useState<CloudWorkspaceFileFailure | null>(null)
  const [conflict, setConflict] = React.useState<Conflict | null>(null)
  const copyCapture = useCloudFileCopyCapture(rpc, tab.path, content)

  React.useEffect(() => {
    if (!canRead) {
      setLoaded({ kind: 'failed', code: 'permission', message: '缺少 file:read' })
      return
    }
    let cancelled = false
    setLoaded({ kind: 'loading' })
    setSaveError(null)
    setConflict(null)
    void readCloudWorkspaceFile(rpc, workspacePath, tab.path).then((outcome) => {
      if (cancelled) {
        return
      }
      if (!outcome.ok) {
        setLoaded(
          outcome.code === 'binary_file'
            ? { kind: 'binary', detail: fileExtension(tab.path) }
            : { kind: 'failed', code: outcome.code, message: outcome.message }
        )
        return
      }
      if (outcome.binary) {
        // Unknown extension but binary content: placeholder, never read-only Monaco.
        setLoaded({ kind: 'binary', detail: fileExtension(tab.path) })
        setContent(outcome.content)
        return
      }
      const truncated = outcome.truncated
      setLoaded({
        kind: 'ready',
        baseContent: outcome.content,
        readOnly: !canWrite || truncated,
        notice: truncated ? '文件过大（已截断），简易工作区不支持编辑。' : null
      })
      setContent(outcome.content)
      if (truncated) {
        setMode('source')
      }
    })
    return () => {
      cancelled = true
    }
  }, [canRead, canWrite, rpc, workspacePath, tab.path])

  const dirty = loaded.kind === 'ready' && content !== loaded.baseContent

  // The shell reducer is the dirty protocol: its status bar and the U46-4
  // parent frame both read this one state, never a local copy.
  React.useEffect(() => {
    dispatch({ type: 'setDirty', id: tab.id, dirty })
  }, [dirty, dispatch, tab.id])

  // true = the buffer is durably on the host (a dirty close may unmount us).
  const save = React.useCallback(
    async (overwrite: boolean): Promise<boolean> => {
      if (loaded.kind !== 'ready' || loaded.readOnly || saving) {
        return false
      }
      const pending = content
      setSaving(true)
      setSaveError(null)
      try {
        if (!overwrite) {
          const latest = await readCloudWorkspaceFile(rpc, workspacePath, tab.path)
          if (!latest.ok) {
            setSaveError(latest)
            return false
          }
          if (latest.content !== loaded.baseContent) {
            setConflict({ latestContent: latest.content })
            return false
          }
        }
        const written = await writeCloudWorkspaceFile(rpc, workspacePath, tab.path, pending)
        if (!written.ok) {
          setSaveError(written)
          return false
        }
        setConflict(null)
        setLoaded((current) =>
          current.kind === 'ready' ? { ...current, baseContent: pending } : current
        )
        return true
      } finally {
        setSaving(false)
      }
    },
    [content, loaded, rpc, saving, tab.path, workspacePath]
  )

  React.useEffect(() => {
    if (!registerSave) {
      return
    }
    registerSave(tab.id, () => save(false))
    return () => registerSave(tab.id, null)
  }, [registerSave, save, tab.id])

  function reloadConflict(): void {
    if (conflict === null) {
      return
    }
    setContent(conflict.latestContent)
    setLoaded((current) =>
      current.kind === 'ready' ? { ...current, baseContent: conflict.latestContent } : current
    )
    setConflict(null)
  }

  if (!canRead) {
    return (
      <p
        data-testid="cloud-workspace-file-tab-denied"
        className="p-3 text-xs leading-relaxed text-muted-foreground"
      >
        当前项目未授予文件读取权限，文件编辑不可用。
      </p>
    )
  }

  const selectMode = (next: CloudFileMode): void => {
    setMode(next)
    if (renderer.canPreview && renderer.canEditSource) {
      writeCloudFileModePreference(renderer.id, next)
    }
  }
  const EditorComponent = editor
  const PreviewRenderer = renderer.component
  const canSwitchMode = renderer.canPreview && renderer.canEditSource

  return (
    <section
      data-testid="cloud-workspace-file-tab"
      className="flex h-full min-h-0 flex-col bg-background"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1">
        <span
          data-testid="cloud-workspace-file-tab-path"
          className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground"
          title={tab.path}
        >
          {tab.path}
        </span>
        {canSwitchMode && loaded.kind === 'ready' ? (
          <div role="group" aria-label="显示模式" className="flex items-center gap-1">
            <Button
              variant={mode === 'source' ? 'secondary' : 'ghost'}
              size="sm"
              data-testid="cloud-workspace-file-tab-mode-edit"
              aria-pressed={mode === 'source'}
              onClick={() => selectMode('source')}
            >
              编辑
            </Button>
            <Button
              variant={mode === 'preview' ? 'secondary' : 'ghost'}
              size="sm"
              data-testid="cloud-workspace-file-tab-mode-preview"
              aria-pressed={mode === 'preview'}
              onClick={() => selectMode('preview')}
            >
              预览
            </Button>
          </div>
        ) : null}
        {loaded.kind === 'ready' && loaded.readOnly ? (
          <Badge variant="outline" data-testid="cloud-workspace-file-tab-readonly">
            只读
          </Badge>
        ) : null}
        {loaded.kind === 'ready' ? (
          <CloudFileCopyButton
            capture={copyCapture}
            disabled={content.length === 0}
            testId="cloud-workspace-file-copy"
          />
        ) : null}
        {loaded.kind === 'ready' && !loaded.readOnly ? (
          <Button
            size="sm"
            data-testid="cloud-workspace-file-tab-save"
            disabled={!dirty || saving}
            onClick={() => void save(false)}
          >
            {saving ? '保存中…' : '保存'}
          </Button>
        ) : null}
      </header>

      {loaded.kind === 'ready' && loaded.notice ? (
        <p
          data-testid="cloud-workspace-file-tab-notice"
          className="border-b border-border bg-muted px-3 py-1 text-xs text-muted-foreground"
        >
          {loaded.notice}
        </p>
      ) : null}

      {saveError ? (
        <p
          role="alert"
          data-testid="cloud-workspace-file-tab-save-error"
          className="border-b border-border px-3 py-1 text-xs text-destructive"
        >
          {cloudWorkspaceFileFailureText(saveError)}
        </p>
      ) : null}

      {conflict ? (
        <CloudWorkspaceFileConflictBanner
          onReload={reloadConflict}
          onOverwrite={() => void save(true)}
          onCancel={() => setConflict(null)}
        />
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col" onCopy={copyCapture.captureCopy}>
        {loaded.kind === 'loading' ? (
          <p className="p-3 text-xs text-muted-foreground">正在读取文件…</p>
        ) : loaded.kind === 'binary' ? (
          <React.Suspense
            fallback={<p className="p-3 text-xs text-muted-foreground">正在加载预览…</p>}
          >
            <BinaryRenderer
              path={tab.path}
              mode="preview"
              readOnly
              binary={{ base64: '', mimeType: loaded.detail }}
              testId="cloud-workspace-file-tab-binary"
            />
          </React.Suspense>
        ) : loaded.kind === 'failed' ? (
          <p data-testid="cloud-workspace-file-tab-error" className="p-3 text-xs text-destructive">
            {cloudWorkspaceFileFailureText(loaded)}
          </p>
        ) : mode === 'preview' && renderer.canPreview ? (
          <React.Suspense
            fallback={<p className="p-3 text-xs text-muted-foreground">正在渲染预览…</p>}
          >
            <PreviewRenderer
              path={tab.path}
              mode="preview"
              readOnly={loaded.readOnly}
              text={content}
            />
          </React.Suspense>
        ) : (
          <React.Suspense
            fallback={<p className="p-3 text-xs text-muted-foreground">正在加载编辑器…</p>}
          >
            {EditorComponent ? (
              <EditorComponent
                filePath={tab.path}
                value={content}
                language={language}
                readOnly={loaded.readOnly}
                onChange={setContent}
                onSave={() => void save(false)}
              />
            ) : (
              <SourceRenderer
                path={tab.path}
                mode="source"
                readOnly={loaded.readOnly}
                text={content}
                language={language}
                onChange={setContent}
                onSave={() => void save(false)}
              />
            )}
          </React.Suspense>
        )}
      </div>
    </section>
  )
}

export function CloudWorkspaceFileTab(props: CloudWorkspaceFileTabProps): React.JSX.Element {
  const { tab, dispatch, registerSave, rpc, workspacePath, permissions, editor } = props
  if (tab.kind !== 'editor') {
    return (
      <p
        data-testid="cloud-workspace-file-tab-unsupported"
        className="p-3 text-xs text-muted-foreground"
      >
        该标签不是文件编辑标签。
      </p>
    )
  }
  return (
    <CloudWorkspaceFileTabBody
      key={tab.path}
      tab={tab}
      dispatch={dispatch}
      registerSave={registerSave}
      rpc={rpc}
      workspacePath={workspacePath}
      permissions={permissions}
      editor={editor}
    />
  )
}

/** Adapts the tab playground's per-tab props to one file tab bound to an RPC. */
export function createCloudWorkspaceFileTab(
  api: CloudWorkspaceFileTabApi
): React.ComponentType<CloudSimpleWorkspaceTabComponentProps> {
  function CloudWorkspaceFileTabFromApi({
    tab,
    active,
    dispatch,
    registerSave
  }: CloudSimpleWorkspaceTabComponentProps): React.JSX.Element {
    return (
      <CloudWorkspaceFileTab
        tab={tab}
        active={active}
        dispatch={dispatch}
        registerSave={registerSave}
        {...api}
      />
    )
  }
  return CloudWorkspaceFileTabFromApi
}
