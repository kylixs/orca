import { randomUUID } from 'node:crypto'
import type { PairingOffer } from '../../shared/pairing'
import { PAIRING_OFFER_VERSION } from '../../shared/pairing'
import {
  readEnvironmentStore,
  readPersistedEnvironmentStore,
  writeEnvironmentStore
} from '../../shared/runtime-environment-store-file'
import { writeRuntimeEnvironmentSidecarEntry } from '../../shared/runtime-environment-sidecar'
import {
  cloudWorkspacePathOf,
  createEnvironmentFromPairingOffer,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import {
  sendRemoteRuntimeRequest,
  subscribeRemoteRuntimeRequest,
  type RemoteRuntimeSubscription
} from '../../shared/remote-runtime-client'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import type { RuntimeCapability } from '../../shared/protocol-version'
import type { CloudUpgradeOption } from '../../shared/remote-runtime-subscription-contract'
import type { CloudProjectLink } from './cloud-pairing-offer'
import type { CloudProjectLinkResult } from './cloud-session-service'
import { activeCloudSession } from './cloud-runtime-session'

/**
 * A cloud project as an ordinary Orca runtime environment.
 *
 * Panes address environments by id, so registering the project lets the
 * existing terminal/file paths reach it unchanged. The catch is the pairing:
 * each cloud ticket is single-use, so the persisted endpoint is a placeholder
 * and every connection re-issues a link through the platform.
 */

export type CloudRuntimeLink = {
  offer: PairingOffer
  cloudUpgrade: CloudUpgradeOption
  workspaceRoot: string
  /** The device key the host demands at handshake (device PoP). */
  clientKeyPair: { publicKey: Uint8Array; secretKey: Uint8Array }
}

export class CloudRuntimeLinkError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'CloudRuntimeLinkError'
    this.code = code
  }
}

function asLinkError(error: unknown): CloudRuntimeLinkError {
  if (error instanceof CloudRuntimeLinkError) {
    return error
  }
  const code = error !== null && typeof error === 'object' ? Reflect.get(error, 'code') : null
  return new CloudRuntimeLinkError(
    typeof code === 'string' ? code : 'CLOUD_LINK_FAILED',
    error instanceof Error ? error.message : String(error)
  )
}

/** Every call re-issues the ticket: the previous one was consumed at handshake. */
export async function resolveCloudRuntimeLink(
  environment: Pick<KnownRuntimeEnvironment, 'cloudProject'>
): Promise<CloudRuntimeLink> {
  const project = environment.cloudProject
  if (!project) {
    throw new CloudRuntimeLinkError('CLOUD_PROJECT_MISSING', 'Environment is not cloud-backed.')
  }
  const session = activeCloudSession()
  if (!session) {
    throw new CloudRuntimeLinkError('NOT_SIGNED_IN', 'No cloud platform session is active.')
  }
  let prepared: CloudProjectLinkResult
  try {
    prepared = await session.prepareProjectLink(project.projectId)
  } catch (error) {
    throw asLinkError(error)
  }
  if (!prepared.ok) {
    throw new CloudRuntimeLinkError(prepared.code, prepared.message ?? prepared.code)
  }
  const clientKeyPair = session.deviceKeyPair()
  if (!clientKeyPair) {
    throw new CloudRuntimeLinkError('NOT_SIGNED_IN', 'No cloud platform session is active.')
  }
  return {
    offer: { ...prepared.link.offer, v: PAIRING_OFFER_VERSION, scope: 'runtime' },
    cloudUpgrade: prepared.link.cloudUpgrade,
    workspaceRoot: prepared.link.workspaceRoot,
    clientKeyPair
  }
}

export function callCloudRuntimeProject<TResult = unknown>(
  environment: Pick<KnownRuntimeEnvironment, 'cloudProject'>,
  method: string,
  params: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
  clientCapabilities: readonly RuntimeCapability[] = []
): Promise<RuntimeRpcResponse<TResult>> {
  return resolveCloudRuntimeLink(environment).then((link) =>
    sendRemoteRuntimeRequest<TResult>(
      link.offer,
      method,
      params,
      timeoutMs,
      undefined,
      signal,
      clientCapabilities,
      link.cloudUpgrade,
      link.clientKeyPair
    )
  )
}

export type CloudRuntimeEvent =
  | { type: 'response'; response: RuntimeRpcResponse<unknown> }
  | { type: 'binary'; bytes: Uint8Array<ArrayBufferLike> }
  | { type: 'error'; code: string; message: string }
  | { type: 'close' }

