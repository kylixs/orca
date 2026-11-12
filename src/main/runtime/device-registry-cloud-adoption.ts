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
  /** The project and permission set the platform signed into this ticket. */
  project?: string
  permissions?: readonly CloudPermission[]
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
    input.project && input.permissions
      ? { projectId: input.project, permissions: [...input.permissions] }
      : undefined
  const existing = devices.find((device) => device.deviceId === input.deviceId)
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
      devices: devices.map((device) => (device.deviceId === input.deviceId ? updated : device)),
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
  return { device: entry, devices: [...devices, entry], changed: true }
}
