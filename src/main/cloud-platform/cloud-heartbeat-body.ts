import { heartbeatAddrsField } from './cloud-host-enrollment'
import type { CloudProvisionReport } from './cloud-project-provision'
import type { CloudHostAuditRecord } from './cloud-host-audit'

/** The heartbeat's optional payloads; absent sections are omitted, not sent empty. */
export type HeartbeatSource = {
  directAddrs?: string[] | (() => string[])
  e2eePublicKeyB64?: () => string | null
  tlsFingerprint?: () => string | null
  projectsRoot?: string
  /** Directory names under projectsRoot, resolved per beat so the listing stays current. */
  projectDirs?: string[] | (() => string[])
}

/** Reported whenever the host declares a root, so an empty listing stays visible. */
function projectDirsField(configured: string[] | (() => string[]) | undefined): {
  projectDirs?: string[]
} {
  if (!configured) {
    return {}
  }
  const value = typeof configured === 'function' ? configured() : configured
  return { projectDirs: value }
}

export function cloudHeartbeatBody(
  source: HeartbeatSource,
  provisioned: readonly CloudProvisionReport[],
  audit: readonly CloudHostAuditRecord[]
): Record<string, unknown> {
  const e2eePublicKeyB64 = source.e2eePublicKeyB64?.()
  const tlsFingerprint = source.tlsFingerprint?.()
  return {
    status: 'online',
    ...heartbeatAddrsField(source.directAddrs),
    ...(source.projectsRoot ? { projectsRoot: source.projectsRoot } : {}),
    ...projectDirsField(source.projectDirs),
    ...(e2eePublicKeyB64 ? { e2eePublicKeyB64 } : {}),
    ...(tlsFingerprint ? { tlsFingerprint } : {}),
    ...(provisioned.length > 0 ? { provisioned } : {}),
    ...(audit.length > 0 ? { audit } : {})
  }
}
