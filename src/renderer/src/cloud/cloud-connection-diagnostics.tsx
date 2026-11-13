import * as React from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type {
  CloudConnectDiagnostics,
  CloudEndpointProbe
} from '../../../shared/cloud-platform-ipc'

/**
 * FR-5.7: the connection panel for a workspace that is *working*. It shows which
 * line was chosen, what it cost, and every address that was probed — the same
 * view a failed open shows, so the user learns the route before it breaks.
 */

const ROUTE_LABEL: Record<CloudEndpointProbe['route'], string> = {
  direct: '直连',
  relay: '中继'
}

export function routeLabel(route: 'direct' | 'relay'): string {
  return ROUTE_LABEL[route]
}

/** The probe that won, i.e. the line the session is actually using. */
export function chosenProbe(
  diagnostics: CloudConnectDiagnostics | undefined
): CloudEndpointProbe | null {
  const ok = (diagnostics?.probes ?? []).filter((probe) => probe.ok)
  return ok.at(-1) ?? null
}

export function CloudConnectionDiagnosticsDialog({
  route,
  diagnostics,
  onClose
}: {
  route: 'direct' | 'relay'
  diagnostics: CloudConnectDiagnostics
  onClose: () => void
}): React.JSX.Element {
  const chosen = chosenProbe(diagnostics)
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="cloud-connection-diagnostics-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4"
    >
      <div className="flex w-full max-w-lg flex-col gap-4 rounded-lg border border-border bg-card p-6 shadow-lg">
        <h2
          id="cloud-connection-diagnostics-title"
          className="text-base font-medium text-foreground"
        >
          {translate('auto.cloud.connectionDiagnosticsTitle', '连接诊断')}
        </h2>
        <dl className="flex flex-col gap-1 text-xs">
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">
              {translate('auto.cloud.connectionRoute', '当前线路')}
            </dt>
            <dd className="text-foreground" data-testid="cloud-diagnostics-route">
              {routeLabel(route)}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">
              {translate('auto.cloud.connectionLatency', '探测延迟')}
            </dt>
            <dd className="text-foreground" data-testid="cloud-diagnostics-latency">
              {chosen ? `${chosen.elapsedMs}ms` : '—'}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">
              {translate('auto.cloud.connectionEndpoint', '地址')}
            </dt>
            <dd
              className="break-all font-mono text-foreground"
              data-testid="cloud-diagnostics-endpoint"
            >
              {chosen?.endpoint ?? '—'}
            </dd>
          </div>
        </dl>
        <ol
          className="flex flex-col gap-1 rounded-md bg-muted/40 p-3 text-xs text-foreground"
          data-testid="cloud-diagnostics-steps"
        >
          {diagnostics.probes.map((probe, index) => (
            <li key={`${probe.route}-${probe.endpoint}`} className="flex justify-between gap-3">
              <span className="break-all">
                <span className="mr-2 text-muted-foreground">{index + 1}.</span>
                {routeLabel(probe.route)} {probe.endpoint}（{probe.elapsedMs}ms）
              </span>
              <span className={probe.ok ? 'text-foreground' : 'text-destructive'}>
                {probe.ok
                  ? translate('auto.cloud.connectProbeOk', '已连通')
                  : translate('auto.cloud.connectProbeFailed', '无响应')}
              </span>
            </li>
          ))}
        </ol>
        <div className="flex items-center justify-end">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {translate('auto.cloud.close', '关闭')}
          </Button>
        </div>
      </div>
    </div>
  )
}
