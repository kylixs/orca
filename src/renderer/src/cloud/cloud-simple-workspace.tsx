import * as React from 'react'
import type { CloudProjectPermission } from '../../../shared/cloud-platform-ipc'
import { readField, readObjectValue, readString, readStringArray } from '../../../shared/json-fields'
import type { CloudRpc } from '../../../shared/cloud-file-browser'
import {
  cloudSimpleWorkspaceDiffTab,
  cloudSimpleWorkspaceDirtyCount,
  cloudSimpleWorkspaceFileTab,
  cloudSimpleWorkspaceTabsInitialState,
  cloudSimpleWorkspaceTabsReducer,
  nextTerminalTab,
  type CloudSimpleWorkspaceTab,
  type CloudSimpleWorkspaceTabKind,
  type CloudSimpleWorkspaceTabsAction
} from './cloud-simple-workspace-tabs'
import { CloudSimpleWorkspaceTabStrip } from './cloud-simple-workspace-tab-strip'
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
  type CloudSimpleWorkspaceGitApi,
  type CloudSimpleWorkspaceOpenDiff
} from './cloud-simple-workspace-right-panel'
import {
  CloudWorkspaceTerminalTab,
  CloudWorkspaceTerminalTabProvider
} from './cloud-workspace-terminal-tab'
import { createCloudWorkspaceFileTab } from './cloud-workspace-file-tab'
import {
  CloudSimpleWorkspaceCloseConfirm,
  useCloudSimpleWorkspaceCloseGuard,
  type CloudSimpleWorkspaceSaveHandler
} from './cloud-simple-workspace-close-guard'
import { createCloudWorkspacePreviewTab } from './cloud-workspace-preview-tab'
import { resolveCloudFileFormat } from './file-renderers/registry'
import { createCloudWorkspaceDiffTab } from './cloud-workspace-diff-tab'
import { CloudWorkspaceFileTree } from './cloud-workspace-file-tree'
import { CloudWorkspaceGitPanel } from './cloud-workspace-git-panel'
import type { CloudTerminalSubscribe } from './cloud-terminal-panel'
import {
  useCloudSimpleWorkspaceSessionTabs,
  type CloudSimpleWorkspaceHostSnapshot
} from './use-cloud-simple-workspace-session-tabs'

/**
 * Embedded simple workspace shell (U46-5a, design §4.3/§4.4): centre tabs plus a
 * right rail with file-tree and Git-changes tabs, bottom status bar. U46-8
 * registers the four pane factories and the two rail panes on live RPC.
 * Layout composition follows AppWorkspaceShell (app-shell/AppWorkspaceShell.tsx):
 * a flex row of panels inside a min-h-0 column.
 */

export type CloudSimpleWorkspaceTabComponentProps = {
  tab: CloudSimpleWorkspaceTab
  /** False while the tab is mounted but hidden; panes must not fit or poll. */
  active: boolean
  dispatch: React.Dispatch<CloudSimpleWorkspaceTabsAction>
  /** Lets a dirty close save through this pane before the tab unmounts. */
  registerSave?: (tabId: string, save: CloudSimpleWorkspaceSaveHandler | null) => void
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
  terminal: CloudWorkspaceTerminalTab,
  editor: TabPlaceholder,
  preview: TabPlaceholder,
  diff: TabPlaceholder
}

export type {
  CloudSimpleWorkspaceFileTreeApi,
  CloudSimpleWorkspaceGitApi,
  CloudSimpleWorkspaceRightPanelKind
} from './cloud-simple-workspace-right-panel'

/**
 * One click → one tab (U46-8). The format registry decides which host owns the
 * file; unknown extensions fall through to the text host, whose read result
 * refines a binary payload into the placeholder (FS-1).
 */
export function cloudSimpleWorkspaceTabForFile(path: string): CloudSimpleWorkspaceTab {
  const renderer = resolveCloudFileFormat(path)
  if (renderer.source === 'binary') {
    const mode = renderer.id === 'image' ? 'image' : renderer.id === 'pdf' ? 'preview' : 'binary'
    return cloudSimpleWorkspaceFileTab(path, 'preview', mode)
  }
  return cloudSimpleWorkspaceFileTab(path)
}

