import { readField, readNumber, readString, readStringArray } from '../../../shared/json-fields'
import {
  parseConnectTicketReply,
  parseProjectRow,
  readProjectRows,
  readTicketClaims,
  type CloudReplyEndpoint,
  type CloudReplyProject,
  type CloudReplyTicket
} from '../../../shared/cloud-platform-reply'
import { normalizeWebPairingKey32, type WebPairingOffer } from './web-pairing'
import { authorizedRequest } from './web-cloud-authorized-request'
import { createWebCloudAuth, type WebCloudAuth, type WebCloudAuthTokens } from './web-cloud-auth'
import { WEB_CLOUD_ERROR_CODE, WebCloudSessionError } from './web-cloud-error'
import { requestJson, type RequestOptions } from './web-cloud-request'

/**
 * The browser's platform session: login, project list, ticket, and offer. Tokens
 * stay in memory — this module never persists them; the caller decides whether a
 * refresh flow or an encrypted store exists. The device secret never enters a
 * session; only the public key travels with login and ticket requests.
 */

export const WEB_CLOUD_CLIENT_VERSION = '1.5.0'

export { WEB_CLOUD_ERROR_CODE, WebCloudSessionError } from './web-cloud-error'

export type WebCloudUser = {
  id: string
  username: string
  displayName: string
  dept: string | null
  roles: string[]
  permissions: string[]
}

export type WebCloudSession = {
  apiUrl: string
  accessToken: string
  refreshToken: string
  user: WebCloudUser
  deviceId: string
  /** When the platform issued the tokens; lets the caller age the session. */
  obtainedAtMs: number
  /** Access-token lifetime the platform reported; null when it predates the field. */
  expiresIn?: number | null
  /** Absent on hand-built sessions: they keep using the static tokens as before. */
  auth?: WebCloudAuth
}

export type WebCloudProject = {
  id: string
  key: string
  name: string
  hostName: string | null
  hostStatus: string
  /** The signed permissions the platform reports for this user and project. */
  permissions: string[]
  downloadRestricted: boolean
  /** Null when the platform predates provisioning status. */
  status: string | null
  provisioningError: string | null
}

/** Revoked hosts report `offline` (U170); rows from platforms predating it stay available. */
export function isAvailableCloudProject(project: WebCloudProject): boolean {
  const status = project.hostStatus
  return project.permissions.includes('open') && (!status || status === 'online')
}

function malformed(message: string): WebCloudSessionError {
  return new WebCloudSessionError(WEB_CLOUD_ERROR_CODE.malformedReply, message)
}

function trimApiUrl(apiUrl: string): string {
  return apiUrl.replace(/\/+$/, '')
}

/** Uses the renewing auth when login built one; old hand-built sessions still work. */
function sendAuthorized(
  session: WebCloudSession,
  send: (accessToken: string) => Promise<unknown>
): Promise<unknown> {
  return session.auth ? authorizedRequest(session.auth, send) : send(session.accessToken)
}

export type WebCloudLoginInput = {
  apiUrl: string
  username: string
  password: string
  /** Standard base64, 32 bytes: the identity the platform enrols for this device. */
  devicePublicKeyB64: string
  deviceName: string
  fetchImpl?: typeof fetch
  now?: () => number
  /** Test seam: a zero lead forces the 401 recovery path with a short platform TTL. */
  refreshLeadMs?: number
  /** Rotation hook: the bridge writes the newest tokens back to storage. */
  onTokensChanged?: (tokens: WebCloudAuthTokens) => void
}

/** The parts of an enrolment reply the session build needs; login and handoff share it. */
type WebCloudAuthReplyOptions = {
  apiUrl: string
  fetchImpl?: typeof fetch
  now?: () => number
  refreshLeadMs?: number
  onTokensChanged?: (tokens: WebCloudAuthTokens) => void
}

