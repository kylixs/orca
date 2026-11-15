import * as React from 'react'
import type { GitFileStatus } from '../../../shared/git-status-types'
import { CloudSimpleWorkspaceFileTreePlaceholder } from './cloud-simple-workspace-empty-state'

/**
 * Right rail skeleton (U46-5a): file tree and Git changes side by side as two
 * tabs. The panes themselves are mount points registered by U46-6/U46-7; Git
 * reads need `terminal`, the same permission as `git.*` RPCs.
 */

export type CloudSimpleWorkspaceRightPanelKind = 'files' | 'git'

/** What the file-tree pane needs from the shell: the signed root and the open verb. */
export type CloudSimpleWorkspaceFileTreeApi = {
  workspacePath: string
  openFile: (path: string) => void
}

export type CloudSimpleWorkspaceOpenDiff = (path: string, status: GitFileStatus) => void

export type CloudSimpleWorkspaceGitApi = {
  workspacePath: string
  canReadFiles?: boolean
  onOpenDiff?: CloudSimpleWorkspaceOpenDiff
}

export type CloudSimpleWorkspaceRightPanelProps = {
  canReadFiles: boolean
  canUseTerminal: boolean
  workspacePath?: string | null
  renderFileTree?: (api: CloudSimpleWorkspaceFileTreeApi) => React.ReactNode
  renderGitChanges?: (api: CloudSimpleWorkspaceGitApi) => React.ReactNode
  openFile: (path: string) => void
  openDiff?: CloudSimpleWorkspaceOpenDiff
}

function unavailable(testId: string, text: string): React.JSX.Element {
  return (
    <p data-testid={testId} className="p-3 text-xs leading-relaxed text-muted-foreground">
      {text}
    </p>
  )
}

export function CloudSimpleWorkspaceRightPanel({
  canReadFiles,
  canUseTerminal,
  workspacePath,
  renderFileTree,
  renderGitChanges,
  openFile,
  openDiff
}: CloudSimpleWorkspaceRightPanelProps): React.JSX.Element {
  const [active, setActive] = React.useState<CloudSimpleWorkspaceRightPanelKind>('files')

  function filesPane(): React.ReactNode {
    if (!canReadFiles) {
      return <CloudSimpleWorkspaceFileTreePlaceholder reason="no-permission" />
    }
    if (!workspacePath) {
      return <CloudSimpleWorkspaceFileTreePlaceholder reason="no-workspace" />
    }
    return renderFileTree ? (
      renderFileTree({ workspacePath, openFile })
    ) : (
      <CloudSimpleWorkspaceFileTreePlaceholder reason="slot" />
    )
  }

  function gitPane(): React.ReactNode {
    if (!canUseTerminal) {
      return unavailable(
        'cloud-simple-workspace-git-no-permission',
        '当前项目未授予终端权限，无法读取 Git 变更。'
      )
    }
    if (!workspacePath) {
      return unavailable(
        'cloud-simple-workspace-git-no-workspace',
        '工作区尚未创建，无法打开 Git 变更面板。'
      )
    }
    return renderGitChanges
      ? renderGitChanges({ workspacePath, canReadFiles, onOpenDiff: openDiff })
      : unavailable('cloud-simple-workspace-git-slot', 'Git 变更面板将在后续版本接入。')
  }

  return (
    <aside
      data-testid="cloud-simple-workspace-right-panel"
      className="flex w-[300px] shrink-0 flex-col border-l border-border bg-card"
    >
      <div role="tablist" aria-label="右侧面板" className="flex shrink-0 border-b border-border">
        {(['files', 'git'] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            role="tab"
            aria-selected={active === kind}
            data-testid={`cloud-simple-workspace-right-tab-${kind}`}
            className={`flex-1 px-3 py-2 text-xs ${
              active === kind ? 'text-foreground' : 'text-muted-foreground'
            }`}
            onClick={() => setActive(kind)}
          >
            {kind === 'files' ? '文件' : 'Git 变更'}
          </button>
        ))}
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scrollbar-sleek">
        {active === 'files' ? filesPane() : gitPane()}
      </div>
    </aside>
  )
}
