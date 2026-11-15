import * as React from 'react'
import { Eye, FileText, GitCompare, SquareTerminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  CLOUD_SIMPLE_WORKSPACE_MAX_TERMINAL_TABS,
  type CloudSimpleWorkspaceTab,
  type CloudSimpleWorkspaceTabKind
} from './cloud-simple-workspace-tabs'

/** §4.4: one icon per tab kind, so a scrolled strip still reads at a glance. */
const TAB_ICONS: Record<CloudSimpleWorkspaceTabKind, typeof FileText> = {
  terminal: SquareTerminal,
  editor: FileText,
  preview: Eye,
  diff: GitCompare
}

export function CloudSimpleWorkspaceTabStrip({
  tabs,
  activeId,
  dirty,
  canUseTerminal,
  nextTerminal,
  onActivate,
  onClose,
  onNewTerminal
}: {
  tabs: CloudSimpleWorkspaceTab[]
  activeId: string | null
  dirty: Record<string, boolean>
  canUseTerminal: boolean
  /** Null at the terminal cap; the "+ 终端" button is then disabled. */
  nextTerminal: boolean
  onActivate: (id: string) => void
  onClose: (tab: CloudSimpleWorkspaceTab) => void
  onNewTerminal: () => void
}): React.JSX.Element {
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
      <div
        role="tablist"
        aria-label="工作区标签"
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scrollbar-sleek"
      >
        {tabs.map((tab) => {
          const active = tab.id === activeId
          const Icon = TAB_ICONS[tab.kind]
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
                className={`flex items-center gap-1 px-2 py-1 text-xs ${active ? 'text-foreground' : 'text-muted-foreground'}`}
                onClick={() => onActivate(tab.id)}
              >
                <Icon className="size-3 shrink-0" aria-hidden />
                {tab.title}
                {dirty[tab.id] ? (
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
                title={tab.kind === 'terminal' ? '关闭将结束该终端会话' : `关闭 ${tab.title}`}
                data-testid={`cloud-simple-workspace-tab-close-${tab.id}`}
                className="px-1.5 py-1 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => onClose(tab)}
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
          disabled={!nextTerminal}
          title={
            nextTerminal ? '新建终端' : `最多 ${CLOUD_SIMPLE_WORKSPACE_MAX_TERMINAL_TABS} 个终端`
          }
          onClick={onNewTerminal}
        >
          + 终端
        </Button>
      ) : null}
    </div>
  )
}
