import * as React from 'react'
import type { CloudRpc } from '../../../shared/cloud-file-browser'
import type { CloudSimpleWorkspaceTabComponentProps } from './cloud-simple-workspace'
import type { CloudTerminalPanelProps, CloudTerminalSubscribe } from './cloud-terminal-panel'
import {
  cloudTerminalDetachPolicy,
  useCloudSimpleWorkspaceLifecycle
} from './cloud-simple-workspace-lifecycle'

/**
 * Terminal tab of the embedded simple workspace (U46-5b, design §4.5).
 *
 * One tab = one `CloudTerminalPanel`, so the W5a/W5c PTY create/subscribe/
 * reconnect/close pipeline is reused untouched. The panel stays mounted while
 * the tab is hidden; `active` only gates fit and viewport updates.
 * The shell (U46-8) mounts this through `tabComponents.terminal` and supplies
 * the rpc/stream seam with `CloudWorkspaceTerminalTabProvider`.
 */

export type CloudWorkspaceTerminalTabDeps = {
  rpc: CloudRpc
  /** Null on the desktop preload today: no stream seam, so no terminal pane. */
  subscribe: CloudTerminalSubscribe | null
  /** The checkout returned by `cloud:openWorkspace`; null when not created. */
  workspacePath: string | null
  /** False only when the opened project lacks the `terminal` permission. */
  canUseTerminal?: boolean
  /** U96 B-令3: the host session-tab action layer creates this workspace's PTYs. */
  hostOwnsTerminalPty?: boolean
}

const CloudWorkspaceTerminalDepsContext = React.createContext<CloudWorkspaceTerminalTabDeps | null>(
  null
)

export function CloudWorkspaceTerminalTabProvider({
  rpc,
  subscribe,
  workspacePath,
  canUseTerminal,
  hostOwnsTerminalPty,
  children
}: CloudWorkspaceTerminalTabDeps & { children: React.ReactNode }): React.JSX.Element {
  const value = React.useMemo(
    () => ({ rpc, subscribe, workspacePath, canUseTerminal, hostOwnsTerminalPty }),
    [rpc, subscribe, workspacePath, canUseTerminal, hostOwnsTerminalPty]
  )
  return (
    <CloudWorkspaceTerminalDepsContext.Provider value={value}>
      {children}
    </CloudWorkspaceTerminalDepsContext.Provider>
  )
}

// Why lazy: the xterm chunk must stay out of the shell's first paint, the same
// split the standalone workspace page uses (W5a).
const LazyTerminalPanel = React.lazy(() =>
  import('./cloud-terminal-panel').then((module) => ({ default: module.CloudTerminalPanel }))
)

function TerminalNotice({
  testId,
  children
}: {
  testId: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <p data-testid={testId} className="p-3 text-xs leading-relaxed text-muted-foreground">
      {children}
    </p>
  )
}

export function CloudWorkspaceTerminalTab({
  tab,
  active
}: CloudSimpleWorkspaceTabComponentProps): React.JSX.Element | null {
  const deps = React.useContext(CloudWorkspaceTerminalDepsContext)
  const lifecycle = useCloudSimpleWorkspaceLifecycle()
  // Read at unmount: suspend flips the intent after this pane's last render.
  const detachPolicyResolver = React.useCallback(
    () => cloudTerminalDetachPolicy(lifecycle?.intent() ?? 'active'),
    [lifecycle]
  )
  // Defensive: the shell already refuses to render terminal tabs without the
  // permission, and the reducer never produces another kind here.
  if (tab.kind !== 'terminal') {
    return null
  }
  if (deps?.canUseTerminal === false) {
    return (
      <TerminalNotice testId="cloud-workspace-terminal-denied">
        当前项目未授予终端权限，终端面板不可用。
      </TerminalNotice>
    )
  }
  if (!deps || deps.subscribe === null) {
    return (
      <TerminalNotice testId="cloud-workspace-terminal-unavailable">
        终端流不可用，无法打开终端。
      </TerminalNotice>
    )
  }
  if (!deps.workspacePath) {
    return (
      <TerminalNotice testId="cloud-workspace-terminal-no-workspace">
        工作区尚未创建，无法打开终端。
      </TerminalNotice>
    )
  }
  // The host row carries the live PTY handle; a local tab has none until the
  // host projection acknowledges it (then its row supplies the same tab id).
  const host = tab.host
  const leafId = host?.leafId ?? `leaf:${tab.id.replace(/^terminal:/, '')}`
  const panelProps: CloudTerminalPanelProps = {
    rpc: deps.rpc,
    subscribe: deps.subscribe,
    workspacePath: deps.workspacePath,
    title: tab.title,
    tabId: tab.id,
    leafId,
    hostTerminal: host ? host.terminal : undefined,
    hostOwnsPty: deps.hostOwnsTerminalPty === true,
    active,
    detachPolicyResolver
  }
  return (
    <React.Suspense
      fallback={
        <div
          data-testid="cloud-workspace-terminal-loading"
          className="flex h-full items-center justify-center text-xs text-muted-foreground"
        >
          正在加载终端…
        </div>
      }
    >
      <LazyTerminalPanel {...panelProps} />
    </React.Suspense>
  )
}
