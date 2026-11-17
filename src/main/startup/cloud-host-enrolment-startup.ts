import {
  CloudHostEnrolmentFailure,
  enrollCloudHost,
  enrollCloudHostWithRetry,
  readStoredHostCredential,
  storeHostCredential,
  type CloudHostCredential,
  type EnrollInput,
  type EnrolmentRetryOptions
} from '../cloud-platform/cloud-host-enrollment'

export type HostEnrolmentStartupInput = {
  userDataPath?: string
  apiUrl: string
  hostToken: string
  hostName: string
  directAddrs: string[]
  relayTarget?: string
  tlsFingerprint?: string
  orcaVersion?: string
  projectsRoot?: string
  retry: EnrolmentRetryOptions & { enabled: boolean }
}

/**
 * A stored credential means the token was already spent: never register again
 * unless `--reenroll` removed it under the instance lock (H8c).
 */
export async function readOrEnrollHostCredential(
  input: HostEnrolmentStartupInput
): Promise<CloudHostCredential> {
  const stored = input.userDataPath ? readStoredHostCredential(input.userDataPath) : null
  return stored ?? enrollHostCredential(input)
}

export async function enrollHostCredential(
  input: HostEnrolmentStartupInput
): Promise<CloudHostCredential> {
  const enrolInput: EnrollInput = {
    apiUrl: input.apiUrl,
    hostToken: input.hostToken,
    hostName: input.hostName,
    // Nothing is listening yet; the heartbeat reports the real port later.
    directAddrs: input.directAddrs,
    relayTarget: input.relayTarget,
    ...(input.tlsFingerprint ? { tlsFingerprint: input.tlsFingerprint } : {}),
    ...(input.orcaVersion ? { orcaVersion: input.orcaVersion } : {}),
    ...(input.projectsRoot ? { projectsRoot: input.projectsRoot } : {})
  }
  const enrolled = input.retry.enabled
    ? await enrollCloudHostWithRetry(enrolInput, input.retry)
    : await enrollCloudHost(enrolInput, input.retry.fetchImpl)
  if (!enrolled.ok) {
    // Never serve ungated: the failure keeps its code so host mode can pick an exit code.
    throw new CloudHostEnrolmentFailure(enrolled.error)
  }
  if (input.userDataPath) {
    try {
      storeHostCredential(input.userDataPath, enrolled.value)
    } catch (error) {
      throw new CloudHostEnrolmentFailure({
        code: 'credential_write_failed',
        retryable: false,
        detail: error instanceof Error ? error.message : String(error)
      })
    }
  }
  return enrolled.value
}
