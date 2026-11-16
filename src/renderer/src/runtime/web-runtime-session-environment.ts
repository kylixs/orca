import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { getRuntimeEnvironmentRevision } from './runtime-environment-revision'
import { traceSessionTabsCall } from './web-session-tabs-sync/session-tabs-frame-trace'
import type { WebSessionIntentOwner } from './web-session-intent-owner'

export function isWebRuntimeSessionActive(
  activeRuntimeEnvironmentId: string | null | undefined
): boolean {
  // Why: headless serve sessions are owned by the remote runtime, whether the client is web or desktop Electron.
  return Boolean(activeRuntimeEnvironmentId?.trim())
}

export function captureRuntimeEnvironmentCall(
  environmentId: string,
  expectedEnvironmentPairingRevision = getRuntimeEnvironmentRevision(environmentId)
): (args: {
  method: string
  params?: unknown
  timeoutMs?: number
}) => Promise<RuntimeRpcResponse<unknown>> {
  return (args) =>
    traceSessionTabsCall(
      { selector: environmentId, method: args.method, params: args.params },
      () =>
        window.api.runtimeEnvironments.call({
          selector: environmentId,
          ...args,
          expectedEnvironmentPairingRevision
        })
    )
}

export function captureWebSessionIntentOwner(environmentId: string): WebSessionIntentOwner {
  return {
    environmentId,
    pairingRevision: getRuntimeEnvironmentRevision(environmentId)
  }
}

export function matchesWebSessionIntentOwner(owner: WebSessionIntentOwner): boolean {
  return getRuntimeEnvironmentRevision(owner.environmentId) === owner.pairingRevision
}
