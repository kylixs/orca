import * as React from 'react'
import { CloudApp } from './cloud-app'
import type { CloudBridge } from './use-cloud-session'

/**
 * In cloud mode the desktop shows the platform workbench instead of the local
 * worktree shell; the local shell stays mounted only in ordinary desktop mode.
 *
 * `window.api.cloud` is absent in non-cloud builds, which keeps this a no-op
 * rather than an empty screen.
 */
export function useCloudBridge(): CloudBridge | null {
  return React.useMemo(() => {
    const api = (window as unknown as { api?: { cloud?: CloudBridge } }).api
    return api?.cloud ?? null
  }, [])
}

export function CloudModeGate({ children }: { children: React.ReactNode }): React.JSX.Element {
  const bridge = useCloudBridge()
  if (!bridge) {
    return <>{children}</>
  }
  return <CloudApp bridge={bridge} />
}
