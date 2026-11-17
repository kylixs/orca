/**
 * The headless host entry (`orca-ide --host-mode`) and the exit codes a supervisor reads.
 * Values are shared because the CLI and orcad both own one end of the same contract.
 */
export const HOST_MODE_FLAG = 'host-mode'
export const HOST_MODE_PREFLIGHT_FLAG = 'preflight'

export const HOST_MODE_EXIT_OK = 0
export const HOST_MODE_EXIT_FAILED = 1
/** Configuration/runtime fault a supervisor restart cannot repair (systemd EX_CONFIG). */
export const HOST_MODE_EXIT_CONFIGURATION = 78

export const HOST_MODE_REQUIRED_ENV = [
  'ORCA_CLOUD_API_URL',
  'ORCA_CLOUD_HOST_TOKEN',
  'ORCA_CLOUD_HOST_NAME'
] as const

/** Missing cloud settings, or null when this host could register. Reads env only. */
export function getHostModeConfigError(env: NodeJS.ProcessEnv): string | null {
  const missing = HOST_MODE_REQUIRED_ENV.filter((name) => !env[name]?.trim())
  return missing.length > 0 ? `host mode requires ${missing.join(', ')}` : null
}

export type HostModePreflightCheckId = 'config' | 'runtime'

/** One preflight verdict. `detail` is a human-readable cause, never a credential. */
export type HostModePreflightCheck = {
  id: HostModePreflightCheckId
  ok: boolean
  detail: string | null
}

/** Printed by `--preflight`; a supervisor reads `ok`, never a log line. */
export type HostModePreflightResult = {
  ok: boolean
  checks: HostModePreflightCheck[]
}

export function hostModePreflightResult(
  checks: readonly HostModePreflightCheck[]
): HostModePreflightResult {
  return { ok: checks.every((check) => check.ok), checks: [...checks] }
}

export function formatHostModePreflightResult(result: HostModePreflightResult): string {
  return JSON.stringify(result)
}
