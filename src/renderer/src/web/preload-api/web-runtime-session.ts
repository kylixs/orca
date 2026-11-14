import {
  runtimeHostStatusFailure,
  type RuntimeHostStatusSnapshot,
  type RuntimeHostStatusResponse
} from '../../../../shared/runtime-host-status'
import type { ZcodePlanSite } from '../../../../shared/zcode-plan-sites'
import type { WorktreeVisibilityDefaults } from '../../../../shared/global-settings-types'
import { RuntimeRpcCallQueuePool } from '../../../../shared/runtime-rpc-call-queue'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import type { Worktree } from '../../../../shared/worktree/types'
import type { WebRuntimeSessionClient } from '../web-runtime-session-client'
import { WebRuntimeClient } from '../web-runtime-client'
import {
  clearStoredWebRuntimeEnvironment,
  getPreferredWebPairingOffer,
  isCloudSessionWebEnvironment,
  readStoredWebRuntimeEnvironment,
  updateStoredEnvironmentRuntimeId
} from '../web-runtime-environment'
import type { StoredWebRuntimeEnvironment } from '../web-runtime-environment'
import { translate } from '@/i18n/i18n'

export const webRuntimeState: {
  activeEnvironment: StoredWebRuntimeEnvironment | null
  zcodePlanSiteRuntimeOwner: string | null
  zcodePlanSiteRuntimeValue: ZcodePlanSite | null
  worktreeVisibilityDefaultsRuntimeEnvironmentId: string | null
  worktreeVisibilityDefaultsRuntimeValue: WorktreeVisibilityDefaults | null
  activeClient: WebRuntimeSessionClient | null
  activeClientEnvironmentId: string | null
  cachedWorktrees: { loadedAt: number; worktrees: Worktree[] } | null
  cachedDetectedWorktrees: { loadedAt: number; worktrees: Worktree[] } | null
} = {
  activeEnvironment: readStoredWebRuntimeEnvironment(),
  zcodePlanSiteRuntimeOwner: null,
  zcodePlanSiteRuntimeValue: null,
  worktreeVisibilityDefaultsRuntimeEnvironmentId: null,
  worktreeVisibilityDefaultsRuntimeValue: null,
  activeClient: null,
  activeClientEnvironmentId: null,
  cachedWorktrees: null,
  cachedDetectedWorktrees: null
}

const statusListeners = new Set<(snapshot: RuntimeHostStatusSnapshot) => void>()
export function subscribeWebRuntimeStatus(
  callback: (snapshot: RuntimeHostStatusSnapshot) => void
): () => void {
  statusListeners.add(callback)
  return () => {
    statusListeners.delete(callback)
  }
}
function publishRuntimeStatus(snapshot: RuntimeHostStatusSnapshot): void {
  for (const listener of statusListeners) {
    listener(snapshot)
  }
}

const cloudSessionEndedListeners = new Set<() => void>()
const endedCloudClients = new WeakSet<WebRuntimeSessionClient>()

/**
 * Fires once per adopted cloud client that reaches a terminal disconnect. A cloud
 * ticket cannot reconnect, so this is the only in-page "sign in again" signal.
 */
export function subscribeCloudSessionEnded(listener: () => void): () => void {
  cloudSessionEndedListeners.add(listener)
  return () => {
    cloudSessionEndedListeners.delete(listener)
  }
}

