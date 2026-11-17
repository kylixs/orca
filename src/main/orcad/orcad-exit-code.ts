import { OrcadBindAddressError } from './orcad-bind-address'
import { OrcadHostModeFlagConflictError } from './orcad-command-arguments'
import { OrcadBundledRuntimeError } from './orcad-bundled-runtime'
import { OrcadInstanceLockError } from './orcad-instance-lock'
import { ProfileStateAccessError } from '../persistence/profile-state/profile-state-access'
import { CloudHostEnrolmentFailure } from '../cloud-platform/cloud-host-enrollment'
import {
  HOST_MODE_EXIT_CONFIGURATION,
  HOST_MODE_EXIT_FAILED,
  HOST_MODE_EXIT_OK
} from '../../shared/host-mode-contract'

export const ORCAD_EXIT_OK = HOST_MODE_EXIT_OK
export const ORCAD_EXIT_FAILED = HOST_MODE_EXIT_FAILED
/** systemd RestartPreventExitStatus code: a configuration fault restarting cannot fix. */
export const ORCAD_EXIT_CONFIGURATION = HOST_MODE_EXIT_CONFIGURATION

/**
 * Design §3.3. One table for every host-mode failure, so a new code cannot pick an
 * exit code ad hoc and a supervisor's restart policy stays reviewable in one place.
 */
export const HOST_MODE_FAILURE_EXIT_CODES: Readonly<Record<string, number>> = {
  network: HOST_MODE_EXIT_FAILED,
  http_5xx: HOST_MODE_EXIT_FAILED,
  heartbeat_failed: HOST_MODE_EXIT_FAILED,
  host_token_invalid: HOST_MODE_EXIT_CONFIGURATION,
  host_revoked: HOST_MODE_EXIT_CONFIGURATION,
  host_name_required: HOST_MODE_EXIT_CONFIGURATION,
  protocol: HOST_MODE_EXIT_CONFIGURATION,
  credential_write_failed: HOST_MODE_EXIT_CONFIGURATION,
  host_config_invalid: HOST_MODE_EXIT_CONFIGURATION,
  runtime_unavailable: HOST_MODE_EXIT_CONFIGURATION,
  profile_in_use: HOST_MODE_EXIT_CONFIGURATION,
  heartbeat_unauthorized: HOST_MODE_EXIT_CONFIGURATION,
  // 4xx with no more specific code: the platform rejected this registration.
  register_failed: HOST_MODE_EXIT_CONFIGURATION
}

/** A code with no row is unclassified; retryability then decides (1 retryable, 78 terminal). */
export function hostModeExitCodeForFailure(code: string, retryable: boolean): number {
  const mapped = HOST_MODE_FAILURE_EXIT_CODES[code]
  return mapped ?? (retryable ? ORCAD_EXIT_FAILED : ORCAD_EXIT_CONFIGURATION)
}

/** Configuration faults cannot be repaired by a supervisor restart. */
export function resolveOrcadExitCode(error: unknown): number {
  // Enrollment exhaustion is retryable; a rejected token/name/revocation is not.
  if (error instanceof CloudHostEnrolmentFailure) {
    return hostModeExitCodeForFailure(error.code, error.retryable)
  }
  return error instanceof OrcadInstanceLockError ||
    error instanceof OrcadBindAddressError ||
    error instanceof OrcadBundledRuntimeError ||
    error instanceof OrcadHostModeFlagConflictError ||
    error instanceof ProfileStateAccessError
    ? ORCAD_EXIT_CONFIGURATION
    : ORCAD_EXIT_FAILED
}
