import type { CloudAgentConfig } from './cloud-agent-config'

/** Cloud mode is opt-in; half-configured is an operator error, not a silent skip. */
export function cloudAgentConfigFromEnv(env: NodeJS.ProcessEnv): CloudAgentConfig | null {
  const apiUrl = env.ORCA_CLOUD_API_URL
  if (!apiUrl) {
    return null
  }
  const internalToken = env.ORCA_CLOUD_INTERNAL_TOKEN
  const hostId = env.ORCA_CLOUD_HOST_ID
  const hostName = env.ORCA_CLOUD_HOST_NAME
  const missing = [
    ['ORCA_CLOUD_INTERNAL_TOKEN', internalToken],
    ['ORCA_CLOUD_HOST_ID', hostId],
    ['ORCA_CLOUD_HOST_NAME', hostName]
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name)
  if (missing.length > 0) {
    throw new Error(`Cloud mode is incomplete: missing ${missing.join(', ')}`)
  }
  return {
    apiUrl,
    internalUrl: env.ORCA_CLOUD_INTERNAL_URL,
    internalToken: internalToken!,
    hostId: hostId!,
    hostName: hostName!
  }
}
