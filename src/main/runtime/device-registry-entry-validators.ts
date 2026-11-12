import type { DeviceScope } from '../../shared/runtime-session-contracts'
import type { RelayDeviceBinding } from './relay/relay-revoke-outbox'
import { RUNTIME_DEVICE_GRANTS, type RuntimeDeviceGrant } from './rpc/rpc-method-permission'
import type { DeviceEntry } from './device-registry'
import type { CloudPermission } from '../cloud-platform/cloud-credential'

// Field validators for registry rows, split out so the registry file stays within
// its size budget. Each one decides whether an on-disk value may be trusted.

const GRANTABLE: ReadonlySet<string> = new Set(RUNTIME_DEVICE_GRANTS)

function isRuntimeDeviceGrant(value: unknown): value is RuntimeDeviceGrant {
  return typeof value === 'string' && GRANTABLE.has(value)
}

export function validGrants(value: unknown, scope: DeviceScope): RuntimeDeviceGrant[] | undefined {
  if (scope !== 'runtime' || !Array.isArray(value)) {
    return undefined
  }
  const grants = [...new Set(value.filter(isRuntimeDeviceGrant))].sort()
  return grants.length > 0 ? grants : undefined
}

export function sameGrants(entry: DeviceEntry, grants: readonly RuntimeDeviceGrant[]): boolean {
  const current = entry.grants ?? []
  return current.length === grants.length && current.every((grant) => grants.includes(grant))
}

const CLOUD_PERMISSIONS: ReadonlySet<string> = new Set([
  'open',
  'terminal',
  'agent',
  'file:read',
  'file:write',
  'browser',
  'download'
])

function isCloudPermission(value: unknown): value is CloudPermission {
  return typeof value === 'string' && CLOUD_PERMISSIONS.has(value)
}

/** Cloud session rows decide RPC authority, so an unparsable row must lose it, not keep it. */
export function validCloudSession(value: unknown):
  | {
      projectId: string
      permissions: CloudPermission[]
      projectRoot: string
      workspaceRoot: string
    }
  | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  if (!('projectId' in value) || typeof value.projectId !== 'string') {
    return undefined
  }
  if (!('permissions' in value) || !Array.isArray(value.permissions)) {
    return undefined
  }
  // The roots are the session's path boundary; a row missing them cannot be
  // enforced, so it loses cloud rights entirely rather than defaulting to "anywhere".
  if (!('projectRoot' in value) || typeof value.projectRoot !== 'string') {
    return undefined
  }
  if (!('workspaceRoot' in value) || typeof value.workspaceRoot !== 'string') {
    return undefined
  }
  return {
    projectId: value.projectId,
    permissions: value.permissions.filter(isCloudPermission),
    projectRoot: value.projectRoot,
    workspaceRoot: value.workspaceRoot
  }
}

export function sameCloudSession(
  entry: DeviceEntry,
  next:
    | {
        projectId: string
        permissions: readonly CloudPermission[]
        projectRoot: string
        workspaceRoot: string
      }
    | undefined
): boolean {
  const current = entry.cloudSession
  if (!current || !next) {
    return current === undefined && next === undefined
  }
  return (
    current.projectId === next.projectId &&
    current.projectRoot === next.projectRoot &&
    current.workspaceRoot === next.workspaceRoot &&
    current.permissions.length === next.permissions.length &&
    current.permissions.every((permission) => next.permissions.includes(permission))
  )
}

export function validRelayBinding(
  value: unknown,
  deviceId: string
): RelayDeviceBinding | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const binding = value as Partial<RelayDeviceBinding>
  return binding.relayDeviceId === deviceId &&
    typeof binding.relayHostId === 'string' &&
    typeof binding.ownerIdentityKey === 'string'
    ? {
        relayHostId: binding.relayHostId,
        relayDeviceId: binding.relayDeviceId,
        ownerIdentityKey: binding.ownerIdentityKey,
        ...(typeof binding.inviteExpiresAt === 'number' && Number.isFinite(binding.inviteExpiresAt)
          ? { inviteExpiresAt: binding.inviteExpiresAt }
          : {})
      }
    : undefined
}
