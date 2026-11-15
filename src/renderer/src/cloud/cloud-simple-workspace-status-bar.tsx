import * as React from 'react'
import { routeLabel } from './cloud-connection-diagnostics'

/**
 * Bottom status bar (design §4.3): connection state, the signed checkout, and
 * the chosen line. The dirty dot mirrors the tab reducer, not a local copy.
 */

export type CloudSimpleWorkspaceConnection = 'connecting' | 'connected' | 'failed'

const CONNECTION_LABEL: Record<CloudSimpleWorkspaceConnection, string> = {
  connecting: '正在连接',
  connected: '已连接',
  failed: '连接失败'
}

export type CloudSimpleWorkspaceStatusBarProps = {
  connection: CloudSimpleWorkspaceConnection
  route: 'direct' | 'relay'
  latencyMs?: number | null
  branch?: string | null
  workspacePath?: string | null
  dirtyCount: number
}

export function CloudSimpleWorkspaceStatusBar({
  connection,
  route,
  latencyMs,
  branch,
  workspacePath,
  dirtyCount
}: CloudSimpleWorkspaceStatusBarProps): React.JSX.Element {
  return (
    <footer
      data-testid="cloud-simple-workspace-status-bar"
      className="flex shrink-0 items-center gap-3 overflow-x-auto border-t border-border bg-card px-3 py-1 text-xs text-muted-foreground scrollbar-sleek"
    >
      <span data-testid="cloud-simple-workspace-status-connection">
        {CONNECTION_LABEL[connection]}
      </span>
      <span>E2EE</span>
      <span data-testid="cloud-simple-workspace-status-route">
        {routeLabel(route)}
        {typeof latencyMs === 'number' ? ` ${latencyMs}ms` : ''}
      </span>
      <span className="min-w-0 truncate" data-testid="cloud-simple-workspace-status-branch">
        {branch ?? '未上报分支'}
      </span>
      <span className="min-w-0 truncate font-mono" data-testid="cloud-simple-workspace-status-path">
        {workspacePath ?? '工作区尚未创建'}
      </span>
      {dirtyCount > 0 ? (
        <span
          className="shrink-0 text-foreground"
          data-testid="cloud-simple-workspace-status-dirty"
        >
          ● 未保存 {dirtyCount}
        </span>
      ) : null}
    </footer>
  )
}
