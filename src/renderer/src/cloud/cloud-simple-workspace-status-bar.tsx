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

// Segment form follows the native status bar's cloud segment
// (cloud-login-entry.tsx CloudLoginStatusSegment): inline, 11px, muted.
const SEGMENT_CLASS = 'inline-flex shrink-0 items-center gap-1 rounded px-1 py-0.5'

const CONNECTION_DOT_CLASS: Record<CloudSimpleWorkspaceConnection, string> = {
  connecting: 'bg-muted-foreground',
  connected: 'bg-primary',
  failed: 'bg-destructive'
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
      className="scrollbar-sleek flex shrink-0 items-center gap-1 overflow-x-auto border-t border-border bg-card px-2 py-1 text-[11px] text-muted-foreground"
    >
      <span data-testid="cloud-simple-workspace-status-connection" className={SEGMENT_CLASS}>
        <span aria-hidden className={`size-1.5 rounded-full ${CONNECTION_DOT_CLASS[connection]}`} />
        {CONNECTION_LABEL[connection]}
      </span>
      <span className={SEGMENT_CLASS}>E2EE</span>
      <span data-testid="cloud-simple-workspace-status-route" className={SEGMENT_CLASS}>
        {routeLabel(route)}
        {typeof latencyMs === 'number' ? ` ${latencyMs}ms` : ''}
      </span>
      <span
        className={`${SEGMENT_CLASS} min-w-0 truncate`}
        data-testid="cloud-simple-workspace-status-branch"
      >
        {branch ?? '未上报分支'}
      </span>
      <span
        className={`${SEGMENT_CLASS} min-w-0 truncate font-mono`}
        data-testid="cloud-simple-workspace-status-path"
      >
        {workspacePath ?? '工作区尚未创建'}
      </span>
      {dirtyCount > 0 ? (
        <span
          className={`${SEGMENT_CLASS} text-foreground`}
          data-testid="cloud-simple-workspace-status-dirty"
        >
          ● 未保存 {dirtyCount}
        </span>
      ) : null}
    </footer>
  )
}
