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
// Why: the mirror effects must re-evaluate when a late `workspace.info` lands (U113). A plain
// record write would otherwise leave an effect that already ran with the old capabilities armed.
let revision = 0
const listeners = new Set<() => void>()

function notifyCapabilityChange(): void {
  revision += 1
  for (const listener of listeners) {
    listener()
  }
}

export function recordWebCloudSessionCapabilities(
  environmentId: string,
  capabilities: readonly string[],
  pairingRevision: number | undefined = getRuntimeEnvironmentRevision(environmentId)
): void {
  records.set(environmentId, { pairingRevision, capabilities: new Set(capabilities) })
  notifyCapabilityChange()
}

/** Drops a record a failed bootstrap can no longer vouch for; the next probe re-records it. */
export function clearWebCloudSessionCapabilities(environmentId: string): void {
  if (!records.delete(environmentId)) {
    return
  }
  notifyCapabilityChange()
}

export function getWebCloudSessionCapabilitiesRevision(): number {
  return revision
}

export function subscribeWebCloudSessionCapabilities(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
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
  // Why fail-closed: an unreadable revision (retired/cold catalog) cannot prove the host is the
  // one this record describes, so an old host must not inherit the previous pairing's consent.
  if (record.pairingRevision === undefined || currentRevision === undefined) {
    return false
  }
  if (record.pairingRevision !== currentRevision) {
    return false
  }
  return record.capabilities.has(CLOUD_SESSION_TABS_RESTORE_CAPABILITY)
}

/** Test seam: the next bootstrap records from scratch. */
export function resetWebCloudSessionCapabilities(): void {
  records.clear()
  listeners.clear()
  revision = 0
}
