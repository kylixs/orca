import { CloudHostEnrolmentFailure } from '../cloud-platform/cloud-host-enrollment'
import type { CloudHostStatePhase } from '../startup/cloud-host-state'

/** Only host mode owns bounded registration retries; desktop keeps fail-fast. */
export function hostAdmissionOptions(
  userDataPath: string,
  hostMode: boolean
): { userDataPath: string; retryEnrolment?: true } {
  return hostMode ? { userDataPath, retryEnrolment: true } : { userDataPath }
}

/** Which startup stage a fatal code belongs to in the state file (design §4.2.7). */
export function hostModeFailurePhase(code: string): CloudHostStatePhase {
  if (code === 'host_config_invalid') {
    return 'config'
  }
  return code === 'runtime_unavailable' ? 'runtime' : 'enrolment'
}

/**
 * Host-mode startup gate: `ready` covers registration and the first heartbeat
 * attempt, so awaiting it here makes an enrollment failure a launch failure
 * instead of a host that serves nothing and exits 0.
 */
export async function awaitHostModeEnrolment(
  admission: { ready: Promise<void> } | null,
  hostMode = true,
  onFailure?: (failure: CloudHostEnrolmentFailure) => void
): Promise<void> {
  if (!hostMode) {
    return
  }
  if (!admission) {
    const failure = new CloudHostEnrolmentFailure({
      code: 'host_config_invalid',
      retryable: false,
      detail: 'host mode requires cloud admission'
    })
    onFailure?.(failure)
    throw failure
  }
  try {
    await admission.ready
  } catch (error) {
    const failure =
      error instanceof CloudHostEnrolmentFailure
        ? error
        : new CloudHostEnrolmentFailure({
            code: 'runtime_unavailable',
            retryable: false,
            detail: error instanceof Error ? error.message : String(error)
          })
    onFailure?.(failure)
    throw failure
  }
}
