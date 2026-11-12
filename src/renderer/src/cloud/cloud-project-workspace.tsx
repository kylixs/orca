import * as React from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { readString } from '../../../shared/json-fields'
import type { CloudProjectSummary, CloudRpcOutcome } from '../../../shared/cloud-platform-ipc'
import type { CloudSessionView } from './use-cloud-session'
import { cloudCloseNotice } from './cloud-close-notice'

export type CloudProjectWorkspaceProps = {
  session: CloudSessionView
  project: CloudProjectSummary
  /** One-shot RPC over the open cloud link; injected so the view stays testable. */
  rpc: (method: string) => Promise<CloudRpcOutcome>
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
  rpc
}: CloudProjectWorkspaceProps): React.JSX.Element {
  const [live, setLive] = React.useState<LiveState>({ kind: 'checking' })
  const opened = session.opened

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

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="flex items-center justify-between border-b border-border px-6 py-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-base font-medium text-foreground">{project.name}</h1>
            <Badge variant="secondary" data-testid="cloud-route">
              {opened?.route === 'relay' ? '中继' : '直连'}
            </Badge>
            {project.downloadRestricted ? (
              <span className="text-xs text-muted-foreground">下载受限</span>
            ) : null}
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {project.key}
            {project.hostName ? ` · ${project.hostName}` : ''}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void session.closeProject()}>
          返回工作台
        </Button>
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

        <p className="max-w-prose text-xs leading-relaxed text-muted-foreground">
          终端与文件面板将在此工作区内按项目管理；当前版本先展示连接与主机信息，面板接入见后续模块。
        </p>
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
