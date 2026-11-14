import type { CloudPlatformApi } from './api/cloud-platform-api'
import { cloudPlatformApi } from './api/cloud-platform-bridge'

/**
 * Every build exposes the bridge (W11): the native shell keeps a permanent
 * sign-in button, and main registers the same `cloud:*` channels in all of them
 * (installCloudPlatformIpc), answering `PLATFORM_ADDRESS_REQUIRED` when no
 * platform address exists.
 */
export function cloudPlatformExposure(): { cloud: CloudPlatformApi } {
  return { cloud: cloudPlatformApi }
}