/** Both the login and the handoff exchange return this exact enrolment shape. */
function webCloudSessionFromAuthReply(
  body: unknown,
  options: WebCloudAuthReplyOptions
): WebCloudSession {
  const accessToken = readString(body, 'accessToken')
  const refreshToken = readString(body, 'refreshToken')
  const user = readField(body, 'user')
  const userId = readString(user, 'id')
  const username = readString(user, 'username')
  const displayName = readString(user, 'displayName')
  const deviceId = readString(readField(body, 'device'), 'id')
  if (
    accessToken === null ||
    refreshToken === null ||
    userId === null ||
    username === null ||
    displayName === null ||
    deviceId === null
  ) {
    throw malformed('auth reply did not match the platform contract')
  }
  const expiresIn = readNumber(body, 'expiresIn')
  const auth = createWebCloudAuth({
    apiUrl: options.apiUrl,
    accessToken,
    refreshToken,
    ...(expiresIn === null ? {} : { expiresIn }),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.refreshLeadMs === undefined ? {} : { refreshLeadMs: options.refreshLeadMs }),
    ...(options.onTokensChanged ? { onTokensChanged: options.onTokensChanged } : {})
  })
  return {
    apiUrl: options.apiUrl,
    accessToken,
    refreshToken,
    user: {
      id: userId,
      username,
      displayName,
      dept: readString(user, 'dept'),
      roles: readStringArray(user, 'roles') ?? [],
      permissions: readStringArray(user, 'permissions') ?? []
    },
    deviceId,
    obtainedAtMs: (options.now ?? Date.now)(),
    expiresIn,
    auth
  }
}

export async function loginToCloud(input: WebCloudLoginInput): Promise<WebCloudSession> {
  const apiUrl = trimApiUrl(input.apiUrl)
  const body = await requestJson({
    url: `${apiUrl}/v1/auth/login`,
    method: 'POST',
    fetchImpl: input.fetchImpl,
    body: {
      username: input.username,
      password: input.password,
      devicePubKey: input.devicePublicKeyB64,
      deviceName: input.deviceName
    }
  })
  return webCloudSessionFromAuthReply(body, {
    apiUrl,
    fetchImpl: input.fetchImpl,
    now: input.now,
    refreshLeadMs: input.refreshLeadMs,
    onTokensChanged: input.onTokensChanged
  })
}

export type WebCloudHandoffInput = {
  apiUrl: string
  /** The one-time code from the entry URL's hash (FR-3.10); spent on success. */
  code: string
  /** Standard base64, 32 bytes: the device the platform enrols or reuses. */
  devicePublicKeyB64: string
  deviceName: string
  /** An earlier enrolment of this browser, so the device list stays one row. */
  deviceId?: string
  fetchImpl?: typeof fetch
  now?: () => number
  refreshLeadMs?: number
  onTokensChanged?: (tokens: WebCloudAuthTokens) => void
}

/**
 * Trades the one-time handoff code for a real session — the same shape a
 * password login returns, so the browser enters with exactly the access a
 * desktop client would have. Expired/spent codes come back 410 HANDOFF_GONE,
 * a lost grant 403 PROJECT_FORBIDDEN, an unreachable platform `network_error`.
 */
export async function redeemWebHandoff(input: WebCloudHandoffInput): Promise<WebCloudSession> {
  const apiUrl = trimApiUrl(input.apiUrl)
  const body = await requestJson({
    url: `${apiUrl}/v1/web/handoff`,
    method: 'POST',
    fetchImpl: input.fetchImpl,
    body: {
      code: input.code,
      devicePubKey: input.devicePublicKeyB64,
      deviceName: input.deviceName,
      ...(input.deviceId ? { deviceId: input.deviceId } : {})
    }
  })
  return webCloudSessionFromAuthReply(body, {
    apiUrl,
    fetchImpl: input.fetchImpl,
    now: input.now,
    refreshLeadMs: input.refreshLeadMs,
    onTokensChanged: input.onTokensChanged
  })
}

function toWebProject(project: CloudReplyProject): WebCloudProject {
  return {
    id: project.id,
    key: project.key,
    name: project.name,
    hostName: project.hostName,
    hostStatus: project.hostStatus,
    status: project.status,
    provisioningError: project.provisioningError,
    permissions: project.permissions,
    // The host enforces export; this only decides whether the UI offers it.
    downloadRestricted: !project.permissions.includes('download')
  }
}

