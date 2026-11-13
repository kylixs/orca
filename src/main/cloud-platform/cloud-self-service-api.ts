import type { CloudCreateProjectInput } from '../../shared/cloud-platform-ipc'
import {
  parseProjectRow,
  parseProvisionableHostsReply,
  type CloudReplyHostOption,
  type CloudReplyProject
} from '../../shared/cloud-platform-reply'
import type { CloudAuthSession } from './cloud-auth-session'
import { cloudAuthorizedFetch, throwCloudPlatformError } from './cloud-authorized-request'

/** The two platform calls developer self-service creation needs, kept out of the socket client. */

export async function createCloudProject(
  fetchImpl: typeof fetch,
  apiUrl: string,
  auth: CloudAuthSession,
  input: CloudCreateProjectInput
): Promise<CloudReplyProject> {
  const res = await cloudAuthorizedFetch(fetchImpl, apiUrl, auth, '/v1/projects/self', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input)
  })
  if (!res.ok) {
    return throwCloudPlatformError(res, `create project failed: ${res.status}`)
  }
  const project = parseProjectRow(await res.json())
  if (project === null) {
    throw new Error('create project response malformed')
  }
  return project
}

export async function listProvisionableHosts(
  fetchImpl: typeof fetch,
  apiUrl: string,
  auth: CloudAuthSession
): Promise<CloudReplyHostOption[]> {
  const res = await cloudAuthorizedFetch(fetchImpl, apiUrl, auth, '/v1/hosts/available')
  if (!res.ok) {
    return throwCloudPlatformError(res, `list provisionable hosts failed: ${res.status}`)
  }
  const hosts = parseProvisionableHostsReply(await res.json())
  if (hosts === null) {
    throw new Error('list provisionable hosts response malformed')
  }
  return hosts
}
