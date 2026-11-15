import {
  isCloudSessionRuntimeEnvironment,
  type PublicKnownRuntimeEnvironment
} from '../../../shared/runtime-environments'

/** The fields the cloud verdict reads; partial owner-state rows ({ id }) qualify. */
type CloudSessionEnvironmentRow = Pick<PublicKnownRuntimeEnvironment, 'id' | 'cloudProject'> & {
  cloudLoginRequired?: boolean
}

/**
 * Whether a runtime environment id names a cloud (ticket) session, whose host
 * refuses the desktop integration families (`github.*`, `skills.*`). A missing
 * row — or a store whose environment slice has not landed (partial test stores) —
 * is not a cloud session: callers proceed and let a real refusal surface.
 */
export function isCloudSessionEnvironmentId(
  environments: readonly CloudSessionEnvironmentRow[] | undefined,
  environmentId: string | null | undefined
): boolean {
  if (!environmentId || !environments) {
    return false
  }
  const environment = environments.find((entry) => entry.id === environmentId)
  return environment !== undefined && isCloudSessionRuntimeEnvironment(environment)
}
