import React, { useSyncExternalStore } from 'react'
import { Cloud } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import {
  readWebCloudWorkspaceBootstrapStatus,
  retryWebCloudWorkspaceBootstrap,
  subscribeToWebCloudWorkspaceBootstrap,
  type WebCloudWorkspaceBootstrapStatus
} from '@/web/web-cloud-workspace-bootstrap'

/**
 * The workspace list of a cloud (ticket) session: the desktop's project catalog
 * is not part of what the ticket carries, so the list explains the scope instead
 * of showing the native "no workspaces" state. While the W13 workspace bootstrap
 * runs, the same card reports its phase, and a failed ensure offers a retry.
 */

function bootstrapBody(status: WebCloudWorkspaceBootstrapStatus): React.ReactNode {
  if (status.phase === 'loading') {
    return translate('auto.web.cloudSession.sidebarPreparing', 'Reading this project’s workspace…')
  }
  if (status.phase === 'registering') {
    return translate('auto.web.cloudSession.sidebarRegistering', 'Registering the project…')
  }
  if (status.phase === 'ensuring') {
    return translate('auto.web.cloudSession.sidebarEnsuring', 'Preparing your project checkout…')
  }
  if (status.phase === 'activating') {
    return translate('auto.web.cloudSession.sidebarOpening', 'Opening the workspace…')
  }
  if (status.phase === 'fallback') {
    if (status.fallbackReason === 'unsupported-host') {
      return translate(
        'auto.web.cloudSession.sidebarUnsupportedHost',
        'This Orca server’s version does not support the cloud workspace view yet.'
      )
    }
    if (status.fallbackReason === 'unavailable') {
      return translate(
        'auto.web.cloudSession.sidebarUnavailable',
        'The cloud workspace is not available in this client.'
      )
    }
    return (
      <>
        <span>
          {translate(
            'auto.web.cloudSession.sidebarFailed',
            'The cloud workspace could not be opened.'
          )}
        </span>
        {status.fallbackDetail ? (
          <span className="break-words">{status.fallbackDetail}</span>
        ) : null}
        {status.retryable ? (
          <Button
            variant="outline"
            size="xs"
            onClick={() => {
              void retryWebCloudWorkspaceBootstrap()
            }}
          >
            {translate('auto.web.cloudSession.sidebarRetry', 'Retry')}
          </Button>
        ) : null}
      </>
    )
  }
  return translate(
    'auto.web.cloudSession.sidebarBody',
    'This browser session is scoped to the project opened from the cloud platform. The desktop project catalog is not part of a cloud session.'
  )
}

export function SidebarCloudSessionEmptyState(): React.JSX.Element {
  const bootstrap = useSyncExternalStore(
    subscribeToWebCloudWorkspaceBootstrap,
    readWebCloudWorkspaceBootstrapStatus
  )
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
          <span>{bootstrapBody(bootstrap)}</span>
          {bootstrap.terminalNotGranted ? (
            <span>
              {translate(
                'auto.web.cloudSession.sidebarTerminalNotGranted',
                'This project’s ticket does not grant terminal access, so no workspace opens.'
              )}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  )
}
