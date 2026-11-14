import { createCloudAgentClient, type CloudAgentClient } from '../cloud-platform/cloud-agent-client'
import type { CloudAgentConfig } from '../cloud-platform/cloud-agent-config'
import { cloudAgentConfigFromEnv } from '../cloud-platform/cloud-agent-env'
import {
  enrollCloudHost,
  readStoredHostCredential,
  storeHostCredential,
  type CloudHostCredential
} from '../cloud-platform/cloud-host-enrollment'
import { resolveCloudHostTls } from '../cloud-platform/cloud-host-tls'
import { listProjectDirs } from '../cloud-platform/cloud-project-dirs'
import { installCloudPlatformIpc } from '../ipc/cloud-platform'
import { createCloudAccessGuard } from '../cloud-platform/cloud-access-guard'
import { ALL_RPC_METHODS } from '../runtime/rpc/methods'
import { MANAGED_WORKTREE_METHODS } from '../runtime/rpc/methods/worktree-create-managed'
import { PROJECT_PROVISION_METHODS } from '../runtime/rpc/methods/project-provision'
import type { RpcAnyMethodDeclaration } from '../runtime/rpc/core'
import type { DeviceRegistry } from '../runtime/device-registry'
import type { UpgradeAdmission, WebSocketConnectionGate } from '../runtime/rpc/ws-transport'
import type {
  CloudUpgradeDecision,
  CloudUpgradeHeaders
} from '../cloud-platform/cloud-upgrade-admission'
import type { CloudProvisionReporter } from '../cloud-platform/cloud-project-provision'
import type { CloudHostAuditSink } from '../cloud-platform/cloud-host-audit'

export type CloudRuntimeTarget = {
  closeCloudDeviceSessions: (tokens: readonly string[]) => number
  /** Installs the policy/read-budget guard; optional so tests can drive a bare runtime. */
  setCloudAccessGuard?: (guard: ReturnType<typeof createCloudAccessGuard> | null) => void
  /** Installs the heartbeat reporter; optional for the same reason. */
  setCloudProvisionReporter?: (reporter: CloudProvisionReporter | null) => void
  /** Installs the refusal sink; optional for the same reason. */
  setCloudHostAudit?: (sink: CloudHostAuditSink | null) => void
  getDeviceRegistry: () => DeviceRegistry | null
  getWebSocketEndpoint: () => string | null
  getE2EEPublicKey: () => string | null
}

export type CloudRuntimeAdmission = {
  admission: UpgradeAdmission
  /** Cloud session cap, applied to sockets after the upgrade is accepted. */
  connectionGate: WebSocketConnectionGate
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
        name: decision.payload.sub,
        publicKeyB64: decision.payload.devicePubKey,
        // The ticket's permission set and roots are what the host enforces per RPC.
        project: decision.payload.project,
        permissions: decision.payload.perms,
        projectRoot: decision.payload.projectRoot,
        workspaceRoot: decision.payload.workspaceRoot,
        repoUrl: decision.payload.repoUrl,
        defaultBranch: decision.payload.defaultBranch
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
  /** Extra addresses to advertise (e.g. a fabric IP) in addition to the bound port. */
  directAddrs?: string[]
  relayTarget?: string
}

/**
 * Turns the runtime's bound endpoint into the address a client can dial.
 *
 * A loopback bind is not reachable from another machine, so reporting it would
 * be a lie the client only discovers at connect time. Without an advertised
 * host we report nothing and let the platform use the relay.
 */
