import { readString } from '../../../shared/json-fields'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { translate } from '@/i18n/i18n'
import {
  cloudPairingOfferFromTicket,
  listCloudProjects,
  loginToCloud,
  requestCloudTicket,
  WebCloudSessionError,
  type WebCloudProject,
  type WebCloudSession
} from './web-cloud-session'
import { requestCloudPairingOffer } from './web-cloud-connection-offer'
import {
  loadOrCreateWebCloudDeviceKey,
  type WebCloudDeviceKeyStorage
} from './web-cloud-device-key'
import type { WebPairingOffer } from './web-pairing'
import { WebRuntimeClient } from './web-runtime-client'
import type { WebRuntimeSessionClient } from './web-runtime-session-client'
import {
  createStoredWebRuntimeEnvironment,
  type StoredWebRuntimeEnvironment
} from './web-runtime-environment'

/**
 * The browser's cloud entry: login, pick a visible project, redeem a ticket, and
 * prove the resulting offer reaches the runtime before the UI mounts the App.
 * The ticket is single-use, so validation consumes it; the validated client is
 * returned open for the App to adopt, never rebuilt from the stored offer.
 */

export const WEB_CLOUD_CONNECT_ERROR_CODE = {
  connectFailed: 'CONNECT_FAILED',
  mobileScopeRejected: 'MOBILE_SCOPE_REJECTED',
  noProjects: 'NO_PROJECTS'
} as const

/** The stored environment name marks a cloud session with this suffix (see `toCloudEnvironment`). */
export const CLOUD_SESSION_ENVIRONMENT_NAME_SUFFIX = ' (cloud session)'

/** The sidebar repo row shows the platform project name, not the session marker. */
export function cloudSessionProjectDisplayName(environmentName: string): string {
  return environmentName.endsWith(CLOUD_SESSION_ENVIRONMENT_NAME_SUFFIX)
    ? environmentName.slice(0, -CLOUD_SESSION_ENVIRONMENT_NAME_SUFFIX.length)
    : environmentName
}

export class WebCloudConnectError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'WebCloudConnectError'
    this.code = code
  }
}

/**
 * The slice of WebRuntimeClient this flow needs: enough to probe the real transport
 * and enough for the App's session layer to adopt the same live connection.
 */
export type WebCloudConnectClient = WebRuntimeSessionClient

export type WebCloudConnectClientFactory = (
  offer: WebPairingOffer,
  deviceSecretKeyB64: string
) => WebCloudConnectClient

export type ConnectCloudProjectInput = {
  apiUrl: string
  username: string
  password: string
  deviceName: string
  deviceKeyStore: WebCloudDeviceKeyStorage
  projectId?: string
  fetchImpl?: typeof fetch
  now?: () => number
  endpointUrl?: string
  clientFactory?: WebCloudConnectClientFactory
  /** Keeps compatibility ids across a re-login of the same server. */
  previousEnvironment?: StoredWebRuntimeEnvironment | null
}

/**
 * The validated-entry tail both entrances share: a ready platform session (from
 * a password login or a handoff exchange) is turned into one project's live
 * runtime connection.
 */
export type ConnectCloudProjectWithSessionInput = {
  session: WebCloudSession
  /** The device identity the platform enrols the ticket for, and the E2EE half. */
  devicePublicKeyB64: string
  /** Half of the device identity the E2EE handshake needs; never persisted. */
  deviceSecretKeyB64: string
  projectId?: string
  fetchImpl?: typeof fetch
  endpointUrl?: string
  clientFactory?: WebCloudConnectClientFactory
  previousEnvironment?: StoredWebRuntimeEnvironment | null
}

export type WebCloudProjectConnection = {
  offer: WebPairingOffer
  environmentName: string
  runtimeId: string
  projectName: string
  /** Hand to the transport; never persisted and never placed on the offer. */
  deviceSecretKeyB64: string
  /** The live, already-upgraded client; ownership passes to the App on success. */
  client: WebCloudConnectClient
  /** Saved with `cloudLoginRequired`; a reload must still return to sign-in. */
  environment: StoredWebRuntimeEnvironment
}

const STATUS_TIMEOUT_MS = 15_000

type WebCloudValidatedConnection = Omit<WebCloudProjectConnection, 'client' | 'environment'>

function toCloudEnvironment(
  connection: WebCloudValidatedConnection,
  previousEnvironment: StoredWebRuntimeEnvironment | null
): StoredWebRuntimeEnvironment {
  return {
    ...createStoredWebRuntimeEnvironment({
      name: `${connection.environmentName}${CLOUD_SESSION_ENVIRONMENT_NAME_SUFFIX}`,
      offer: connection.offer,
      previousEnvironment
    }),
    // Why: a reload cannot reuse the spent ticket, so startup must sign in again.
    cloudLoginRequired: true,
    runtimeId: connection.runtimeId,
    lastUsedAt: Date.now()
  }
}

function createValidationClient(
  offer: WebPairingOffer,
  deviceSecretKeyB64: string
): WebCloudConnectClient {
  // Why no reconnect: a probe that keeps retrying would hide a dead ticket.
  return new WebRuntimeClient(offer, { reconnect: false, deviceSecretKeyB64 })
}

