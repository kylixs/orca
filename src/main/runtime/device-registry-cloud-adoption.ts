import type { DeviceEntry, DeviceScope } from './device-registry'

export type CloudDeviceAdoption = {
  deviceId: string
  token: string
  name: string
  scope?: DeviceScope
  /** The ticket's device key; the handshake must prove possession of it. */
  publicKeyB64?: string
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
  const existing = devices.find((device) => device.deviceId === input.deviceId)
  if (existing) {
    if (existing.token === input.token && existing.publicKeyB64 === input.publicKeyB64) {
      return { device: existing, devices: [...devices], changed: false }
    }
    const updated: DeviceEntry = {
      ...existing,
      token: input.token,
      name: input.name,
      ...(input.publicKeyB64 ? { publicKeyB64: input.publicKeyB64 } : {})
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
    pairedAt: now,
    lastSeenAt: 0
  }
  return { device: entry, devices: [...devices, entry], changed: true }
}
