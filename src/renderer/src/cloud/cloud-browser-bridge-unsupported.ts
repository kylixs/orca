import type {
  CloudArchiveProjectResult,
  CloudCreateProjectResult,
  CloudProjectRegistration,
  CloudProvisionableHost,
  CloudRetryPrepareResult
} from '../../../shared/cloud-platform-ipc'

/**
 * Operations only a native runtime host can perform. The admin page has no host,
 * so these answer with an explicit unsupported code instead of pretending to work.
 */
export const browserUnsupportedAdminMethods = {
  async registerProjects(): Promise<CloudProjectRegistration> {
    return { environments: [], failures: [], removedEnvironmentIds: [] }
  },
  async retryPrepare(): Promise<CloudRetryPrepareResult> {
    return { ok: false, code: 'ADMIN_SESSION_UNSUPPORTED' }
  },
  async createProject(): Promise<CloudCreateProjectResult> {
    return { ok: false, code: 'ADMIN_SESSION_UNSUPPORTED' }
  },
  async archiveProject(): Promise<CloudArchiveProjectResult> {
    return { ok: false, code: 'ADMIN_SESSION_UNSUPPORTED' }
  },
  async listProvisionableHosts(): Promise<CloudProvisionableHost[]> {
    return []
  }
}
