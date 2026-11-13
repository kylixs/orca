import type { CloudCreateProjectInput } from '../../shared/cloud-platform-ipc'
import {
  parseProjectRow,
  parseProvisionableHostsReply,
  type CloudReplyHostOption,
  type CloudReplyProject
} from '../../shared/cloud-platform-reply'
import { readField, readString } from '../../shared/json-fields'

/** The two platform calls developer self-service creation needs, kept out of the socket client. */

export async function createCloudProject(
  fetchImpl: typeof fetch,
  apiUrl: string,
  accessToken: string,
  input: CloudCreateProjectInput
): Promise<CloudReplyProject> {
  const res = await fetchImpl(`${apiUrl}/v1/projects/self`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(input)
  })
  const body: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const code = readString(readField(body, 'error'), 'code')
    throw Object.assign(new Error(code ?? `create project failed: ${res.status}`), { code })
  }
  const project = parseProjectRow(body)
  if (project === null) {
    throw new Error('create project response malformed')
  }
  return project
}

export async function listProvisionableHosts(
  fetchImpl: typeof fetch,
  apiUrl: string,
  accessToken: string
): Promise<CloudReplyHostOption[]> {
  const res = await fetchImpl(`${apiUrl}/v1/hosts/available`, {
    headers: { authorization: `Bearer ${accessToken}` }
  })
  if (!res.ok) {
    throw new Error(`list provisionable hosts failed: ${res.status}`)
  }
  const hosts = parseProvisionableHostsReply(await res.json())
  if (hosts === null) {
    throw new Error('list provisionable hosts response malformed')
  }
  return hosts
}