function publishAdoptedClientStatus(
  client: WebRuntimeSessionClient,
  environment: StoredWebRuntimeEnvironment
): (snapshot: RuntimeHostStatusSnapshot) => void {
  return (snapshot) => {
    publishRuntimeStatus(snapshot)
    if (
      !isCloudSessionWebEnvironment(environment) ||
      webRuntimeState.activeClient !== client ||
      snapshot.transport !== 'disconnected' ||
      (client.connectionState !== 'disconnected' && client.connectionState !== 'auth-failed') ||
      endedCloudClients.has(client)
    ) {
      return
    }
    // Why mark before notifying: a listener closes the client, whose dispose
    // publishes another disconnected snapshot for the same ended session.
    endedCloudClients.add(client)
    for (const listener of Array.from(cloudSessionEndedListeners)) {
      listener()
    }
  }
}
export function readWebRuntimeStatusSnapshots(): RuntimeHostStatusSnapshot[] {
  const snapshot = webRuntimeState.activeClient?.statusOwner?.read()
  return snapshot ? [snapshot] : []
}
export async function observeWebRuntimeStatus(
  selector: string,
  timeoutMs?: number
): Promise<RuntimeHostStatusResponse> {
  const environment = resolveEnvironment(selector)
  if (manuallyDisconnectedEnvironmentIds.has(environment.id)) {
    return manuallyDisconnectedResponse(environment)
  }
  if (isCloudSessionEnded(environment)) {
    // Why: the ticket was spent by the login probe. Dialing the stored offer again
    // would only hang; answer with the truth the status plumbing would publish.
    return runtimeHostStatusFailure('runtime_unavailable', cloudSessionEndedError().message)
  }
  const existing = webRuntimeState.activeClient?.statusOwner
  if (existing) {
    return existing.refresh({ timeoutMs, observeOnly: true })
  }
  const transient = new WebRuntimeClient(getPreferredWebPairingOffer(environment), {
    reconnect: false
  })
  try {
    return (await transient.call('status.get', undefined, {
      timeoutMs
    })) as RuntimeHostStatusResponse
  } finally {
    transient.close()
  }
}

export const manuallyDisconnectedEnvironmentIds = new Set<string>()

export const runtimeCallQueuePool = new RuntimeRpcCallQueuePool()

export function invalidateRuntimeWorktreeCaches(): void {
  webRuntimeState.cachedWorktrees = null
  webRuntimeState.cachedDetectedWorktrees = null
}

/**
 * Install the already-validated client as this environment's owner. A cloud ticket
 * is single-use, so the login probe's live socket is the only one that can work.
 */
export function adoptWebRuntimeClient(
  client: WebRuntimeSessionClient,
  environment: StoredWebRuntimeEnvironment
): void {
  const previous = webRuntimeState.activeClient
  webRuntimeState.activeClient = client
  webRuntimeState.activeClientEnvironmentId = environment.id
  webRuntimeState.activeEnvironment = environment
  invalidateRuntimeWorktreeCaches()
  client.attachStatusOwner({
    environmentId: environment.id,
    pairingRevision: environment.pairingRevision ?? environment.createdAt,
    publish: publishAdoptedClientStatus(client, environment),
    verified: (response) => updateEnvironmentFromResponse(environment, response)
  })
  // Why: ownership moved, so an older client's socket must not linger unread.
  if (previous && previous !== client) {
    previous.close()
  }
}

function isCloudSessionEnded(environment: StoredWebRuntimeEnvironment): boolean {
  if (!isCloudSessionWebEnvironment(environment)) {
    return false
  }
  const active =
    webRuntimeState.activeClientEnvironmentId === environment.id
      ? webRuntimeState.activeClient
      : null
  if (!active) {
    return true
  }
  return active.connectionState === 'disconnected' || active.connectionState === 'auth-failed'
}

function cloudSessionEndedError(): Error {
  return new Error(
    translate(
      'auto.web.webPreloadApi.runtimeCloudSessionEnded',
      'Your cloud session ended. Sign in again to reconnect.'
    )
  )
}

