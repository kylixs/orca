import type { AttachableCloudAdmission } from '../startup/cloud-runtime-attach'

/** What `startOrcadRpc` needs from the admission wiring. */
export type OrcadAdmissionAttach = (admission: AttachableCloudAdmission) => void

/** Fills the version admission enrols with, without overriding an explicit one. */
export function ensureOrcadAppVersion(env: NodeJS.ProcessEnv = process.env): void {
  env.ORCA_APP_VERSION ??= env.ORCA_VERSION ?? '0.0.0-orcad'
}

/**
 * Attach admission before `start`: no upgrade may be accepted before the runtime
 * is bound. A missing admission (non-cloud host) keeps the plain start path.
 */
export function startOrcadRpc(
  rpc: { start(): Promise<void> },
  admission: AttachableCloudAdmission | null,
  attach: OrcadAdmissionAttach
): Promise<void> {
  if (admission) {
    attach(admission)
  }
  return rpc.start()
}
