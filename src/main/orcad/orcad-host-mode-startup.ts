import type { CloudHostEnrolmentFailure } from '../cloud-platform/cloud-host-enrollment'
import type { CloudRuntimeAdmission } from '../startup/cloud-runtime-admission'
import { awaitHostModeEnrolment, hostModeFailurePhase } from './host-mode-enrolment'
import {
  recordHostModeEnrolmentFailure,
  watchHostModeHeartbeat,
  type HostModeStateContext
} from './orcad-host-mode-state'
import type { OrcadRuntimeCleanup } from './orcad-runtime-lifetime'

/** Startup gate: persist the fatal verdict first, then throw for the entry's exit mapping. */
export function hostModeStartupGate(input: {
  admission: CloudRuntimeAdmission | null
  hostMode: boolean
  state: HostModeStateContext | null
}): Promise<void> {
  return awaitHostModeEnrolment(input.admission, input.hostMode, (failure) => {
    if (input.state) {
      recordHostModeEnrolmentFailure(
        input.state,
        failureState(failure),
        input.admission?.host()?.hostId ?? null
      )
    }
  })
}

function failureState(failure: CloudHostEnrolmentFailure): {
  code: string
  retryable: boolean
  phase: ReturnType<typeof hostModeFailurePhase>
} {
  return {
    code: failure.code,
    retryable: failure.retryable,
    phase: hostModeFailurePhase(failure.code)
  }
}

/** Post-online watcher: a terminal heartbeat verdict stops the process via `onTerminal`. */
export function installHostModeHeartbeatWatch(input: {
  state: HostModeStateContext | null
  admission: CloudRuntimeAdmission | null
  registerCleanup: (cleanup: OrcadRuntimeCleanup) => void
  onTerminal: (exitCode: number) => void
}): void {
  if (!input.state || !input.admission) {
    return
  }
  input.registerCleanup(
    watchHostModeHeartbeat({
      context: input.state,
      admission: input.admission,
      onTerminal: input.onTerminal
    })
  )
}

export type HostModeFatalRelay = {
  notify: (exitCode: number) => void
  register: (listener: (exitCode: number) => void) => void
}

/** Connects the runtime's terminal verdict to a listener the entry installs after startup. */
export function createHostModeFatalRelay(): HostModeFatalRelay {
  let listener: ((exitCode: number) => void) | null = null
  return {
    notify: (exitCode) => listener?.(exitCode),
    register: (next) => {
      listener = next
    }
  }
}
