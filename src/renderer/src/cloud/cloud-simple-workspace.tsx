import * as React from 'react'
import { Button } from '@/components/ui/button'
import type { CloudProjectPermission } from '../../../shared/cloud-platform-ipc'
import {
  CLOUD_SIMPLE_WORKSPACE_MAX_TERMINAL_TABS,
  cloudSimpleWorkspaceDirtyCount,
  cloudSimpleWorkspaceFileTab,
  cloudSimpleWorkspaceTabsInitialState,
  cloudSimpleWorkspaceTabsReducer,
  nextTerminalTab,
  type CloudSimpleWorkspaceTab,
  type CloudSimpleWorkspaceTabKind,
  type CloudSimpleWorkspaceTabsAction
} from './cloud-simple-workspace-tabs'
import {
  CloudSimpleWorkspaceStatusBar,
  type CloudSimpleWorkspaceConnection
} from './cloud-simple-workspace-status-bar'
import {
  CloudSimpleWorkspaceDegraded,
  CloudSimpleWorkspaceEmptyState,
  type CloudSimpleWorkspaceDegradedInfo
} from './cloud-simple-workspace-empty-state'
import {
  CloudSimpleWorkspaceRightPanel,
  type CloudSimpleWorkspaceFileTreeApi,
  type CloudSimpleWorkspaceGitApi
} from './cloud-simple-workspace-right-panel'

/**
 * Embedded simple workspace shell (U46-5a, design §4.3/§4.4): centre tabs plus a
 * right rail with file-tree and Git-changes tabs, bottom status bar. Tab panes
 * and rail contents are registered by later orders (U46-5b/6/7).
 * Layout composition follows AppWorkspaceShell (app-shell/AppWorkspaceShell.tsx):
 * a flex row of panels inside a min-h-0 column.
 * TODO(U46-8): mount this shell from CloudProjectWorkspace once wiring lands.
 */

export type CloudSimpleWorkspaceTabComponentProps = {
  tab: CloudSimpleWorkspaceTab
  /** False while the tab is mounted but hidden; panes must not fit or poll. */
  active: boolean
  dispatch: React.Dispatch<CloudSimpleWorkspaceTabsAction>
}

export type CloudSimpleWorkspaceTabComponents = Partial<
  Record<CloudSimpleWorkspaceTabKind, React.ComponentType<CloudSimpleWorkspaceTabComponentProps>>
>

function TabPlaceholder({ tab }: CloudSimpleWorkspaceTabComponentProps): React.JSX.Element {
  const label =
    tab.kind === 'terminal'
      ? '终端'
      : tab.kind === 'editor'
        ? '文件编辑'
        : tab.kind === 'preview'
          ? '预览'
          : 'Diff'
  return (
    <div
      data-testid={`cloud-simple-workspace-${tab.kind}-placeholder`}
      className="flex h-full items-center justify-center p-6 text-xs text-muted-foreground"
    >
      {label}面板将在后续版本接入。
    </div>
  )
}

export const CLOUD_SIMPLE_WORKSPACE_TAB_COMPONENTS: Record<
  CloudSimpleWorkspaceTabKind,
  React.ComponentType<CloudSimpleWorkspaceTabComponentProps>
> = {
  terminal: TabPlaceholder,
  editor: TabPlaceholder,
  preview: TabPlaceholder,
  diff: TabPlaceholder
}

export type {
  CloudSimpleWorkspaceFileTreeApi,
  CloudSimpleWorkspaceGitApi,
  CloudSimpleWorkspaceRightPanelKind
} from './cloud-simple-workspace-right-panel'

export type CloudSimpleWorkspaceProps = {
  route: 'direct' | 'relay'
  latencyMs?: number | null
  /** From `workspace.info`; null when the host did not report one. */
  branch?: string | null
  workspacePath?: string | null
  permissions?: CloudProjectPermission[] | null
  connection?: CloudSimpleWorkspaceConnection
  /** ensure failure: renders the explicit permission page, never an empty frame. */
  degraded?: CloudSimpleWorkspaceDegradedInfo | null
  /** Seed for tests and for a host that reopens a tab set; normally empty. */
  initialTabs?: CloudSimpleWorkspaceTab[]
  tabComponents?: CloudSimpleWorkspaceTabComponents
  renderFileTree?: (api: CloudSimpleWorkspaceFileTreeApi) => React.ReactNode
  renderGitChanges?: (api: CloudSimpleWorkspaceGitApi) => React.ReactNode
}

