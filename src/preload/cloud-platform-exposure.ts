import type { CloudPlatformApi } from './api/cloud-platform-api'
import { cloudPlatformApi } from './api/cloud-platform-bridge'

/**
 * Why: main registers the cloud:* handlers only when ORCA_CLOUD_API_URL is set
 * (installCloudPlatformIpc), so exposing the bridge unconditionally made an
 * ordinary desktop build think it was a cloud build and every call reject.
 * Both processes inherit the same environment, so this predicate is the same one.
 */
export function cloudPlatformExposure(env: NodeJS.ProcessEnv): { cloud?: CloudPlatformApi } {
  return env.ORCA_CLOUD_API_URL ? { cloud: cloudPlatformApi } : {}
}
