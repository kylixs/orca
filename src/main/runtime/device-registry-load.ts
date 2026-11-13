import { existsSync, readFileSync } from 'node:fs'
import { hardenExistingSecureFile, isUnreadableError } from '../../shared/secure-file'
import type { DeviceEntry } from './device-registry'
import { normalizeDeviceEntry } from './device-registry-entry-validators'
import { dropCloudSessionRows } from './device-registry-cloud-rows'

export type DeviceRegistryLoad = {
  devices: DeviceEntry[]
  droppedCloudRows: number
  unreadable: boolean
}

function isRegistryRow(value: unknown): value is DeviceEntry {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Reads and normalizes the registry. Cloud rows are single-use tickets, so a restart drops them. */
export function readDeviceRegistryEntries(registryPath: string): DeviceRegistryLoad {
  if (!existsSync(registryPath)) {
    return { devices: [], droppedCloudRows: 0, unreadable: false }
  }
  try {
    hardenExistingSecureFile(registryPath)
    const parsed: unknown = JSON.parse(readFileSync(registryPath, 'utf-8'))
    if (!Array.isArray(parsed)) {
      return { devices: [], droppedCloudRows: 0, unreadable: false }
    }
    // Why: prune raw rows first — even a malformed cloud row must not survive as a paired credential.
    const { devices, dropped } = dropCloudSessionRows(parsed.filter(isRegistryRow))
    return {
      devices: devices.map(normalizeDeviceEntry),
      droppedCloudRows: dropped,
      unreadable: false
    }
  } catch (error) {
    // Why: "cannot read" is not "is empty" — overwriting would erase every paired device's token.
    return { devices: [], droppedCloudRows: 0, unreadable: isUnreadableError(error) }
  }
}