function selectProject(
  projects: WebCloudProject[],
  projectId: string | undefined
): WebCloudProject {
  if (projectId !== undefined) {
    const chosen = projects.find((project) => project.id === projectId)
    if (!chosen) {
      throw new WebCloudConnectError(
        WEB_CLOUD_CONNECT_ERROR_CODE.noProjects,
        `Project ${projectId} is not visible to this account.`
      )
    }
    return chosen
  }
  const first = projects[0]
  if (!first) {
    throw new WebCloudConnectError(
      WEB_CLOUD_CONNECT_ERROR_CODE.noProjects,
      'This account has no visible cloud projects.'
    )
  }
  return first
}

function connectionFromStatus(
  reply: RuntimeRpcResponse<unknown>,
  offer: WebPairingOffer,
  project: WebCloudProject,
  deviceSecretKeyB64: string
): WebCloudValidatedConnection {
  if (!reply.ok) {
    throw new WebCloudConnectError(
      WEB_CLOUD_CONNECT_ERROR_CODE.connectFailed,
      `status.get failed: ${reply.error.message}`
    )
  }
  // Why read the field: older runtimes may omit scope, and only a reported
  // mobile scope proves this offer is the limited one.
  if (readString(reply.result, 'deviceScope') === 'mobile') {
    throw new WebCloudConnectError(
      WEB_CLOUD_CONNECT_ERROR_CODE.mobileScopeRejected,
      translate(
        'auto.web.WebConnect.mobileScopeRejected',
        'This QR code grants limited (mobile) access. To use the full web app, open the browser access link from Settings → Runtime Environments → Share this Orca server → New Link.'
      )
    )
  }
  const runtimeId = readString(reply._meta, 'runtimeId')
  if (runtimeId === null) {
    throw new WebCloudConnectError(
      WEB_CLOUD_CONNECT_ERROR_CODE.connectFailed,
      'status.get reply did not include a runtimeId.'
    )
  }
  const projectName = project.name.trim() || project.key
  return {
    offer,
    environmentName: projectName,
    runtimeId,
    projectName,
    deviceSecretKeyB64
  }
}

function mapConnectError(error: unknown): unknown {
  if (error instanceof WebCloudSessionError || error instanceof WebCloudConnectError) {
    return error
  }
  return new WebCloudConnectError(
    WEB_CLOUD_CONNECT_ERROR_CODE.connectFailed,
    error instanceof Error ? error.message : String(error)
  )
}

export async function connectCloudProjectWithSession(
  input: ConnectCloudProjectWithSessionInput
): Promise<WebCloudProjectConnection> {
  const fetchOptions = input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}
  const { session } = input
  const projects = await listCloudProjects(session, fetchOptions)
  const project = selectProject(projects, input.projectId)
  const ticket = await requestCloudTicket(
    session,
    project.id,
    input.devicePublicKeyB64,
    fetchOptions
  )
  const offer = cloudPairingOfferFromTicket(
    ticket,
    input.devicePublicKeyB64,
    input.endpointUrl ? { endpointUrl: input.endpointUrl } : {}
  )
  // The key storage seam holds only the device blob, so there is no cached
  // project/display name to refresh here.
  let client: WebCloudConnectClient | null = null
  try {
    const validated = (input.clientFactory ?? createValidationClient)(
      offer,
      input.deviceSecretKeyB64
    )
    client = validated
    // Why here: this flow owns the session a stream's child socket signs its own
    // ticket from — the offer above is spent by this very probe (W5c).
    validated.attachTicketReSigner?.(() =>
      requestCloudPairingOffer(session, project.id, input.devicePublicKeyB64, {
        ...fetchOptions,
        ...(input.endpointUrl ? { endpointUrl: input.endpointUrl } : {}),
        // Why pinned: a stream's ticket is host-reported, and only the key this
        // connection was verified against may open its child socket (AC-29).
        expectedHostKeyB64: offer.publicKeyB64
      })
    )
    const reply = await validated.call('status.get', undefined, {
      timeoutMs: STATUS_TIMEOUT_MS
    })
    const connection = connectionFromStatus(reply, offer, project, input.deviceSecretKeyB64)
    // Why keep it open: its ticket is already spent; rebuilding from the stored
    // offer can never upgrade, so this socket is the App's only live connection.
    return {
      ...connection,
      client: validated,
      environment: toCloudEnvironment(connection, input.previousEnvironment ?? null)
    }
  } catch (error) {
    client?.close()
    throw mapConnectError(error)
  }
}

export async function connectCloudProject(
  input: ConnectCloudProjectInput
): Promise<WebCloudProjectConnection> {
  const fetchOptions = input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}
  const identity = loadOrCreateWebCloudDeviceKey(input.deviceKeyStore)
  // Platform failures keep their own codes; only local/transport failures get ours.
  const session = await loginToCloud({
    apiUrl: input.apiUrl,
    username: input.username,
    password: input.password,
    devicePublicKeyB64: identity.publicKeyB64,
    deviceName: input.deviceName,
    ...fetchOptions,
    ...(input.now ? { now: input.now } : {})
  })
  return connectCloudProjectWithSession({
    session,
    devicePublicKeyB64: identity.publicKeyB64,
    deviceSecretKeyB64: identity.secretKeyB64,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
    ...(input.endpointUrl === undefined ? {} : { endpointUrl: input.endpointUrl }),
    ...(input.clientFactory === undefined ? {} : { clientFactory: input.clientFactory }),
    ...(input.previousEnvironment === undefined
      ? {}
      : { previousEnvironment: input.previousEnvironment })
  })
}
