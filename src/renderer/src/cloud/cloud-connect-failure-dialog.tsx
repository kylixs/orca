import * as React from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type {
  CloudConnectDiagnostics,
  CloudEndpointProbe
} from '../../../shared/cloud-platform-ipc'

/**
 * AC-07: when neither direct nor relay answers, the panel shows the error code,
 * every address that was tried with its outcome, and a retry — plus a copy
 * action so the user can hand the same diagnosis to an administrator.
 *
 * Why a dialog and not a toast: the error code alone says nothing about which
 * hop failed, and that is exactly what the user needs to escalate.
 */

const ROUTE_LABEL: Record<CloudEndpointProbe['route'], string> = {
  direct: '直连',
  relay: '中继'
}

function probeLine(probe: CloudEndpointProbe): string {
  const outcome = probe.ok ? '可达' : '不可达'
  return `${ROUTE_LABEL[probe.route]} ${probe.endpoint} ${outcome}（${probe.elapsedMs}ms）`
}

/** What the copy button puts on the clipboard: one line per step, code first. */
export function connectDiagnosticsText(code: string, diagnostics: CloudConnectDiagnostics): string {
  return [code, ...diagnostics.probes.map(probeLine)].join('\n')
}

export function CloudConnectFailureDialog({
  code,
  diagnostics,
  retrying,
  onRetry,
  onClose
}: {
  code: string
  diagnostics: CloudConnectDiagnostics
  retrying: boolean
  onRetry: () => void
  onClose: () => void
}): React.JSX.Element {
  const [copied, setCopied] = React.useState(false)

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(connectDiagnosticsText(code, diagnostics))
      setCopied(true)
    } catch {
      // Clipboard may be unavailable (permissions); the text is on screen anyway.
      setCopied(false)
    }
  }

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="cloud-connect-failure-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4"
    >
      <div className="flex w-full max-w-lg flex-col gap-4 rounded-lg border border-border bg-card p-6 shadow-lg">
        <h2 id="cloud-connect-failure-title" className="text-base font-medium text-foreground">
          {translate('auto.cloud.connectFailedTitle', '无法连接到开发机')}
        </h2>
        <p className="text-sm text-muted-foreground">
          {translate(
            'auto.cloud.connectFailedBody',
            '直连与中继地址都没有响应。请确认开发机在线，或把下面的诊断信息发给平台管理员。'
          )}
        </p>
        <div className="flex flex-col gap-1 text-xs">
          <div className="text-muted-foreground">
            {translate('auto.cloud.connectFailedCode', '错误码')}
          </div>
          <div className="font-mono text-foreground" data-testid="cloud-connect-failure-code">
            {code}
          </div>
        </div>
        <ol
          className="flex flex-col gap-1 rounded-md bg-muted/40 p-3 text-xs text-foreground"
          data-testid="cloud-connect-failure-steps"
        >
          {diagnostics.probes.map((probe, index) => (
            <li key={`${probe.route}-${probe.endpoint}`} className="flex justify-between gap-3">
              <span className="break-all">
                <span className="mr-2 text-muted-foreground">{index + 1}.</span>
                {probeLine(probe)}
              </span>
              <span className={probe.ok ? 'text-foreground' : 'text-destructive'}>
                {probe.ok
                  ? translate('auto.cloud.connectProbeOk', '已连通')
                  : translate('auto.cloud.connectProbeFailed', '无响应')}
              </span>
            </li>
          ))}
        </ol>
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={retrying}>
            {translate('auto.cloud.close', '关闭')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void copy()} disabled={retrying}>
            {copied
              ? translate('auto.cloud.copied', '已复制')
              : translate('auto.cloud.copyDiagnostics', '复制诊断信息')}
          </Button>
          <Button size="sm" onClick={onRetry} disabled={retrying}>
            {retrying
              ? translate('auto.cloud.retrying', '重试中…')
              : translate('auto.cloud.retry', '重试')}
          </Button>
        </div>
      </div>
    </div>
  )
}
