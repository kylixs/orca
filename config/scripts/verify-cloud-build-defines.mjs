#!/usr/bin/env node

// Asserts the cloud-platform build constants were substituted into the shipped
// bundles (W10 B-1, semantics updated by W11). Since the shell's sign-in entry
// is permanent in every build, the preload exposes the bridge unconditionally
// and no longer reads the constants at all — main owns the address resolution
// (cloud-build-flags.ts via cloud-platform-address.ts), so the build-injected
// platform address has to land in the main bundle. electron-vite merges each
// target's config separately, so a `define` that only covers `main` would still
// leave `typeof ORCA_DEFAULT_PLATFORM_URL` unsubstituted wherever a bundle
// reads the flags; that check stays on both targets as a canary for a future
// preload-side read, while every test stays green because tests stub the
// constants through a module seam.
//
// Runs after every full electron-vite build (run-electron-vite-build.mjs) and
// after the parallel target runner (run-electron-vite-targets-in-parallel.mjs —
// per-target children must not read a bundle another child is still writing).

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const CLOUD_BUILD_DEFINES = ['ORCA_DEFAULT_PLATFORM_URL', 'ORCA_MANAGED_BUILD']
export const MAIN_BUILD_DIR = join('out', 'main')
export const PRELOAD_BUILD_DIR = join('out', 'preload')

// Why `typeof NAME`: every read in src/shared/cloud-build-flags.ts is a
// typeof-guard, so this is the exact fingerprint of an unsubstituted constant,
// and it cannot false-positive on comments that mention the bare name in an
// unminified build.
function unsubstitutedReads(code) {
  return CLOUD_BUILD_DEFINES.filter((name) => new RegExp(`typeof\\s+\\(?${name}\\b`).test(code))
}

/**
 * Pure bundle audit so the gate stays testable without a real build. Each code
 * string is one built bundle file; `bakedDefaultUrl` is the value the build was
 * supposed to fold in (null when the build set none).
 */
export function auditCloudDefineBundles({ mainBundleCodes, preloadBundleCodes, bakedDefaultUrl }) {
  const problems = []
  for (const [target, codes] of [
    ['main', mainBundleCodes],
    ['preload', preloadBundleCodes]
  ]) {
    for (const [file, code] of Object.entries(codes)) {
      for (const name of unsubstitutedReads(code)) {
        problems.push(`${target}/${file} still reads the unsubstituted constant ${name}`)
      }
    }
  }
  // Why main only: the preload no longer reads the constants (W11), so requiring
  // the literal there would fail every build of an ordinary desktop install.
  if (
    bakedDefaultUrl &&
    !Object.values(mainBundleCodes).some((code) => code.includes(bakedDefaultUrl))
  ) {
    problems.push(
      `no main bundle contains the build-injected platform address (ORCA_DEFAULT_PLATFORM_URL)`
    )
  }
  return problems
}

function readJsBundles(dir) {
  const codes = {}
  let entries
  try {
    entries = readdirSync(dir, { recursive: true, withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.js')) {
      // Why relative to the target dir: the report names bundles as main/index.js.
      const file = join(entry.parentPath, entry.name)
      codes[file.slice(dir.length + 1)] = readFileSync(file, 'utf8')
    }
  }
  return codes
}

/** Returns 0 when both targets substituted the constants, 1 with a report otherwise. */
export function verifyCloudBuildDefines(root = process.cwd()) {
  const bakedDefaultUrl = process.env.ORCA_DEFAULT_PLATFORM_URL?.trim() || null
  const bundles = {
    main: readJsBundles(join(root, MAIN_BUILD_DIR)),
    preload: readJsBundles(join(root, PRELOAD_BUILD_DIR))
  }
  const missing = Object.entries(bundles)
    .filter(([, codes]) => codes === null || Object.keys(codes).length === 0)
    .map(([target]) => target)
  if (missing.length > 0) {
    console.error(`::error::no built bundles under ${missing.map((t) => `out/${t}`).join(', ')}`)
    return 1
  }
  const problems = auditCloudDefineBundles({
    mainBundleCodes: bundles.main,
    preloadBundleCodes: bundles.preload,
    bakedDefaultUrl
  })
  const scanned = Object.keys(bundles.main).length + Object.keys(bundles.preload).length
  if (problems.length === 0) {
    const suffix = bakedDefaultUrl ? ` with baked platform address ${bakedDefaultUrl}.` : '.'
    console.log(`Cloud build defines verified across ${scanned} bundle(s)${suffix}`)
    return 0
  }
  console.error('::error::cloud build defines did not reach every electron-vite target:')
  for (const problem of problems) {
    console.error(`  ${problem}`)
  }
  console.error(`electron-vite merges each target separately — see ORCA_CLOUD_PLATFORM_DEFINES.`)
  return 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(verifyCloudBuildDefines())
}
