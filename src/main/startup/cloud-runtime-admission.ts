import {
  cloudAgentConfigFromEnv,
  createCloudAgentClient,
  type CloudAgentClient
} from '../cloud-platform/cloud-agent-client'
import type { DeviceRegistry } from '../runtime/device-registry'
import type { UpgradeAdmission } from '../runtime/rpc/ws-transport'

export type CloudRuntimeTarget = {
  closeCloudDeviceSessions: (tokens: readonly string[]) => number
  getDeviceRegistry: () => DeviceRegistry | null
}

export type CloudRuntimeAdmission = {
  admission: UpgradeAdmission
  client: CloudAgentClient
  /** Call once the runtime exists so revocations can close live sessions. */
  bindRuntime: (runtime: CloudRuntimeTarget) => void
}

/**
 * Builds the host's cloud upgrade gate when `ORCA_CLOUD_API_URL` is set.
 * Returns null in pairing-only mode, which must keep working unchanged.
 */
export function startCloudRuntimeAdmission(
  env: NodeJS.ProcessEnv = process.env
): CloudRuntimeAdmission | null {
  const config = cloudAgentConfigFromEnv(env)
  if (!config) {
    return null
  }
  const client = createCloudAgentClient(config)
  client.start()
  let registry: DeviceRegistry | null = null
  return {
    admission: (headers) => {
      const decision = client.admit(headers)
      // The ticket already names the device; without this the E2EE handshake would
      // reject a token the registry has never seen (design §6.6 step 2).
      if (decision.ok) {
        registry?.adoptCloudDevice({
          deviceId: decision.payload.deviceId,
          token: decision.payload.deviceToken,
          name: decision.payload.sub
        })
      }
      return decision
    },
    client,
    bindRuntime: (runtime) => {
      registry = runtime.getDeviceRegistry()
      client.onRevoke((tokens) => {
        runtime.closeCloudDeviceSessions(tokens)
      })
    }
  }
}

// Why: the RPC server reads its options synchronously and the gate needs the server
// itself, so the admission is memoised until the server exists to be bound.
let pending: CloudRuntimeAdmission | null | undefined

export function cloudRuntimeAdmission(
  env: NodeJS.ProcessEnv = process.env
): CloudRuntimeAdmission | null {
  if (pending === undefined) {
    pending = startCloudRuntimeAdmission(env)
  }
  return pending
}

export function cloudAdmissionOption(env: NodeJS.ProcessEnv = process.env): {
  upgradeAdmission?: UpgradeAdmission
} {
  const runtime = cloudRuntimeAdmission(env)
  return runtime ? { upgradeAdmission: runtime.admission } : {}
}
