import type { CloudProjectSummary } from '../../shared/cloud-platform-ipc'
import type { CloudProject } from './cloud-connect-client'

/** Renderer-visible project rows: no credentials, and never a guessed `ready`. */
export function summarizeCloudProject(project: CloudProject): CloudProjectSummary {
  return {
    id: project.id,
    key: project.key,
    name: project.name,
    hostName: project.hostName,
    hostStatus: project.hostStatus,
    status: project.status,
    provisioningError: project.provisioningError,
    // Managed projects deny export by default; the host enforces it, this only
    // drives whether the UI offers the action at all (FR-7.3).
    downloadRestricted: !project.permissions.includes('download')
  }
}
