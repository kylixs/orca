import { readField, readNumber, readObjectValue } from '../../shared/json-fields'

/**
 * The platform's policy pack, delivered with every heartbeat (design §9.3).
 *
 * The host executes it, because a managed client is not trustworthy: hiding the
 * download button is a UI convenience, and "the method is refused here" is the
 * actual control. Download is deny-by-default, so a missing or unparsable pack
 * must close the export path rather than open it.
 */

export type CloudReadRate = {
  /** Read RPCs permitted per rolling hour, per project. */
  calls: number
  /** Bytes permitted per rolling hour, per project. */
  bytes: number
}

export type CloudPolicies = {
  downloadDefault: 'allow' | 'deny'
  projectDownloadOverrides: Record<string, 'allow' | 'deny'>
  readRatePerHour: CloudReadRate
  projectReadRateOverrides: Record<string, CloudReadRate>
}

/** Used when the platform has never delivered a pack; still bounded, never unlimited. */
export const DEFAULT_READ_RATE: CloudReadRate = { calls: 600, bytes: 64 * 1024 * 1024 }
export const DEFAULT_DOWNLOAD_POLICY: CloudPolicies = {
  downloadDefault: 'deny',
  projectDownloadOverrides: {},
  readRatePerHour: DEFAULT_READ_RATE,
  projectReadRateOverrides: {}
}

function parseVerdict(value: unknown): 'allow' | 'deny' | null {
  return value === 'allow' || value === 'deny' ? value : null
}

function parseRate(value: unknown): CloudReadRate | null {
  const calls = readNumber(value, 'calls')
  const bytes = readNumber(value, 'bytes')
  if (calls === null || bytes === null || calls <= 0 || bytes <= 0) {
    return null
  }
  return { calls: Math.floor(calls), bytes: Math.floor(bytes) }
}

function parseVerdictMap(value: unknown): Record<string, 'allow' | 'deny'> {
  const overrides: Record<string, 'allow' | 'deny'> = {}
  for (const [projectId, verdict] of Object.entries(readObjectValue(value) ?? {})) {
    const parsed = parseVerdict(verdict)
    if (parsed) {
      overrides[projectId] = parsed
    }
  }
  return overrides
}

function parseRateMap(value: unknown): Record<string, CloudReadRate> {
  const overrides: Record<string, CloudReadRate> = {}
  for (const [projectId, rate] of Object.entries(readObjectValue(value) ?? {})) {
    const parsed = parseRate(rate)
    if (parsed) {
      overrides[projectId] = parsed
    }
  }
  return overrides
}

export function parseCloudPolicies(value: unknown): CloudPolicies | null {
  if (!readObjectValue(value)) {
    return null
  }
  // A pack whose download verdict is missing cannot be interpreted as "allow":
  // the platform always sends one, so its absence means the pack is not ours.
  const downloadDefault = parseVerdict(readField(value, 'downloadDefault'))
  if (downloadDefault === null) {
    return null
  }
  return {
    downloadDefault,
    projectDownloadOverrides: parseVerdictMap(readField(value, 'projectOverrides')),
    readRatePerHour: parseRate(readField(value, 'readRatePerHour')) ?? DEFAULT_READ_RATE,
    projectReadRateOverrides: parseRateMap(readField(value, 'rateOverrides'))
  }
}

/** Project override outranks the global default; deny wins when nothing is set. */
export function downloadAllowed(policies: CloudPolicies, projectId: string): boolean {
  return (policies.projectDownloadOverrides[projectId] ?? policies.downloadDefault) === 'allow'
}

export function readRateFor(policies: CloudPolicies, projectId: string): CloudReadRate {
  return policies.projectReadRateOverrides[projectId] ?? policies.readRatePerHour
}