/** A malformed row is dropped: one bad project must not hide the rest. */
export async function listCloudProjects(
  session: WebCloudSession,
  options: RequestOptions = {}
): Promise<WebCloudProject[]> {
  const body = await sendAuthorized(session, (accessToken) =>
    requestJson({
      url: `${session.apiUrl}/v1/projects`,
      accessToken,
      fetchImpl: options.fetchImpl
    })
  )
  const rows = readProjectRows(body)
  if (rows === null) {
    throw malformed('project list reply has no projects array')
  }
  const projects: WebCloudProject[] = []
  for (const row of rows) {
    const parsed = parseProjectRow(row)
    if (parsed !== null) {
      projects.push(toWebProject(parsed))
    }
  }
  return projects
}

export async function requestCloudTicket(
  session: WebCloudSession,
  projectId: string,
  devicePublicKeyB64: string,
  options: RequestOptions = {}
): Promise<CloudReplyTicket> {
  const body = await sendAuthorized(session, (accessToken) =>
    requestJson({
      url: `${session.apiUrl}/v1/projects/${encodeURIComponent(projectId)}/connect`,
      method: 'POST',
      accessToken,
      fetchImpl: options.fetchImpl,
      body: {
        deviceId: session.deviceId,
        devicePubKey: devicePublicKeyB64,
        clientVersion: WEB_CLOUD_CLIENT_VERSION
      }
    })
  )
  const ticket = parseConnectTicketReply(body)
  if (ticket === null) {
    throw malformed('connect reply did not match the ticket contract')
  }
  return ticket
}

export type CloudPairingOfferOptions = {
  /** Test/recovery override; the ticket's direct endpoints win otherwise. */
  endpointUrl?: string
}

/**
 * A browser cannot probe addresses, so selection is priority only: direct first,
 * relay as last resort (design D4). `wss://` on an `https://` page is expected.
 */
function chooseTicketEndpoint(
  ticket: CloudReplyTicket,
  overrideUrl: string | undefined
): CloudReplyEndpoint | null {
  if (overrideUrl) {
    return { priority: 0, url: overrideUrl }
  }
  const byPriority = (a: CloudReplyEndpoint, b: CloudReplyEndpoint): number =>
    a.priority - b.priority
  return (
    [...ticket.endpoints.direct].sort(byPriority)[0] ??
    [...ticket.endpoints.relay].sort(byPriority)[0] ??
    null
  )
}

export function cloudPairingOfferFromTicket(
  ticket: CloudReplyTicket,
  devicePublicKeyB64: string,
  options: CloudPairingOfferOptions = {}
): WebPairingOffer {
  const deviceKey = normalizeWebPairingKey32(devicePublicKeyB64)
  if (deviceKey === null) {
    throw new WebCloudSessionError(
      WEB_CLOUD_ERROR_CODE.deviceKeyInvalid,
      'device public key must be a 32-byte base64 key'
    )
  }
  // Why validate now: the transport would otherwise fail after a socket opens.
  const hostKey = normalizeWebPairingKey32(ticket.host.e2eePublicKeyB64)
  if (hostKey === null) {
    throw malformed('ticket host has no usable E2EE public key')
  }
  const endpoint = chooseTicketEndpoint(ticket, options.endpointUrl)
  if (endpoint === null) {
    throw new WebCloudSessionError(
      WEB_CLOUD_ERROR_CODE.noEndpoint,
      'ticket carries no direct or relay endpoint'
    )
  }
  const claims = readTicketClaims(ticket.credential)
  if (claims.deviceToken === null) {
    throw malformed('ticket credential has no device token claim')
  }
  return {
    v: 2,
    endpoint: endpoint.url,
    deviceToken: claims.deviceToken,
    publicKeyB64: hostKey,
    ...(claims.deviceId ? { pairedDeviceId: claims.deviceId } : {}),
    scope: 'runtime',
    cloud: { credential: ticket.credential, devicePublicKeyB64: deviceKey }
  }
}
