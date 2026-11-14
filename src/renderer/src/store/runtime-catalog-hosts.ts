import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'

/** The fields the all-host catalog loads need: which host, and whether it is cloud-backed. */
export type AllHostCatalogEnvironment = Pick<PublicKnownRuntimeEnvironment, 'id' | 'cloudProject'>

export async function listRuntimeEnvironmentsForAllHostLoad(): Promise<
  AllHostCatalogEnvironment[]
> {
  try {
    return (await window.api.runtimeEnvironments.list()) ?? []
  } catch (err) {
    console.warn('Failed to list runtime environments for all-host load:', err)
    return []
  }
}
