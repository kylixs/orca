import type { DeviceEntry } from './device-registry'

/**
 * Removes the cloud row a token authenticated, returning null when no row
 * matched. Paired/mobile rows never qualify, so their tokens cannot be dropped.
 */
export function withoutCloudDeviceToken(
  devices: readonly DeviceEntry[],
  token: string
): DeviceEntry[] | null {
  const index = devices.findIndex(
    (device) => device.token === token && device.cloudSession !== undefined
  )
  if (index === -1) {
    return null
  }
  return devices.filter((_, candidate) => candidate !== index)
}

/** A process restart makes every cloud ticket dead; only paired/mobile rows survive. */
export function dropCloudSessionRows(devices: readonly DeviceEntry[]): {
  devices: DeviceEntry[]
  dropped: number
} {
  const retained = devices.filter((device) => device.cloudSession === undefined)
  return { devices: retained, dropped: devices.length - retained.length }
}
