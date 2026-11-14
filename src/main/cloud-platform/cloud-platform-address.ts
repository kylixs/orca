import { cleanCloudServiceUrl } from '../../shared/cloud-service-url'
import { builtInDefaultPlatformUrl, isManagedOrcaBuild } from '../../shared/cloud-build-flags'

/**
 * Which platform address this client talks to (M119/W10). Priority is
 * runtime env > last successful login > build-injected default > none, so an
 * installed client starts with no environment variable at all and never blocks
 * on one. `ORCA_DEFAULT_PLATFORM_URL` and `ORCA_MANAGED_BUILD` are compile-time
 * constants (electron.vite define): an enterprise distribution bakes its
 * platform in, and a managed build pins it against user changes.
 */

export type CloudPlatformAddressSource = 'env' | 'memory' | 'build' | 'none'

export type CloudPlatformAddress = {
  /** The address to prefill and to sign in with; null means the user types one. */
  apiUrl: string | null
  source: CloudPlatformAddressSource
  /** A managed build keeps its pinned address; the login form cannot change it. */
  locked: boolean
}

/**
 * Resolves the address without ever throwing: an unusable value is skipped in
 * favour of the next tier, and a client with nothing resolves to null. A managed
 * build never reads the memory tier — a remembered address would otherwise pin
 * the client to a platform its administrator did not choose.
 */
export function resolveCloudPlatformAddress(input: {
  envApiUrl?: string
  memoryApiUrl?: string | null
  packaged?: boolean
}): CloudPlatformAddress {
  const allowLoopbackHttp = input.packaged !== true
  const managed = isManagedOrcaBuild()
  const clean = (value: string | null | undefined): string | null =>
    cleanCloudServiceUrl(value ?? undefined, allowLoopbackHttp)

  const fromEnv = clean(input.envApiUrl)
  const fromMemory = clean(input.memoryApiUrl)
  const fromBuild = clean(builtInDefaultPlatformUrl())
  // Why memory is skipped on a managed build: the pin must come from the build,
  // not from whatever this OS account last signed in to.
  const tiers: [CloudPlatformAddressSource, string | null][] = managed
    ? [
        ['env', fromEnv],
        ['build', fromBuild]
      ]
    : [
        ['env', fromEnv],
        ['memory', fromMemory],
        ['build', fromBuild]
      ]
  const resolved = tiers.find(([, value]) => value !== null)
  const apiUrl = resolved?.[1] ?? null

  return {
    apiUrl,
    source: resolved?.[0] ?? 'none',
    // Why null-check apiUrl: a locked build with no resolvable address must still
    // let the user type one rather than dead-end the login screen.
    locked: managed && apiUrl !== null
  }
}

/**
 * The address a sign-in uses. A managed build pins it; otherwise the typed
 * address wins and an unusable one is rejected rather than silently swapped for
 * a different platform. Null without a typed value means the client has no
 * address at all yet.
 */
export function loginPlatformAddress(
  address: CloudPlatformAddress,
  typedUrl: string | undefined,
  packaged: boolean
):
  | { ok: true; apiUrl: string }
  | { ok: false; code: 'PLATFORM_ADDRESS_REQUIRED' | 'PLATFORM_ADDRESS_INVALID' } {
  if (address.locked) {
    return address.apiUrl === null
      ? { ok: false, code: 'PLATFORM_ADDRESS_REQUIRED' }
      : { ok: true, apiUrl: address.apiUrl }
  }
  const typed = typedUrl?.trim()
  if (!typed) {
    return address.apiUrl === null
      ? { ok: false, code: 'PLATFORM_ADDRESS_REQUIRED' }
      : { ok: true, apiUrl: address.apiUrl }
  }
  const cleaned = cleanCloudServiceUrl(typed, !packaged)
  return cleaned === null
    ? { ok: false, code: 'PLATFORM_ADDRESS_INVALID' }
    : { ok: true, apiUrl: cleaned }
}
