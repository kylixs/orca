import { CLOUD_SESSION_TABS_RESTORE_CAPABILITY } from '../../../shared/cloud-workspace-info'
import { getRuntimeEnvironmentRevision } from '../runtime/runtime-environment-revision'

/**
 * U96: which optional families this page's cloud host advertised through
 * `workspace.info.capabilities`. In memory only — a new page or pairing re-probes
 * during bootstrap, so a stale record can never outlive the session it describes.
 */
type CapabilityRecord = {
  pairingRevision: number | undefined
  capabilities: ReadonlySet<string>
}

const records = new Map<string, CapabilityRecord>()

export function recordWebCloudSessionCapabilities(
  environmentId: string,
  capabilities: readonly string[],
  pairingRevision: number | undefined = getRuntimeEnvironmentRevision(environmentId)
): void {
  records.set(environmentId, { pairingRevision, capabilities: new Set(capabilities) })
}

/**
 * Whether the paired-session mirror may run for this environment. A legacy host
 * advertises no capabilities, so the cloud skip stays in force: zero doomed
 * `session.tabs.*` calls and no warn-loop. A differing pairing revision means
 * the host behind this id changed; skip until the next bootstrap re-probes.
 */
export function shouldMirrorCloudSessionTabs(environmentId: string): boolean {
  const record = records.get(environmentId)
  if (!record) {
    return false
  }
  const currentRevision = getRuntimeEnvironmentRevision(environmentId)
  if (
    record.pairingRevision !== undefined &&
    currentRevision !== undefined &&
    record.pairingRevision !== currentRevision
  ) {
    return false
  }
  return record.capabilities.has(CLOUD_SESSION_TABS_RESTORE_CAPABILITY)
}

/** Test seam: the next bootstrap records from scratch. */
export function resetWebCloudSessionCapabilities(): void {
  records.clear()
}
