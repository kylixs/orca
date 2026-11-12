import {
  cloudAgentConfigFromEnv,
  createCloudAgentClient,
  type CloudAgentClient,
  type CloudAgentConfig
} from '../cloud-platform/cloud-agent-client'
import {
  enrollCloudHost,
  readStoredHostCredential,
  storeHostCredential,
  type CloudHostCredential
} from '../cloud-platform/cloud-host-enrollment'
import type { DeviceRegistry } from '../runtime/device-registry'
import type { UpgradeAdmission } from '../runtime/rpc/ws-transport'
import type {
  CloudUpgradeDecision,
  CloudUpgradeHeaders
} from '../cloud-platform/cloud-upgrade-admission'

export type CloudRuntimeTarget = {
  closeCloudDeviceSessions: (tokens: readonly string[]) => number
  getDeviceRegistry: () => DeviceRegistry | null
}

export type CloudRuntimeAdmission = {
  admission: UpgradeAdmission
  client: CloudAgentClient | null
  /** Resolves once the host is enrolled (or immediately in poll mode). */
  ready: Promise<void>
  /** Null until enrolment completes. */
  host: () => CloudHostCredential | null
  /** Call once the runtime exists so revocations can close live sessions. */
  bindRuntime: (runtime: CloudRuntimeTarget) => void
  stop: () => void
}

const NOT_ENROLLED = 'not_enrolled'

/**
 * Registers the device the ticket names, so the E2EE handshake can resolve the
 * token the platform assigned (the registry has never seen it before).
 */
function withDeviceAdoption(
  admit: (headers: CloudUpgradeHeaders) => CloudUpgradeDecision,
  getRuntime: () => CloudRuntimeTarget | null
): (headers: CloudUpgradeHeaders) => CloudUpgradeDecision {
  return (headers) => {
    const decision = admit(headers)
    if (decision.ok) {
      getRuntime()?.getDeviceRegistry()?.adoptCloudDevice({
        deviceId: decision.payload.deviceId,
        token: decision.payload.deviceToken,
        name: decision.payload.sub
      })
    }
    return decision
  }
}

/** Rejects every upgrade: the host has no key set yet, so it cannot be sure of anything. */
function notEnrolledAdmission(): (headers: CloudUpgradeHeaders) => CloudUpgradeDecision {
  return () => ({
    ok: false,
    status: 401,
    reason: NOT_ENROLLED,
    message: '主机尚未完成云端注册。',
    headers: { 'x-orca-reject': NOT_ENROLLED }
  })
}

export type CloudAdmissionOptions = {
  /** Where the host credential is persisted between restarts. */
  userDataPath?: string
  /** Addresses advertised at registration; the heartbeat keeps reporting them. */
  directAddrs?: string[]
  relayTarget?: string
}

export function startCloudRuntimeAdmission(
  env: NodeJS.ProcessEnv = process.env,
  options: CloudAdmissionOptions = {}
): CloudRuntimeAdmission | null {
  const apiUrl = env.ORCA_CLOUD_API_URL
  if (!apiUrl) {
    return null
  }
  const hostToken = env.ORCA_CLOUD_HOST_TOKEN
  if (hostToken) {
    return startEnrolled(env, apiUrl, hostToken, options)
  }
  return startPolling(env)
}

/**
 * Registered host: enrol once (persisting the credential), then keep the
 * platform's policy and revocation view current over the heartbeat.
 */
function startEnrolled(
  env: NodeJS.ProcessEnv,
  apiUrl: string,
  hostToken: string,
  options: CloudAdmissionOptions
): CloudRuntimeAdmission {
  const hostName = env.ORCA_CLOUD_HOST_NAME
  if (!hostName) {
    throw new Error('Cloud mode is incomplete: missing ORCA_CLOUD_HOST_NAME')
  }
  let client: CloudAgentClient | null = null
  let admittedHost: CloudHostCredential | null = null
  let boundRuntime: CloudRuntimeTarget | null = null
  let admission: (headers: CloudUpgradeHeaders) => CloudUpgradeDecision = notEnrolledAdmission()

  const ready = (async () => {
    const { userDataPath } = options
    let stored = userDataPath ? readStoredHostCredential(userDataPath) : null
    if (!stored) {
      const enrolled = await enrollCloudHost({
        apiUrl,
        hostToken,
        hostName,
        directAddrs: options.directAddrs ?? [],
        relayTarget: options.relayTarget
      })
      if (!enrolled.ok) {
        // Do not fall through to "serve without a gate": an enrolled-mode host that
        // cannot enrol must fail visibly.
        throw new Error(`cloud host enrolment failed: ${enrolled.error}`)
      }
      stored = enrolled.value
      if (userDataPath) {
        storeHostCredential(userDataPath, stored)
      }
    }
    admittedHost = stored
    const config: CloudAgentConfig = {
      apiUrl,
      internalUrl: env.ORCA_CLOUD_INTERNAL_URL,
      // Unused in heartbeat mode, but the type requires it.
      internalToken: env.ORCA_CLOUD_INTERNAL_TOKEN ?? '',
      hostId: stored.hostId,
      hostName: stored.hostName,
      heartbeat: {
        hostId: stored.hostId,
        credential: stored.credential,
        directAddrs: options.directAddrs
      }
    }
    const created = createCloudAgentClient(config)
    client = created
    admission = withDeviceAdoption(
      (headers) => created.admit(headers),
      () => boundRuntime
    )
    if (boundRuntime) {
      created.onRevoke((tokens) => boundRuntime?.closeCloudDeviceSessions(tokens))
    }
    await created.refresh()
    created.start()
  })()

  return {
    admission: (headers) => admission(headers),
    get client() {
      return client
    },
    ready,
    host: () => admittedHost,
    bindRuntime: (runtime) => {
      boundRuntime = runtime
      client?.onRevoke((tokens) => runtime.closeCloudDeviceSessions(tokens))
    },
    stop: () => client?.stop()
  }
}

/** Legacy poll mode: env supplies the host identity and the internal token. */
function startPolling(env: NodeJS.ProcessEnv): CloudRuntimeAdmission {
  const config = cloudAgentConfigFromEnv(env)
  if (!config) {
    throw new Error('Cloud mode is incomplete')
  }
  const client = createCloudAgentClient(config)
  let boundRuntime: CloudRuntimeTarget | null = null
  client.start()
  return {
    admission: withDeviceAdoption(
      (headers) => client.admit(headers),
      () => boundRuntime
    ),
    client,
    ready: Promise.resolve(),
    host: () => null,
    bindRuntime: (runtime) => {
      boundRuntime = runtime
      client.onRevoke((tokens) => boundRuntime?.closeCloudDeviceSessions(tokens))
    },
    stop: () => client.stop()
  }
}

// Why: the RPC server reads its options synchronously and the gate needs the server
// itself, so the admission is memoised until the server exists to be bound.
let pending: CloudRuntimeAdmission | null | undefined

export function cloudRuntimeAdmission(
  env: NodeJS.ProcessEnv = process.env,
  options: CloudAdmissionOptions = {}
): CloudRuntimeAdmission | null {
  if (pending === undefined) {
    pending = startCloudRuntimeAdmission(env, options)
  }
  return pending
}

export function cloudAdmissionOption(
  env: NodeJS.ProcessEnv = process.env,
  options: CloudAdmissionOptions = {}
): { upgradeAdmission?: UpgradeAdmission } {
  const runtime = cloudRuntimeAdmission(env, options)
  return runtime ? { upgradeAdmission: runtime.admission } : {}
}
