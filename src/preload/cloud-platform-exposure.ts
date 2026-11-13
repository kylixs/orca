import type { CloudPlatformApi } from './api/cloud-platform-api'
import { cloudPlatformApi } from './api/cloud-platform-bridge'
import { isCloudPlatformBuild } from '../shared/cloud-build-flags'

/**
 * Why: main registers the cloud:* handlers only for cloud builds
 * (installCloudPlatformIpc), so exposing the bridge unconditionally made an
 * ordinary desktop build think it was a cloud build and every call reject. Both
 * processes share this predicate: the runtime env address, or a build-injected
 * default platform address, or the managed-build switch (M119/W10).
 */
export function cloudPlatformExposure(env: NodeJS.ProcessEnv): { cloud?: CloudPlatformApi } {
  return isCloudPlatformBuild(env) ? { cloud: cloudPlatformApi } : {}
}
