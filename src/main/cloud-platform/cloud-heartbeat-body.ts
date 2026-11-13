import { heartbeatAddrsField } from './cloud-host-enrollment'
import type { CloudProvisionReport } from './cloud-project-provision'
import type { CloudHostAuditRecord } from './cloud-host-audit'

/** The heartbeat's optional payloads; absent sections are omitted, not sent empty. */
export type HeartbeatSource = {
  directAddrs?: string[] | (() => string[])
  e2eePublicKeyB64?: () => string | null
  projectsRoot?: string
}

export function cloudHeartbeatBody(
  source: HeartbeatSource,
  provisioned: readonly CloudProvisionReport[],
  audit: readonly CloudHostAuditRecord[]
): Record<string, unknown> {
  const e2eePublicKeyB64 = source.e2eePublicKeyB64?.()
  return {
    status: 'online',
    ...heartbeatAddrsField(source.directAddrs),
    ...(source.projectsRoot ? { projectsRoot: source.projectsRoot } : {}),
    ...(e2eePublicKeyB64 ? { e2eePublicKeyB64 } : {}),
    ...(provisioned.length > 0 ? { provisioned } : {}),
    ...(audit.length > 0 ? { audit } : {})
  }
}
