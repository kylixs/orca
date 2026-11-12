import {
  parseJsonText,
  readArray,
  readArrayValue,
  readField,
  readNumber,
  readString,
  readStringArray
} from '../../shared/json-fields'
import type { CloudProjectPermission } from '../../shared/cloud-platform-ipc'
import type { CloudConnectTicket, CloudEndpoint, CloudProject } from './cloud-connect-client'

/** Platform response parsing for the desktop connect client; null means "malformed". */

export type TicketClaims = {
  deviceToken: string | null
  deviceId: string | null
  devicePubKey: string | null
  host: string | null
  /** Signed project permissions; unknown values are dropped, never passed on. */
  permissions: CloudProjectPermission[]
}

const KNOWN_PERMISSIONS: ReadonlySet<string> = new Set<CloudProjectPermission>([
  'open',
  'terminal',
  'agent',
  'file:read',
  'file:write',
  'browser',
  'download'
])

export function readTicketClaims(credential: string): TicketClaims {
  const body = credential.split('.')[1]
  const parsed =
    body === undefined ? null : parseJsonText(Buffer.from(body, 'base64url').toString())
  return {
    deviceToken: readString(parsed, 'deviceToken'),
    deviceId: readString(parsed, 'deviceId'),
    devicePubKey: readString(parsed, 'devicePubKey'),
    host: readString(parsed, 'host'),
    permissions: (readStringArray(parsed, 'perms') ?? []).filter(
      (value): value is CloudProjectPermission => KNOWN_PERMISSIONS.has(value)
    )
  }
}

function parseEndpoint(value: unknown): CloudEndpoint | null {
  const url = readString(value, 'url')
  const priority = readNumber(value, 'priority')
  if (url === null || priority === null) {
    return null
  }
  const sni = readString(value, 'sni')
  const routeKey = readString(value, 'routeKey')
  return { priority, url, ...(sni ? { sni } : {}), ...(routeKey ? { routeKey } : {}) }
}

function parseEndpoints(value: unknown): CloudEndpoint[] {
  return (readArrayValue(value) ?? [])
    .map(parseEndpoint)
    .filter((entry): entry is CloudEndpoint => entry !== null)
}

function parseProject(value: unknown): CloudProject | null {
  const id = readString(value, 'id')
  const key = readString(value, 'key')
  const name = readString(value, 'name')
  const hostStatus = readString(value, 'hostStatus')
  if (id === null || key === null || name === null || hostStatus === null) {
    return null
  }
  return {
    id,
    key,
    name,
    hostName: readString(value, 'hostName'),
    hostStatus,
    permissions: readStringArray(value, 'permissions') ?? []
  }
}

export function parseProjectList(body: unknown): CloudProject[] | null {
  const projects = readArray(body, 'projects')
  if (projects === null) {
    return null
  }
  const parsed = projects.map(parseProject)
  return parsed.every((entry): entry is CloudProject => entry !== null) ? parsed : null
}

function parseTicketHost(value: unknown): CloudConnectTicket['host'] | null {
  const id = readString(value, 'id')
  const name = readString(value, 'name')
  const fingerprint = readString(value, 'fingerprint')
  const tlsFingerprint = readString(value, 'tlsFingerprint')
  const e2eePublicKeyB64 = readString(value, 'e2eePublicKeyB64')
  const capabilities = readStringArray(value, 'capabilities')
  if (
    id === null ||
    name === null ||
    fingerprint === null ||
    tlsFingerprint === null ||
    e2eePublicKeyB64 === null ||
    capabilities === null
  ) {
    return null
  }
  return { id, name, fingerprint, tlsFingerprint, e2eePublicKeyB64, capabilities }
}

function parseWorkspace(value: unknown): CloudConnectTicket['workspace'] | null {
  const projectRoot = readString(value, 'projectRoot')
  const workspaceRoot = readString(value, 'workspaceRoot')
  const defaultBranch = readString(value, 'defaultBranch')
  return projectRoot !== null && workspaceRoot !== null && defaultBranch !== null
    ? { projectRoot, workspaceRoot, defaultBranch }
    : null
}

export function parseConnectTicket(body: unknown): CloudConnectTicket | null {
  const credential = readString(body, 'credential')
  const expiresIn = readNumber(body, 'expiresIn')
  const host = parseTicketHost(readField(body, 'host'))
  const endpoints = readField(body, 'endpoints')
  const workspace = parseWorkspace(readField(body, 'workspace'))
  if (
    credential === null ||
    expiresIn === null ||
    host === null ||
    workspace === null ||
    endpoints === null ||
    typeof endpoints !== 'object'
  ) {
    return null
  }
  return {
    credential,
    expiresIn,
    host,
    endpoints: {
      direct: parseEndpoints(readField(endpoints, 'direct')),
      relay: parseEndpoints(readField(endpoints, 'relay'))
    },
    workspace
  }
}
