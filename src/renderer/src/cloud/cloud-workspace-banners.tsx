import * as React from 'react'
import type {
  CloudCreateProjectResult,
  CloudProjectFailure
} from '../../../shared/cloud-platform-ipc'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { CloudNewProjectDialog } from './cloud-new-project-dialog'
import type { CloudBridge } from './use-cloud-session'

/** Non-blocking: the shell stays usable while the host prepares the checkout. */
export function PreparingCloudProjectBanner(): React.JSX.Element {
  return (
    <div className="pointer-events-none fixed left-1/2 top-3 z-50 -translate-x-1/2">
      <div
        role="status"
        className="flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-xs text-muted-foreground shadow-xs"
      >
        <span className="size-2 animate-pulse rounded-full bg-muted-foreground" />
        {translate('auto.cloud.preparing', '正在准备云端项目…')}
      </div>
    </div>
  )
}

/** Bottom-right, below the z-50 failure banner that owns the bottom centre. */
export function NewCloudProjectButton({
  bridge,
  onCreated
}: {
  bridge: CloudBridge
  onCreated: (result: CloudCreateProjectResult) => Promise<void> | void
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <div className="fixed bottom-3 right-3 z-40">
        <Button variant="outline" size="xs" onClick={() => setOpen(true)}>
          {translate('auto.cloud.newProject', '新建云端项目')}
        </Button>
      </div>
      <CloudNewProjectDialog
        bridge={bridge}
        open={open}
        onOpenChange={setOpen}
        onCreated={onCreated}
      />
    </>
  )
}

const MAX_VISIBLE_FAILURES = 3

/**
 * Why a banner and not a modal: one unprepared project must not block the shell
 * or the projects that did register; the admin may fix the source later.
 */
export function CloudProjectFailureBanner({
  failures,
  retrying,
  onRetry
}: {
  failures: readonly CloudProjectFailure[]
  retrying: boolean
  onRetry: () => void
}): React.JSX.Element | null {
  if (failures.length === 0) {
    return null
  }
  const visible = failures.slice(0, MAX_VISIBLE_FAILURES)
  const hiddenCount = failures.length - visible.length
  return (
    <div className="fixed bottom-3 left-1/2 z-50 -translate-x-1/2">
      <div
        role="alert"
        className="flex max-w-md flex-col gap-2 rounded-md border bg-card px-3 py-2 text-xs shadow-xs"
      >
        <div className="font-medium text-foreground">
          {translate('auto.cloud.prepareFailedTitle', '部分云端项目准备失败')}
        </div>
        <ul className="space-y-1 text-muted-foreground">
          {visible.map((failure) => (
            <li key={failure.projectId} className="break-all">
              {failure.projectName}（{failure.code}）
            </li>
          ))}
        </ul>
        {hiddenCount > 0 ? (
          <div className="text-muted-foreground">
            {translate('auto.cloud.prepareFailedMore', '等 {{count}} 个', { count: hiddenCount })}
          </div>
        ) : null}
        <Button size="xs" variant="outline" disabled={retrying} onClick={onRetry}>
          {translate('auto.cloud.retry', '重试')}
        </Button>
      </div>
    </div>
  )
}