export function CloudSimpleWorkspace({
  route,
  latencyMs,
  branch,
  workspacePath,
  permissions,
  connection = 'connected',
  degraded,
  initialTabs,
  tabComponents,
  renderFileTree,
  renderGitChanges
}: CloudSimpleWorkspaceProps): React.JSX.Element {
  const [state, dispatch] = React.useReducer(
    cloudSimpleWorkspaceTabsReducer,
    initialTabs,
    cloudSimpleWorkspaceTabsInitialState
  )
  // Absent permissions predate the field; the host still enforces, so keep the
  // panes rather than hiding something that may work.
  const canUseTerminal = permissions?.includes('terminal') ?? true
  const canReadFiles = permissions?.includes('file:read') ?? true
  const nextTerminal = nextTerminalTab(state.tabs)

  const openFile = React.useCallback((path: string) => {
    dispatch({ type: 'open', tab: cloudSimpleWorkspaceFileTab(path) })
  }, [])

  if (degraded) {
    return (
      <div data-testid="cloud-simple-workspace" className="flex h-full flex-col bg-background">
        <CloudSimpleWorkspaceDegraded {...degraded} />
      </div>
    )
  }

  return (
    <div
      data-testid="cloud-simple-workspace"
      className="flex h-full min-h-0 flex-col bg-background"
    >
      <div className="flex min-h-0 flex-1">
        <main data-testid="cloud-simple-workspace-tabs" className="flex min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
            <div
              role="tablist"
              aria-label="工作区标签"
              className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scrollbar-sleek"
            >
              {state.tabs.map((tab) => {
                const active = tab.id === state.activeId
                return (
                  <div
                    key={tab.id}
                    className="flex shrink-0 items-center rounded border border-border bg-card"
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={active}
                      data-testid={`cloud-simple-workspace-tab-${tab.id}`}
                      className={`px-2 py-1 text-xs ${active ? 'text-foreground' : 'text-muted-foreground'}`}
                      onClick={() => dispatch({ type: 'activate', id: tab.id })}
                    >
                      {tab.title}
                      {state.dirty[tab.id] ? (
                        <span
                          aria-label="未保存"
                          data-testid={`cloud-simple-workspace-tab-dirty-${tab.id}`}
                          className="ml-1 text-foreground"
                        >
                          ●
                        </span>
                      ) : null}
                    </button>
                    <button
                      type="button"
                      aria-label={`关闭 ${tab.title}`}
                      data-testid={`cloud-simple-workspace-tab-close-${tab.id}`}
                      className="px-1.5 py-1 text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => dispatch({ type: 'close', id: tab.id })}
                    >
                      ×
                    </button>
                  </div>
                )
              })}
            </div>
            {canUseTerminal ? (
              <Button
                variant="ghost"
                size="sm"
                data-testid="cloud-simple-workspace-new-terminal"
                disabled={nextTerminal === null}
                title={
                  nextTerminal === null
                    ? `最多 ${CLOUD_SIMPLE_WORKSPACE_MAX_TERMINAL_TABS} 个终端`
                    : '新建终端'
                }
                onClick={() => {
                  if (nextTerminal) {
                    dispatch({ type: 'open', tab: nextTerminal })
                  }
                }}
              >
                + 终端
              </Button>
            ) : null}
          </div>

          <div className="flex min-h-0 flex-1 flex-col">
            {state.tabs.length === 0 ? (
              <CloudSimpleWorkspaceEmptyState canUseTerminal={canUseTerminal} />
            ) : (
              state.tabs.map((tab) => {
                const active = tab.id === state.activeId
                const Component =
                  tabComponents?.[tab.kind] ?? CLOUD_SIMPLE_WORKSPACE_TAB_COMPONENTS[tab.kind]
                return (
                  <div
                    key={tab.id}
                    role="tabpanel"
                    aria-label={tab.title}
                    hidden={!active}
                    data-testid={`cloud-simple-workspace-pane-${tab.id}`}
                    className="min-h-0 flex-1"
                  >
                    {tab.kind === 'terminal' && !canUseTerminal ? (
                      <p
                        data-testid="cloud-simple-workspace-terminal-denied"
                        className="p-3 text-xs leading-relaxed text-muted-foreground"
                      >
                        当前项目未授予终端权限，终端面板不可用。
                      </p>
                    ) : (
                      <Component tab={tab} active={active} dispatch={dispatch} />
                    )}
                  </div>
                )
              })
            )}
          </div>
        </main>

        <CloudSimpleWorkspaceRightPanel
          canReadFiles={canReadFiles}
          canUseTerminal={canUseTerminal}
          workspacePath={workspacePath}
          renderFileTree={renderFileTree}
          renderGitChanges={renderGitChanges}
          openFile={openFile}
        />
      </div>

      <CloudSimpleWorkspaceStatusBar
        connection={connection}
        route={route}
        latencyMs={latencyMs}
        branch={branch}
        workspacePath={workspacePath}
        dirtyCount={cloudSimpleWorkspaceDirtyCount(state)}
      />
    </div>
  )
}
