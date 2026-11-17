import { CloudHostEnrolmentFailure } from '../cloud-platform/cloud-host-enrollment'

/** Only host mode owns bounded registration retries; desktop keeps fail-fast. */
export function hostAdmissionOptions(
  userDataPath: string,
  hostMode: boolean
): { userDataPath: string; retryEnrolment?: true } {
  return hostMode ? { userDataPath, retryEnrolment: true } : { userDataPath }
}

/**
 * Host-mode startup gate: `ready` covers registration and the first heartbeat
 * attempt, so awaiting it here makes an enrollment failure a launch failure
 * instead of a host that serves nothing and exits 0.
 */
export async function awaitHostModeEnrolment(
  admission: { ready: Promise<void> } | null,
  hostMode = true
): Promise<void> {
  if (!hostMode) {
    return
  }
  if (!admission) {
    throw new CloudHostEnrolmentFailure({
      code: 'host_config_invalid',
      retryable: false,
      detail: 'host mode requires cloud admission'
    })
  }
  try {
    await admission.ready
  } catch (error) {
    if (error instanceof CloudHostEnrolmentFailure) {
      throw error
    }
    throw new CloudHostEnrolmentFailure({
      code: 'runtime_unavailable',
      retryable: false,
      detail: error instanceof Error ? error.message : String(error)
    })
  }
}
