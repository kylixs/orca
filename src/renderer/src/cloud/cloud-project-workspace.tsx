import * as React from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { readString } from '../../../shared/json-fields'
import type { CloudProjectSummary, CloudRpcOutcome } from '../../../shared/cloud-platform-ipc'
import type { CloudRpc } from '../../../shared/cloud-file-browser'
import type { CloudSessionView } from './use-cloud-session'
import { cloudCloseNotice } from './cloud-close-notice'
import { translate } from '@/i18n/i18n'
import { CloudConnectionDiagnosticsDialog, chosenProbe } from './cloud-connection-diagnostics'
import { CloudFilePanel } from './cloud-file-panel'
import type { CloudTerminalSubscribe } from './cloud-terminal-panel'

// Why lazy: the xterm chunk must stay out of the admin entry's first paint, and
// the pane only mounts once the panel actually streams (M118/W5a).
const CloudTerminalPanel = React.lazy(() =>
  import('./cloud-terminal-panel').then((module) => ({ default: module.CloudTerminalPanel }))
)

export type CloudProjectWorkspaceProps = {
  session: CloudSessionView
  project: CloudProjectSummary
  /** RPC over the open cloud link; injected so the view stays testable. */
  rpc: CloudRpc
  /**
   * Terminal stream seam; null (or absent) hides the terminal pane, which is
   * the desktop preload's state today.
   */
  subscribe?: CloudTerminalSubscribe | null
}

type LiveState =
  | { kind: 'checking' }
  | { kind: 'connected'; runtimeId: string | null }
  | { kind: 'failed'; code: string }

/** What the host says about itself, read without trusting the response shape. */
function runtimeIdOf(outcome: CloudRpcOutcome): string | null {
  return outcome.ok ? readString(outcome.result, 'runtimeId') : null
}