export function advertisedAddrs(
  endpoint: string | null,
  advertiseHost: string | undefined,
  extras: string[] = []
): string[] {
  const addrs = [...extras]
  if (!endpoint) {
    return addrs
  }
  let parsed: URL
  try {
    parsed = new URL(endpoint)
  } catch {
    return addrs
  }
  const boundHost = parsed.hostname.replace(/^\[|\]$/g, '')
  const isLoopback = boundHost === '127.0.0.1' || boundHost === '::1' || boundHost === 'localhost'
  const host = advertiseHost ?? (isLoopback ? null : boundHost)
  if (host) {
    addrs.push(`${host}:${parsed.port}`)
  }
  return addrs
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
  // Only an explicit host token means "serve as a host": `ORCA_CLOUD_API_URL`
  // alone is the client's prefilled platform address (W10), and demanding host
  // identity for it refused to start plain clients.
  if (!env.ORCA_CLOUD_INTERNAL_TOKEN) {
    return null
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
    // Absent means this host does not offer developer self-service projects.
    const projectsRoot = env.ORCA_CLOUD_PROJECTS_ROOT?.trim() || undefined
    // The same certificate the runtime listens with, announced to the platform so
    // clients can check the `wss://` address they are handed.
    const hostTls = resolveCloudHostTls(env)
    let stored = userDataPath ? readStoredHostCredential(userDataPath) : null
    if (!stored) {
      const enrolled = await enrollCloudHost({
        apiUrl,
        hostToken,
        hostName,
        // Nothing is listening yet; the heartbeat reports the real port later.
        directAddrs: options.directAddrs ?? [],
        relayTarget: options.relayTarget,
        ...(hostTls ? { tlsFingerprint: hostTls.fingerprint } : {}),
        ...(projectsRoot ? { projectsRoot } : {})
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
        ...(projectsRoot ? { projectsRoot, projectDirs: () => listProjectDirs(projectsRoot) } : {}),
        // Clients derive the E2EE key from this, so it must come from the runtime
        // that will actually answer — the enrolment call ran before it existed.
        e2eePublicKeyB64: () => boundRuntime?.getE2EEPublicKey() ?? null,
        tlsFingerprint: () => hostTls?.fingerprint ?? null,
        directAddrs: () =>
          advertisedAddrs(
            boundRuntime?.getWebSocketEndpoint() ?? null,
            env.ORCA_CLOUD_ADVERTISE_HOST,
            options.directAddrs
          )
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

  // Delegates rather than snapshots: the client is created after enrolment, and
  // the transport is constructed before that promise settles.
  const connectionGate: WebSocketConnectionGate = {
    accept: (headers) => client?.connectionGate.accept(headers) ?? false,
    release: (headers) => client?.connectionGate.release(headers)
  }

  return {
    admission: (headers) => admission(headers),
    connectionGate,
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
    connectionGate: client.connectionGate,
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

/**
 * Post-start wiring: revocation → live sockets, and the renderer IPC surface.
 * One call so the runtime launch path stays a single line.
 */
export function installCloudAccessGuard(
  runtime: Pick<CloudRuntimeTarget, 'setCloudAccessGuard'>,
  client: Pick<CloudAgentClient, 'snapshot'>
): void {
  // Why resolve per call: a policy change must reach existing sessions, and the
  // snapshot is refreshed on the heartbeat timer.
  runtime.setCloudAccessGuard?.(
    createCloudAccessGuard(() => ({ policies: client.snapshot().policies }))
  )
}

export function attachCloudRuntime(runtime: CloudRuntimeTarget): void {
  const admission = cloudRuntimeAdmission()
  admission?.bindRuntime(runtime)
  if (admission?.client) {
    installCloudAccessGuard(runtime, admission.client)
    const client = admission.client
    runtime.setCloudProvisionReporter?.((report) => client.reportProvisioned(report))
    runtime.setCloudHostAudit?.((event) => client.reportAudit(event))
  }
  installCloudPlatformIpc()
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
): {
  upgradeAdmission?: UpgradeAdmission
  connectionGate?: WebSocketConnectionGate
  methods?: readonly RpcAnyMethodDeclaration[]
  /** The platform advertises this host's direct address as `wss://` (design §5.3). */
  webSocketTls?: { cert: string; key: string }
} {
  const runtime = cloudRuntimeAdmission(env, options)
  const tls = resolveCloudHostTls(env)
  const webSocketTls = tls ? { webSocketTls: { cert: tls.cert, key: tls.key } } : {}
  if (!runtime) {
    return webSocketTls
  }
  // Design §8.3: managed creation exists only in cloud builds, so the method
  // table is extended here rather than in ALL_RPC_METHODS.
  const methods = [...ALL_RPC_METHODS, ...MANAGED_WORKTREE_METHODS, ...PROJECT_PROVISION_METHODS]
  return {
    ...webSocketTls,
    upgradeAdmission: runtime.admission,
    connectionGate: runtime.connectionGate,
    methods
  }
}