export function getClientForEnvironment(
  environment: StoredWebRuntimeEnvironment
): WebRuntimeSessionClient {
  if (manuallyDisconnectedEnvironmentIds.has(environment.id)) {
    throw new Error('runtime_manually_disconnected')
  }
  if (isCloudSessionEnded(environment)) {
    // Why: never construct a second client for a spent cloud ticket — it cannot
    // upgrade, so report the ended session instead of a silent reconnect loop.
    throw cloudSessionEndedError()
  }
  if (
    !webRuntimeState.activeClient ||
    webRuntimeState.activeClientEnvironmentId !== environment.id
  ) {
    webRuntimeState.activeClient?.close()
    webRuntimeState.activeClient = new WebRuntimeClient(getPreferredWebPairingOffer(environment), {
      status: {
        environmentId: environment.id,
        pairingRevision: environment.pairingRevision ?? environment.createdAt,
        publish: publishRuntimeStatus,
        verified: (response) => updateEnvironmentFromResponse(environment, response)
      }
    })
    webRuntimeState.activeClientEnvironmentId = environment.id
  }
  return webRuntimeState.activeClient
}

export function closeActiveRuntimeClients(): void {
  webRuntimeState.activeClient?.close()
  webRuntimeState.activeClient = null
  webRuntimeState.activeClientEnvironmentId = null
  invalidateRuntimeWorktreeCaches()
}

export function disconnectActiveRuntimeEnvironment(): void {
  closeActiveRuntimeClients()
}

export function removeActiveRuntimeEnvironment(): void {
  disconnectActiveRuntimeEnvironment()
  clearStoredWebRuntimeEnvironment()
  webRuntimeState.activeEnvironment = null
}

export function manuallyDisconnectedResponse(
  environment: StoredWebRuntimeEnvironment
): RuntimeRpcResponse<never> {
  return {
    id: 'runtime.manualDisconnect',
    ok: false,
    error: {
      code: 'runtime_manually_disconnected',
      message: translate(
        'auto.web.webPreloadApi.runtimeEnvironmentManuallyDisconnected',
        'Runtime environment is manually disconnected.'
      )
    },
    _meta: { runtimeId: environment.runtimeId }
  }
}

export function resolveEnvironment(selector: string): StoredWebRuntimeEnvironment {
  const environment = requireActiveEnvironment()
  if (selector === environment.id || selector === environment.name || selector === 'active') {
    return environment
  }
  if (environment.compatibleEnvironmentIds?.includes(selector)) {
    return environment
  }
  throw new Error(`Unknown Orca runtime environment: ${selector}`)
}

export function requireActiveEnvironment(): StoredWebRuntimeEnvironment {
  webRuntimeState.activeEnvironment =
    webRuntimeState.activeEnvironment ?? readStoredWebRuntimeEnvironment()
  if (!webRuntimeState.activeEnvironment) {
    throw new Error('Pair this web client with an Orca server first.')
  }
  return webRuntimeState.activeEnvironment
}

export function requireActiveEnvironmentOrNull(): StoredWebRuntimeEnvironment | null {
  webRuntimeState.activeEnvironment =
    webRuntimeState.activeEnvironment ?? readStoredWebRuntimeEnvironment()
  return webRuntimeState.activeEnvironment
}

export function assertActiveEnvironment(environmentId: string): void {
  if (requireActiveEnvironment().id !== environmentId) {
    throw new Error('The paired Orca server changed while the request was in progress.')
  }
}

export function updateEnvironmentFromResponse(
  environment: StoredWebRuntimeEnvironment,
  response: RuntimeRpcResponse<unknown>
): void {
  if (webRuntimeState.activeEnvironment?.id !== environment.id) {
    return
  }
  const runtimeId = response.ok ? response._meta.runtimeId : (response._meta?.runtimeId ?? null)
  const pairedDeviceId =
    response.ok &&
    typeof response.result === 'object' &&
    response.result !== null &&
    typeof (response.result as { pairedDeviceId?: unknown }).pairedDeviceId === 'string'
      ? (response.result as { pairedDeviceId: string }).pairedDeviceId
      : undefined
  webRuntimeState.activeEnvironment = updateStoredEnvironmentRuntimeId(
    environment,
    runtimeId,
    pairedDeviceId
  )
}
