// Ambient declarations for compile-time constants substituted by the build
// configs. The telemetry constants live in electron-vite's main `define`
// block; contributor / `pnpm dev` / third-party builds substitute literal
// `null`, which `IS_OFFICIAL_BUILD` in `src/main/telemetry/client.ts`
// evaluates to `false` at module load — such builds console-mirror only.
//
// The CI release workflow (and only the CI release workflow) provides real
// values via GitHub Actions secrets. There is no runtime env-var fallback;
// the substitution happens at compile time so a curious contributor cannot
// spoof transmission with a shell export.
//
declare const ORCA_BUILD_IDENTITY: 'stable' | 'rc' | null
declare const ORCA_POSTHOG_WRITE_KEY: string | null

// Cloud-platform build parameters (M119/W10), substituted from the build
// environment of the same names. `ORCA_DEFAULT_PLATFORM_URL` is the platform
// address an enterprise distribution bakes in, so an installed client reaches
// the login screen with no environment variable; `ORCA_MANAGED_BUILD` pins that
// address against user changes. Both are read through
// `src/shared/cloud-build-flags.ts` (main and preload) and fall back to
// null/false in contributor/dev builds.
declare const ORCA_DEFAULT_PLATFORM_URL: string | null
declare const ORCA_MANAGED_BUILD: boolean

// Diagnostic-bundle upload endpoint for Mode 3 (telemetry-error-tracking.md
// §Endpoint contract). Substituted by CI; `null` in contributor builds, at
// which point the upload IPC handler returns "endpoint not configured"
// rather than POSTing to a placeholder. The dev escape hatch is the
// `ORCA_DIAGNOSTICS_TOKEN_URL` env var, which env wins so a developer can
// point a packaged build at a staging server without re-running the
// release pipeline.
declare const ORCA_DIAGNOSTICS_TOKEN_URL: string | null
