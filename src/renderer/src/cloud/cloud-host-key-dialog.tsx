import * as React from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { CloudHostKeyMismatch } from '../../../shared/cloud-platform-ipc'

/**
 * AC-29: a changed host key is never adopted silently. The user sees both
 * fingerprints and must re-verify before the pin moves.
 */
export function CloudHostKeyDialog({
  mismatch,
  busy,
  onConfirm,
  onCancel
}: {
  mismatch: CloudHostKeyMismatch
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="cloud-host-key-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4"
    >
      <div className="flex w-full max-w-lg flex-col gap-4 rounded-lg border border-border bg-card p-6 shadow-lg">
        <h2 id="cloud-host-key-title" className="text-base font-medium text-foreground">
          {translate('auto.cloud.hostKeyChangedTitle', '主机公钥已变更')}
        </h2>
        <p className="text-sm text-muted-foreground">
          {translate(
            'auto.cloud.hostKeyChangedBody',
            '该开发机上报的公钥与首次连接时固定的不一致。若不是运维人员确认过的主机重装，请取消并联系平台管理员。'
          )}
        </p>
        <dl className="flex flex-col gap-2 rounded-md bg-muted/40 p-3 text-xs">
          <div className="flex flex-col gap-1">
            <dt className="text-muted-foreground">
              {translate('auto.cloud.hostKeyPinned', '已固定指纹')}
            </dt>
            <dd className="break-all font-mono text-foreground" data-testid="cloud-host-key-pinned">
              {mismatch.pinnedFingerprint}
            </dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="text-muted-foreground">
              {translate('auto.cloud.hostKeySeen', '本次收到的指纹')}
            </dt>
            <dd className="break-all font-mono text-foreground" data-testid="cloud-host-key-seen">
              {mismatch.seenFingerprint}
            </dd>
          </div>
        </dl>
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            {translate('auto.cloud.cancel', '取消')}
          </Button>
          <Button variant="destructive" size="sm" onClick={onConfirm} disabled={busy}>
            {translate('auto.cloud.hostKeyConfirm', '我已核对，信任新公钥')}
          </Button>
        </div>
      </div>
    </div>
  )
}
