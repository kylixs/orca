import * as React from 'react'
import { Button } from '@/components/ui/button'
import {
  CLOUD_SIMPLE_WORKSPACE_MAX_TERMINAL_TABS,
  type CloudSimpleWorkspaceTab
} from './cloud-simple-workspace-tabs'

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
                onClick={() => onActivate(tab.id)}
              >
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
