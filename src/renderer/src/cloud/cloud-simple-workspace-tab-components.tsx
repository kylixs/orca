import type * as React from 'react'
import { CloudWorkspaceTerminalTab } from './cloud-workspace-terminal-tab'
import type {
  CloudSimpleWorkspaceTab,
  CloudSimpleWorkspaceTabKind,
  CloudSimpleWorkspaceTabsAction
} from './cloud-simple-workspace-tabs'
import type { CloudSimpleWorkspaceSaveHandler } from './cloud-simple-workspace-close-guard'

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