export type CloudSimpleWorkspaceProps = {
  route: 'direct' | 'relay'
  latencyMs?: number | null
  /** Context line: which project this checkout belongs to. */
  projectName?: string | null
  /** From `workspace.info`; null when the host did not report one. */
  branch?: string | null
  workspacePath?: string | null
  permissions?: CloudProjectPermission[] | null
  connection?: CloudSimpleWorkspaceConnection
  /** ensure failure: renders the explicit permission page, never an empty frame. */
  degraded?: CloudSimpleWorkspaceDegradedInfo | null
  /** Seed for tests and for a host that reopens a tab set; normally empty. */
  initialTabs?: CloudSimpleWorkspaceTab[]
  /** U96 B-令2: host session-tab projection applied through the `host-snapshot` action. */
  hostSnapshot?: CloudSimpleWorkspaceHostSnapshot | null
  tabComponents?: CloudSimpleWorkspaceTabComponents
  renderFileTree?: (api: CloudSimpleWorkspaceFileTreeApi) => React.ReactNode
  renderGitChanges?: (api: CloudSimpleWorkspaceGitApi) => React.ReactNode
  /** Embed protocol (§4.2): the console asks before discarding dirty buffers. */
  onDirtyCountChange?: (count: number) => void
  /** Which tab a file click opens; defaults to the editor. */
  fileTab?: (path: string) => CloudSimpleWorkspaceTab
}

