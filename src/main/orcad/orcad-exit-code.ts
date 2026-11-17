import { OrcadBindAddressError } from './orcad-bind-address'
import { OrcadBundledRuntimeError } from './orcad-bundled-runtime'
import { OrcadInstanceLockError } from './orcad-instance-lock'
import { ProfileStateAccessError } from '../persistence/profile-state/profile-state-access'
import {
  HOST_MODE_EXIT_CONFIGURATION,
  HOST_MODE_EXIT_FAILED,
  HOST_MODE_EXIT_OK
} from '../../shared/host-mode-contract'

export const ORCAD_EXIT_OK = HOST_MODE_EXIT_OK
export const ORCAD_EXIT_FAILED = HOST_MODE_EXIT_FAILED
/** systemd RestartPreventExitStatus code: a configuration fault restarting cannot fix. */
export const ORCAD_EXIT_CONFIGURATION = HOST_MODE_EXIT_CONFIGURATION

/** Configuration faults cannot be repaired by a supervisor restart. */
export function resolveOrcadExitCode(error: unknown): number {
  return error instanceof OrcadInstanceLockError ||
    error instanceof OrcadBindAddressError ||
    error instanceof OrcadBundledRuntimeError ||
    error instanceof ProfileStateAccessError
    ? ORCAD_EXIT_CONFIGURATION
    : ORCAD_EXIT_FAILED
}
