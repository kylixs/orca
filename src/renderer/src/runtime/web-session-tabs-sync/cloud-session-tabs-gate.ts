import { isCloudSessionRuntimeEnvironment } from '../../../../shared/runtime-environments'
import { shouldMirrorCloudSessionTabs } from '../../web/web-cloud-session-capabilities'
import { useAppStore } from '../../store'

export type CloudSessionTabsGate = {
  isCloudSession: boolean
  /** False when a cloud host has not advertised the restore capability (U96). */
  subscribable: boolean
}

export function resolveCloudSessionTabsGate(environmentId: string): CloudSessionTabsGate {
  const environment = useAppStore
    .getState()
    .runtimeEnvironments.find(({ id }) => id === environmentId)
  const isCloudSession = environment !== undefined && isCloudSessionRuntimeEnvironment(environment)
  return {
    isCloudSession,
    subscribable: !isCloudSession || shouldMirrorCloudSessionTabs(environmentId)
  }
}