/** Streaming (terminal, file watch) over the same per-connection ticket. */
export async function subscribeCloudRuntimeEnvironment(
  environment: Pick<KnownRuntimeEnvironment, 'cloudProject'>,
  method: string,
  params: unknown,
  timeoutMs: number,
  callbacks: { onEvent: (event: CloudRuntimeEvent) => void; onClose: () => void },
  signal?: AbortSignal
): Promise<RemoteRuntimeSubscription> {
  const link = await resolveCloudRuntimeLink(environment)
  return await subscribeRemoteRuntimeRequest(
    link.offer,
    method,
    params,
    timeoutMs,
    {
      onResponse: (response) => callbacks.onEvent({ type: 'response', response }),
      onBinary: (bytes) => callbacks.onEvent({ type: 'binary', bytes }),
      onError: (error) =>
        callbacks.onEvent({ type: 'error', code: error.code, message: error.message }),
      onClose: () => {
        callbacks.onEvent({ type: 'close' })
        callbacks.onClose()
      }
    },
    { cloudUpgrade: link.cloudUpgrade, signal, clientKeyPair: link.clientKeyPair }
  )
}

type RegistrationInput = {
  projectId: string
  projectKey: string
  projectName: string
  hostId: string
  /** The link prepared for the open; its endpoint keeps the environment resolvable. */
  link: CloudProjectLink
  /** The user's checkout; unknown on the first open, before it is created. */
  workspacePath?: string
}

/**
 * Creates or refreshes the environment for a project. Returns the id panes
 * should address; reopening the same project keeps that id stable.
 */
export function registerCloudRuntimeEnvironment(
  userDataPath: string,
  input: RegistrationInput,
  now = Date.now()
): KnownRuntimeEnvironment {
  const known = readEnvironmentStore(userDataPath).environments
  const existing = known.find((entry) => entry.cloudProject?.projectId === input.projectId)
  // Why: a sign-in registers environments without opening a workspace; that must
  // not erase the checkout path a previous open recorded (M45/M55 navigation).
  const workspacePath = input.workspacePath ?? (existing ? cloudWorkspacePathOf(existing) : null)
  const environment = createEnvironmentFromPairingOffer({
    id: existing?.id ?? `cloud-${randomUUID()}`,
    name: existing?.name ?? input.projectName,
    now,
    offer: { ...input.link.offer, v: PAIRING_OFFER_VERSION, scope: 'runtime' },
    runtimeId: existing?.runtimeId ?? null
  })
  const store = readPersistedEnvironmentStore(userDataPath)
  const next = {
    version: 1 as const,
    environments: [
      ...store.environments.filter((entry) => entry.id !== environment.id),
      environment
    ].sort((a, b) => a.name.localeCompare(b.name))
  }
  writeEnvironmentStore(userDataPath, next)
  writeRuntimeEnvironmentSidecarEntry(userDataPath, next.environments, environment, {
    cloudProject: {
      projectId: input.projectId,
      projectKey: input.projectKey,
      hostId: input.hostId,
      registeredAt: now,
      // Omitted while unknown, so an old sidecar shape stays byte-identical.
      ...(workspacePath ? { workspacePath } : {})
    }
  })
  return environment
}

/** Drops every cloud environment (sign-out); returns the project ids removed. */
export function removeCloudRuntimeEnvironments(userDataPath: string): string[] {
  const projectIds = readEnvironmentStore(userDataPath).environments.flatMap((entry) =>
    entry.cloudProject ? [entry.cloudProject.projectId] : []
  )
  return projectIds.filter((projectId) => removeCloudRuntimeEnvironment(userDataPath, projectId))
}

/** Drops the environment for a project; the next open registers it again. */
export function removeCloudRuntimeEnvironment(userDataPath: string, projectId: string): boolean {
  const known = readEnvironmentStore(userDataPath).environments
  const target = known.find((entry) => entry.cloudProject?.projectId === projectId)
  if (!target) {
    return false
  }
  const store = readPersistedEnvironmentStore(userDataPath)
  const remaining = store.environments.filter((entry) => entry.id !== target.id)
  writeEnvironmentStore(userDataPath, { version: 1, environments: remaining })
  writeRuntimeEnvironmentSidecarEntry(
    userDataPath,
    remaining,
    store.environments.find((entry) => entry.id === target.id) ?? target,
    null
  )
  return true
}
