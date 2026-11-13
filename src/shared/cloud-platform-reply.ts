import {
  parseJsonText,
  readArray,
  readArrayValue,
  readField,
  readNumber,
  readString,
  readStringArray
} from './json-fields'
import type { CloudProjectPermission } from './cloud-platform-ipc'

/**
 * Platform reply parsing shared by the desktop client and the browser client.
 * `readTicketClaims` avoids Node's `Buffer`, so the same contract serves both
 * bundles instead of drifting apart.
 */

export type CloudReplyEndpoint = {
  priority: number
  url: string
  sni?: string
  routeKey?: string
}

export type CloudReplyTicket = {
  credential: string
  expiresIn: number
  host: {
    id: string
    name: string
    fingerprint: string
    tlsFingerprint: string
    e2eePublicKeyB64: string
    capabilities: string[]
  }
  endpoints: { direct: CloudReplyEndpoint[]; relay: CloudReplyEndpoint[] }
  workspace: { projectRoot: string; workspaceRoot: string; defaultBranch: string }
}

export type CloudReplyProject = {
  id: string
  key: string
  name: string
  hostName: string | null
  hostStatus: string
  permissions: string[]
  /** Null when the platform predates provisioning status. */
  status: string | null
  provisioningError: string | null
}

export type CloudTicketClaims = {
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

function decodeBase64UrlText(value: string): string | null {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
  try {
    const binary = globalThis.atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}

export function readTicketClaims(credential: string): CloudTicketClaims {
  const body = credential.split('.')[1]
  const text = body === undefined ? null : decodeBase64UrlText(body)
  const parsed = text === null ? null : parseJsonText(text)
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

function parseEndpoint(value: unknown): CloudReplyEndpoint | null {
  const url = readString(value, 'url')
  const priority = readNumber(value, 'priority')
  if (url === null || priority === null) {
    return null
  }
  const sni = readString(value, 'sni')
  const routeKey = readString(value, 'routeKey')
  return { priority, url, ...(sni ? { sni } : {}), ...(routeKey ? { routeKey } : {}) }
}

function parseEndpoints(value: unknown): CloudReplyEndpoint[] {
  return (readArrayValue(value) ?? [])
    .map(parseEndpoint)
    .filter((entry): entry is CloudReplyEndpoint => entry !== null)
}

/** One project row; null means malformed, so each caller picks its own policy. */
export function parseProjectRow(value: unknown): CloudReplyProject | null {
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
    permissions: readStringArray(value, 'permissions') ?? [],
    status: readString(value, 'status'),
    provisioningError: readString(value, 'provisioningError')
  }
}

export function readProjectRows(body: unknown): unknown[] | null {
  return readArray(body, 'projects')
}

/** Desktop policy: a list with any malformed row is rejected wholesale. */
export function parseProjectListReply(body: unknown): CloudReplyProject[] | null {
  const rows = readProjectRows(body)
  if (rows === null) {
    return null
  }
  const parsed = rows.map(parseProjectRow)
  return parsed.every((entry): entry is CloudReplyProject => entry !== null) ? parsed : null
}

function parseTicketHost(value: unknown): CloudReplyTicket['host'] | null {
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

function parseWorkspace(value: unknown): CloudReplyTicket['workspace'] | null {
  const projectRoot = readString(value, 'projectRoot')
  const workspaceRoot = readString(value, 'workspaceRoot')
  const defaultBranch = readString(value, 'defaultBranch')
  return projectRoot !== null && workspaceRoot !== null && defaultBranch !== null
    ? { projectRoot, workspaceRoot, defaultBranch }
    : null
}

export function parseConnectTicketReply(body: unknown): CloudReplyTicket | null {
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
