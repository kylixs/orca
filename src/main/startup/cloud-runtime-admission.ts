import {
  cloudAgentConfigFromEnv,
  createCloudAgentClient,
  type CloudAgentClient
} from '../cloud-platform/cloud-agent-client'
import type { UpgradeAdmission } from '../runtime/rpc/ws-transport'

export type CloudRuntimeAdmission = {
  admission: UpgradeAdmission
  client: CloudAgentClient
}

/**
 * Builds the host's cloud upgrade gate when `ORCA_CLOUD_API_URL` is set.
 * Returns null in pairing-only mode, which must keep working unchanged.
 */
export function cloudAdmissionOption(env: NodeJS.ProcessEnv = process.env): {
  upgradeAdmission?: UpgradeAdmission
} {
  const runtime = startCloudRuntimeAdmission(env)
  return runtime ? { upgradeAdmission: runtime.admission } : {}
}

export function startCloudRuntimeAdmission(
  env: NodeJS.ProcessEnv = process.env
): CloudRuntimeAdmission | null {
  const config = cloudAgentConfigFromEnv(env)
  if (!config) {
    return null
  }
  const client = createCloudAgentClient(config)
  client.start()
  return { admission: (headers) => client.admit(headers), client }
}
