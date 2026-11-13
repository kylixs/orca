import type { DeviceEntry, DeviceScope } from './device-registry'
import type { CloudPermission } from '../cloud-platform/cloud-credential'
import { sameCloudSession } from './device-registry-entry-validators'

export type CloudDeviceAdoption = {
  deviceId: string
  token: string
  name: string
  scope?: DeviceScope
  /** The ticket's device key; the handshake must prove possession of it. */
  publicKeyB64?: string
  /** The project, permission set and path roots the platform signed into this ticket. */
  project?: string
  permissions?: readonly CloudPermission[]
  projectRoot?: string
  workspaceRoot?: string
  repoUrl?: string
  defaultBranch?: string
}

/**
 * Live tokens kept per registered device per project. The host admits at most 3
 * sessions per user per project; one spare covers the socket closing as its
 * replacement is adopted. Older tokens are dead once evicted.
 */
const CLOUD_TOKENS_PER_DEVICE_PROJECT = 4

/** Drops the oldest tokens for this device+project so one-shot ticket churn stays bounded. */
function trimSessionRows(
  devices: DeviceEntry[],
  deviceId: string,
  projectId: string | undefined
): DeviceEntry[] {
  if (projectId === undefined) {
    return devices
  }
  const group = devices.filter(
    (device) => device.deviceId === deviceId && device.cloudSession?.projectId === projectId
  )
  if (group.length <= CLOUD_TOKENS_PER_DEVICE_PROJECT) {
    return devices
  }
  const evicted = new Set(group.slice(0, group.length - CLOUD_TOKENS_PER_DEVICE_PROJECT))
  return devices.filter((device) => !evicted.has(device))
}

/**
 * Registers a device the cloud platform already authenticated. Pure so the registry
 * stays under its size budget; the caller persists the returned list.
 */
export function adoptCloudDeviceInList(
  devices: readonly DeviceEntry[],
  input: CloudDeviceAdoption,
  now = Date.now()
): { device: DeviceEntry; devices: DeviceEntry[]; changed: boolean } {
  const cloudSession =
    input.project && input.permissions && input.projectRoot && input.workspaceRoot
      ? {
          projectId: input.project,
          permissions: [...input.permissions],
          projectRoot: input.projectRoot,
          workspaceRoot: input.workspaceRoot,
          ...(typeof input.repoUrl === 'string' ? { repoUrl: input.repoUrl } : {}),
          ...(typeof input.defaultBranch === 'string' ? { defaultBranch: input.defaultBranch } : {})
        }
      : undefined
  // Why token, not just deviceId: one registered desktop opens a socket per
  // project, and each ticket carries its own token and project roots.
  const existing = devices.find(
    (device) => device.deviceId === input.deviceId && device.token === input.token
  )
  if (existing) {
    if (
      existing.token === input.token &&
      existing.publicKeyB64 === input.publicKeyB64 &&
      sameCloudSession(existing, cloudSession)
    ) {
      return { device: existing, devices: [...devices], changed: false }
    }
    const updated: DeviceEntry = {
      ...existing,
      token: input.token,
      name: input.name,
      ...(input.publicKeyB64 ? { publicKeyB64: input.publicKeyB64 } : {}),
      ...(cloudSession ? { cloudSession } : {})
    }
    return {
      device: updated,
      devices: devices.map((device) =>
        device.deviceId === input.deviceId && device.token === input.token ? updated : device
      ),
      changed: true
    }
  }
  const entry: DeviceEntry = {
    deviceId: input.deviceId,
    name: input.name,
    token: input.token,
    scope: input.scope ?? 'runtime',
    ...(input.publicKeyB64 ? { publicKeyB64: input.publicKeyB64 } : {}),
    ...(cloudSession ? { cloudSession } : {}),
    pairedAt: now,
    lastSeenAt: 0
  }
  return {
    device: entry,
    devices: trimSessionRows([...devices, entry], input.deviceId, cloudSession?.projectId),
    changed: true
  }
}