export function CloudProjectWorkspace({
  session,
  project,
  rpc,
  subscribe = null
}: CloudProjectWorkspaceProps): React.JSX.Element {
  const [live, setLive] = React.useState<LiveState>({ kind: 'checking' })
  const [diagnosticsOpen, setDiagnosticsOpen] = React.useState(false)
  const opened = session.opened
  const diagnostics = opened?.connectDiagnostics
  const chosen = chosenProbe(diagnostics)

  const check = React.useCallback(async () => {
    setLive({ kind: 'checking' })
    const outcome = await rpc('status.get')
    setLive(
      outcome.ok
        ? { kind: 'connected', runtimeId: runtimeIdOf(outcome) }
        : { kind: 'failed', code: outcome.code }
    )
  }, [rpc])

  React.useEffect(() => {
    void check()
  }, [check])

  const capabilities = opened?.capabilities ?? []
  // Absent means the reply predates the field; the host still enforces, so show
  // the panel and let a refusal surface rather than hiding a usable pane.
  const canReadFiles = opened?.permissions?.includes('file:read') ?? true
  const canUseTerminal = opened?.permissions?.includes('terminal') ?? true

  return (
    <div className="flex h-full flex-col bg-background">
      {diagnostics && opened ? (
        diagnosticsOpen ? (
          <CloudConnectionDiagnosticsDialog
            route={opened.route}
            diagnostics={diagnostics}
            onClose={() => setDiagnosticsOpen(false)}
          />
        ) : null
      ) : null}
      <header className="flex items-center justify-between border-b border-border px-6 py-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-base font-medium text-foreground">{project.name}</h1>
            <Badge variant="secondary" data-testid="cloud-route">
              {opened?.route === 'relay' ? '中继' : '直连'}
            </Badge>
            {chosen ? (
              <span className="text-xs text-muted-foreground" data-testid="cloud-route-latency">
                {chosen.elapsedMs}ms
              </span>
            ) : null}
            {project.downloadRestricted ? (
              <span className="text-xs text-muted-foreground">下载受限</span>
            ) : null}
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {project.key}
            {project.hostName ? ` · ${project.hostName}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {diagnostics ? (
            <Button
              variant="ghost"
              size="sm"
              data-testid="cloud-open-diagnostics"
              onClick={() => setDiagnosticsOpen(true)}
            >
              {translate('auto.cloud.connectionDiagnostics', '连接诊断')}
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" onClick={() => void session.closeProject(project.id)}>
            返回工作台
          </Button>
        </div>
      </header>

      {session.notice ? (
        <div
          role="status"
          className="border-b border-border bg-muted px-6 py-2 text-sm text-muted-foreground"
        >
          {cloudCloseNotice(session.notice.code)}
        </div>
      ) : null}

      <div className="scrollbar-sleek flex flex-1 flex-col gap-6 overflow-y-auto px-6 py-5">
        <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">工作区根目录</dt>
          <dd className="break-all font-mono text-xs text-foreground">
            {opened?.workspaceRoot ?? '—'}
          </dd>
          <dt className="text-muted-foreground">我的工作区</dt>
          <dd
            className="break-all font-mono text-xs text-foreground"
            data-testid="cloud-workspace-path"
          >
            {opened?.workspacePath ?? '首次打开时创建'}
          </dd>
          <dt className="text-muted-foreground">开发机能力</dt>
          <dd className="flex flex-wrap gap-1.5" data-testid="cloud-capabilities">
            {capabilities.length === 0 ? (
              <span className="text-xs text-muted-foreground">未上报</span>
            ) : (
              capabilities.map((capability) => (
                <Badge key={capability} variant="outline">
                  {capability}
                </Badge>
              ))
            )}
          </dd>
          <dt className="text-muted-foreground">运行环境</dt>
          <dd className="font-mono text-xs text-foreground" data-testid="cloud-environment">
            {opened?.environmentId ?? '未登记'}
          </dd>
          <dt className="text-muted-foreground">运行时</dt>
          <dd data-testid="cloud-live">
            {live.kind === 'checking' ? (
              <span className="text-xs text-muted-foreground">正在检查…</span>
            ) : live.kind === 'connected' ? (
              <span className="text-xs text-foreground">
                已连接{live.runtimeId ? ` · ${live.runtimeId}` : ''}
              </span>
            ) : (
              <span className="text-xs text-destructive">检查失败（{live.code}）</span>
            )}
          </dd>
        </dl>

        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void check()}
            disabled={live.kind === 'checking'}
          >
            刷新状态
          </Button>
        </div>

        {subscribe === null ? (
          <>
            {opened?.workspacePath && canReadFiles ? (
              <CloudFilePanel rpc={rpc} workspacePath={opened.workspacePath} />
            ) : (
              <p className="max-w-prose text-xs leading-relaxed text-muted-foreground">
                {opened?.workspacePath
                  ? '当前项目未授予文件读取权限，文件面板不可用。'
                  : '工作区尚未创建，无法打开文件面板。'}
              </p>
            )}
          </>
        ) : (
          <div className="flex min-h-[26rem] flex-1 gap-4">
            {opened?.workspacePath && canUseTerminal ? (
              <React.Suspense
                fallback={
                  <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center rounded border border-border bg-card">
                    <span className="text-xs text-muted-foreground">正在加载终端…</span>
                  </div>
                }
              >
                <CloudTerminalPanel
                  rpc={rpc}
                  subscribe={subscribe}
                  workspacePath={opened.workspacePath}
                />
              </React.Suspense>
            ) : (
              <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 rounded border border-border bg-card p-3">
                <h2 className="text-sm font-medium text-foreground">终端</h2>
                <p
                  className="text-xs leading-relaxed text-muted-foreground"
                  data-testid="cloud-terminal-placeholder"
                >
                  {opened?.workspacePath
                    ? '当前项目未授予终端权限，终端面板不可用。'
                    : '工作区尚未创建，无法打开终端。'}
                </p>
              </section>
            )}
            <div className="flex w-72 shrink-0 flex-col lg:w-80">
              {opened?.workspacePath && canReadFiles ? (
                <CloudFilePanel rpc={rpc} workspacePath={opened.workspacePath} />
              ) : (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {opened?.workspacePath
                    ? '当前项目未授予文件读取权限，文件面板不可用。'
                    : '工作区尚未创建，无法打开文件面板。'}
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** The project row the workbench opened, matched by id. */
export function openedProjectSummary(session: CloudSessionView): CloudProjectSummary | null {
  const opened = session.opened
  if (!opened) {
    return null
  }
  return session.projects.find((entry) => entry.id === opened.projectId) ?? null
}
