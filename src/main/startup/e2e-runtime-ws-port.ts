/**
 * `ORCA_E2E_RUNTIME_WS_PORT` pins the WS port for parallel E2E Electron instances,
 * which would otherwise race the default port. Returns undefined outside E2E.
 */
export function resolveE2EWsPort(env: NodeJS.ProcessEnv): number | undefined {
  if (!env.ORCA_E2E_USER_DATA_DIR) {
    return undefined
  }
  const requested = env.ORCA_E2E_RUNTIME_WS_PORT
  const port = requested === undefined ? 0 : Number(requested)
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid ORCA_E2E_RUNTIME_WS_PORT value: ${requested}`)
  }
  return port
}
