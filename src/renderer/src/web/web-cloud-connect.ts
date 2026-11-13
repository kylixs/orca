import { readString } from '../../../shared/json-fields'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { translate } from '@/i18n/i18n'
import {
  cloudPairingOfferFromTicket,
  listCloudProjects,
  loginToCloud,
  requestCloudTicket,
  WebCloudSessionError,
  type WebCloudProject
} from './web-cloud-session'
import {
  loadOrCreateWebCloudDeviceKey,
  type WebCloudDeviceKeyStorage
} from './web-cloud-device-key'
import type { WebPairingOffer } from './web-pairing'
import { WebRuntimeClient } from './web-runtime-client'

/**
 * The browser's cloud entry: login, pick a visible project, redeem a ticket, and
 * prove the resulting offer reaches the runtime before the UI mounts the App.
 * The ticket is single-use, so validation consumes it; callers must not reuse the
 * returned offer for a second upgrade.
 */

export const WEB_CLOUD_CONNECT_ERROR_CODE = {
  connectFailed: 'CONNECT_FAILED',
  mobileScopeRejected: 'MOBILE_SCOPE_REJECTED',
  noProjects: 'NO_PROJECTS'
} as const

export class WebCloudConnectError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'WebCloudConnectError'
    this.code = code
  }
}

/** The slice of WebRuntimeClient this flow needs, so tests can drive a real transport. */
export type WebCloudConnectClient = {
  call(
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number }
  ): Promise<RuntimeRpcResponse<unknown>>
  close(): void
}

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
}

export type WebCloudProjectConnection = {
  offer: WebPairingOffer
  environmentName: string
  runtimeId: string
  projectName: string
  /** Hand to the transport; never persisted and never placed on the offer. */
  deviceSecretKeyB64: string
}

const STATUS_TIMEOUT_MS = 15_000

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
): WebCloudProjectConnection {
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
  const projects = await listCloudProjects(session, fetchOptions)
  const project = selectProject(projects, input.projectId)
  const ticket = await requestCloudTicket(session, project.id, identity.publicKeyB64, fetchOptions)
  const offer = cloudPairingOfferFromTicket(
    ticket,
    identity.publicKeyB64,
    input.endpointUrl ? { endpointUrl: input.endpointUrl } : {}
  )
  // The key storage seam holds only the device blob, so there is no cached
  // project/display name to refresh here.
  let client: WebCloudConnectClient | null = null
  try {
    client = (input.clientFactory ?? createValidationClient)(offer, identity.secretKeyB64)
    const reply = await client.call('status.get', undefined, {
      timeoutMs: STATUS_TIMEOUT_MS
    })
    return connectionFromStatus(reply, offer, project, identity.secretKeyB64)
  } catch (error) {
    throw mapConnectError(error)
  } finally {
    client?.close()
  }
}
