import React from 'react'
import { Cloud } from 'lucide-react'
import { translate } from '@/i18n/i18n'

/**
 * The workspace list of a cloud (ticket) session: the desktop's project catalog
 * is not part of what the ticket carries, so the list explains the scope instead
 * of showing the native "no workspaces" state.
 */
export function SidebarCloudSessionEmptyState(): React.JSX.Element {
  return (
    <div
      data-worktree-sidebar-container
      data-contextual-tour-target="workspace-list"
      className="relative min-h-0 flex-1"
    >
      <div className="worktree-sidebar-scrollbar flex h-full flex-col overflow-y-auto overflow-x-hidden pl-1 scrollbar-sleek pt-px">
        <div className="flex flex-col items-center gap-2 px-4 py-6 text-center text-[11px] text-muted-foreground">
          <Cloud className="size-5 text-muted-foreground" aria-hidden />
          <span className="font-medium text-foreground">
            {translate('auto.web.cloudSession.sidebarTitle', 'Cloud project session')}
          </span>
          <span>
            {translate(
              'auto.web.cloudSession.sidebarBody',
              'This browser session is scoped to the project opened from the cloud platform. The desktop project catalog is not part of a cloud session.'
            )}
          </span>
        </div>
      </div>
    </div>
  )
}