export function CloudSimpleWorkspace({
  route,
  latencyMs,
  projectName,
  branch,
  workspacePath,
  permissions,
  connection = 'connected',
  degraded,
  initialTabs,
  hostSnapshot,
  tabComponents,
  renderFileTree,
  renderGitChanges,
  onDirtyCountChange,
  fileTab
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
  const dirtyCount = cloudSimpleWorkspaceDirtyCount(state)
  const closeGuard = useCloudSimpleWorkspaceCloseGuard(state.dirty, dispatch)

  const openFile = React.useCallback(
    (path: string) => {
      dispatch({
        type: 'open',
        tab: fileTab ? fileTab(path) : cloudSimpleWorkspaceTabForFile(path)
      })
    },
    [fileTab]
  )

  const openDiff = React.useCallback<CloudSimpleWorkspaceOpenDiff>((path, _status, source) => {
    dispatch({ type: 'open', tab: cloudSimpleWorkspaceDiffTab(path, source) })
  }, [])

  React.useEffect(() => {
    onDirtyCountChange?.(dirtyCount)
  }, [dirtyCount, onDirtyCountChange])

  React.useEffect(() => {
    if (hostSnapshot) {
      dispatch({
        type: 'host-snapshot',
        tabs: hostSnapshot.tabs,
        activeId: hostSnapshot.activeTabId
      })
    }
  }, [hostSnapshot])

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
          <CloudSimpleWorkspaceTabStrip
            tabs={state.tabs}
            activeId={state.activeId}
            dirty={state.dirty}
            canUseTerminal={canUseTerminal}
            nextTerminal={nextTerminal !== null}
            onActivate={(id) => dispatch({ type: 'activate', id })}
            onClose={closeGuard.requestClose}
            onNewTerminal={() => {
              if (nextTerminal) {
                dispatch({ type: 'open', tab: nextTerminal })
              }
            }}
          />

          <div className="flex min-h-0 flex-1 flex-col">
            {state.tabs.length === 0 ? (
              <CloudSimpleWorkspaceEmptyState
                canUseTerminal={canUseTerminal}
                canReadFiles={canReadFiles}
              />
            ) : (
              state.tabs.map((tab) => {
                const active = tab.id === state.activeId
                const Component =
                  tabComponents?.[tab.kind] ?? CLOUD_SIMPLE_WORKSPACE_TAB_COMPONENTS[tab.kind]
                // Why a block wrapper: `hidden` must still collapse inactive panes.
                return (
                  <div
                    key={tab.id}
                    role="tabpanel"
                    aria-label={tab.title}
                    hidden={!active}
                    data-testid={`cloud-simple-workspace-pane-${tab.id}`}
                    className="min-h-0 flex-1 [&>*]:h-full"
                  >
                    {tab.kind === 'terminal' && !canUseTerminal ? (
                      <p
                        data-testid="cloud-simple-workspace-terminal-denied"
                        className="p-3 text-xs leading-relaxed text-muted-foreground"
                      >
                        当前项目未授予终端权限，终端面板不可用。
                      </p>
                    ) : (
                      <Component
                        tab={tab}
                        active={active}
                        dispatch={dispatch}
                        registerSave={closeGuard.registerSave}
                      />
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
          openDiff={openDiff}
        />
      </div>

      <CloudSimpleWorkspaceStatusBar
        connection={connection}
        route={route}
        latencyMs={latencyMs}
        projectName={projectName}
        branch={branch}
        workspacePath={workspacePath}
        dirtyCount={dirtyCount}
      />

      <CloudSimpleWorkspaceCloseConfirm
        confirm={closeGuard.confirm}
        canSave={closeGuard.canSave}
        saving={closeGuard.saving}
        onSave={closeGuard.saveAndClose}
        onDiscard={closeGuard.discard}
        onCancel={closeGuard.cancel}
      />
    </div>
  )
}

export type CloudSimpleWorkspaceSessionProps = {
  projectName: string
  route: 'direct' | 'relay'
  latencyMs?: number | null
  /** The checkout from `cloud:openWorkspace`; a viewer ticket has none. */
  workspacePath?: string | null
  permissions?: CloudProjectPermission[] | null
  rpc: CloudRpc
  subscribe?: CloudTerminalSubscribe | null
  connection?: CloudSimpleWorkspaceConnection
  degraded?: CloudSimpleWorkspaceDegradedInfo | null
  onDirtyCountChange?: (count: number) => void
}

/**
 * U46-8 assembly: binds the shell's four tab kinds to the live-RPC factories
 * and its rail to the file-tree/Git panes, then asks `workspace.info` for the
 * branch (the checkout exists by the time the embed opens — `openWorkspace`
 * ensures it). Without a checkout the rail renders its no-workspace states.
 */
export function CloudSimpleWorkspaceSession({
  projectName,
  route,
  latencyMs,
  workspacePath,
  permissions,
  rpc,
  subscribe = null,
  connection,
  degraded,
  onDirtyCountChange
}: CloudSimpleWorkspaceSessionProps): React.JSX.Element {
  // Path-keyed, so a stale reply for the previous checkout is ignored instead of reset in an effect.
  const [workspaceInfo, setWorkspaceInfo] = React.useState<{
    path: string
    branch: string | null
    capabilities: readonly string[]
  } | null>(null)
  const canUseTerminal = permissions?.includes('terminal') ?? true
  const canReadFiles = permissions?.includes('file:read') ?? true

  React.useEffect(() => {
    if (!workspacePath) {
      return
    }
    let cancelled = false
    void rpc('workspace.info')
      .then((outcome) => {
        if (cancelled || !outcome.ok) {
          return
        }
        const workspace = readObjectValue(readField(outcome.result, 'workspace'))
        setWorkspaceInfo({
          path: workspacePath,
          branch: workspace === null ? null : readString(workspace, 'branch'),
          capabilities: readStringArray(outcome.result, 'capabilities') ?? []
        })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [rpc, workspacePath])

  const currentInfo =
    workspaceInfo !== null && workspaceInfo.path === workspacePath ? workspaceInfo : null
  const branch = currentInfo?.branch ?? null
  const capabilities = currentInfo?.capabilities ?? null

  const sessionTabs = useCloudSimpleWorkspaceSessionTabs({
    rpc,
    subscribe,
    workspacePath,
    capabilities
  })

  const tabComponents = React.useMemo<CloudSimpleWorkspaceTabComponents>(() => {
    if (!workspacePath) {
      return {}
    }
    return {
      terminal: CloudWorkspaceTerminalTab,
      editor: createCloudWorkspaceFileTab({ rpc, workspacePath, permissions }),
      preview: createCloudWorkspacePreviewTab({
        rpc,
        workspacePath,
        permissions
      }),
      diff: createCloudWorkspaceDiffTab({ rpc, workspacePath, permissions })
    }
  }, [permissions, rpc, workspacePath])

  return (
    <CloudWorkspaceTerminalTabProvider
      rpc={rpc}
      subscribe={subscribe}
      workspacePath={workspacePath ?? null}
      canUseTerminal={canUseTerminal}
    >
      <CloudSimpleWorkspace
        route={route}
        latencyMs={latencyMs}
        projectName={projectName}
        branch={branch}
        workspacePath={workspacePath}
        permissions={permissions}
        connection={connection}
        degraded={degraded}
        hostSnapshot={sessionTabs.hostSnapshot}
        tabComponents={tabComponents}
        renderFileTree={
          workspacePath
            ? ({ openFile }) => (
                <CloudWorkspaceFileTree
                  rpc={rpc}
                  workspacePath={workspacePath}
                  canReadFiles={canReadFiles}
                  onOpenFile={openFile}
                />
              )
            : undefined
        }
        renderGitChanges={
          workspacePath
            ? ({ onOpenDiff }) => (
                <CloudWorkspaceGitPanel
                  rpc={rpc}
                  workspacePath={workspacePath}
                  canReadFiles={canReadFiles}
                  onOpenDiff={onOpenDiff}
                />
              )
            : undefined
        }
        onDirtyCountChange={onDirtyCountChange}
        fileTab={cloudSimpleWorkspaceTabForFile}
      />
    </CloudWorkspaceTerminalTabProvider>
  )
}
