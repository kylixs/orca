/**
 * Compile-time cloud-platform switches shared by the main process and the
 * preload exposure predicate. electron.vite substitutes both from the build
 * environment (see its `define` block and src/types/build-constants.d.ts):
 * `ORCA_DEFAULT_PLATFORM_URL` is the platform address an enterprise distribution
 * bakes in, `ORCA_MANAGED_BUILD` pins that address against user changes. Both
 * fall back to their unset values in contributor/dev builds.
 */

// Module-scoped on purpose: the names must appear as free identifiers so the
// bundler's define substitution can bake them in at build time.
declare const ORCA_DEFAULT_PLATFORM_URL: string | null
declare const ORCA_MANAGED_BUILD: boolean

/** What a test wants the build constants to say; null restores the real ones. */
type CloudBuildFlagOverrides = {
  defaultUrl?: string | null
  managed?: boolean
}

let testOverrides: CloudBuildFlagOverrides | null = null

/**
 * Test seam for the constants: a bundler normally substitutes them, so tests
 * name their values here instead of reaching around the module.
 */
export function stubCloudBuildFlagsForTests(overrides: CloudBuildFlagOverrides | null): void {
  testOverrides = overrides
}

/** The build-injected default platform address; null when the build set none. */
export function builtInDefaultPlatformUrl(): string | null {
  if (testOverrides) {
    return testOverrides.defaultUrl ?? null
  }
  // oxlint-disable-next-line unicorn/no-typeof-undefined -- SAFETY: the bundler substitutes this constant; under vitest (no bundler) the name does not exist, so typeof guards the reference.
  if (typeof ORCA_DEFAULT_PLATFORM_URL !== 'undefined') {
    return ORCA_DEFAULT_PLATFORM_URL
  }
  return null
}

/** Compile-time managed-build switch; false in every non-managed build. */
export function isManagedOrcaBuild(): boolean {
  if (testOverrides) {
    return testOverrides.managed ?? false
  }
  // oxlint-disable-next-line unicorn/no-typeof-undefined -- SAFETY: the bundler substitutes this constant; under vitest (no bundler) the name does not exist, so typeof guards the reference.
  if (typeof ORCA_MANAGED_BUILD !== 'undefined') {
    return ORCA_MANAGED_BUILD
  }
  return false
}

/**
 * True when this client carries the cloud platform entry at all. Ordinary
 * desktop builds set none of these and keep their behavior: no bridge, no login
 * screen. The env tier stays truthy-string, exactly the signal cloud installs
 * used before the build-injected default existed.
 */
export function isCloudPlatformBuild(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    Boolean(env.ORCA_CLOUD_API_URL) || builtInDefaultPlatformUrl() !== null || isManagedOrcaBuild()
  )
}
