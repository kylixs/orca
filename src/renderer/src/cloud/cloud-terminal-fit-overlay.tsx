import * as React from 'react'
import { MonitorSmartphone } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { CloudTerminalFitConflict } from './cloud-terminal-fit-overlay-state'

/**
 * Size-conflict prompt for the simple workspace (U96 B-令6, design §3.3).
 *
 * Same visual family as the desktop `MobileDriverOverlay` — card, floating
 * shadow, secondary "keep" — but scoped to the host's fit-floor vocabulary.
 */

export type CloudTerminalFitOverlayProps = {
  conflict: CloudTerminalFitConflict
  /** `null` = host global says "indefinite"; undefined = not known yet. */
  autoRestoreMs?: number | null
  autoRestoreText?: string | null
  pending: boolean
  onTakeOver: () => void | Promise<void>
  onKeep: () => void
}

export function CloudTerminalFitOverlay({
  conflict,
  autoRestoreText,
  pending,
  onTakeOver,
  onKeep
}: CloudTerminalFitOverlayProps): React.JSX.Element {
  const remote = conflict === 'remote-desktop'
  const title = remote ? '当前尺寸由另一个窗口控制' : '当前尺寸由手机控制'
  const body = remote
    ? '另一端的窗口正在驱动此终端的尺寸。接管后将以本窗口的尺寸显示。'
    : '手机正在或曾经驱动此终端的尺寸。恢复到本窗口尺寸即可继续使用桌面布局。'
  return (
    <div
      data-testid="cloud-terminal-fit-overlay"
      role="dialog"
      aria-live="assertive"
      className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center p-6"
    >
      <div className="pointer-events-auto flex w-full max-w-sm gap-3 rounded-lg border border-border bg-card p-4 text-card-foreground shadow-floating">
        <MonitorSmartphone
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="text-sm font-semibold leading-5">{title}</div>
          <div className="mt-0.5 text-sm text-muted-foreground">{body}</div>
          {autoRestoreText ? (
            <div
              data-testid="cloud-terminal-fit-overlay-auto-restore"
              className="mt-1 text-xs text-muted-foreground"
            >
              {autoRestoreText}
            </div>
          ) : null}
          <div className="mt-3 flex flex-wrap justify-end gap-1.5">
            <Button type="button" variant="ghost" size="sm" onClick={onKeep} disabled={pending}>
              保持现状
            </Button>
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={() => void onTakeOver()}
              disabled={pending}
            >
              {remote ? '使用本窗口尺寸' : '恢复为本窗口尺寸'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
