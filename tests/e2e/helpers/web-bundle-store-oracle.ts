import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * U36: a web bundle built without `VITE_EXPOSE_STORE=true` folds the e2e
 * oracles out at compile time, and the specs then fail on assertions that name
 * no cause (W13c-2 rebuilt out/web without the flag and B4 went silently red).
 *
 * U75: the marker string alone is not proof — `__webRuntimeSessionE2E` survives
 * minification as dead code behind `if (e2eConfig.exposeStore)` even when the
 * build lost the flag, so a flag-lost bundle passed this gate and B4/B5 went
 * silently red again. The compiled flag itself is the artifact-level proof that
 * the instrumented surface (`window.__store`, `__paneManagers`,
 * `window.__monacoEditorE2E`) is live.
 */
export const WEB_STORE_ORACLE_MARKER = '__webRuntimeSessionE2E'

export function webBundleExposesStore(outWebDir: string): boolean {
  const assetsDir = path.join(outWebDir, 'assets')
  let entries: string[]
  try {
    entries = readdirSync(assetsDir)
  } catch {
    return false
  }
  return entries.some((entry) => {
    if (!entry.endsWith('.js')) {
      return false
    }
    return compiledExposeStoreActive(readFileSync(path.join(assetsDir, entry), 'utf8'))
  })
}

/** True when a build artifact compiles the e2e exposeStore flag to active. */
function compiledExposeStoreActive(source: string): boolean {
  if (/exposeStore:!0\b/.test(source)) {
    return true
  }
  for (const match of source.matchAll(/\bexposeStore:(\w+)\b/g)) {
    const flag = match[1].replace(/\$/g, '\\$')
    // The same variable is assigned `!1` when the flag was lost at build time.
    if (
      new RegExp(`\\b${flag}=!0\\b`).test(source) &&
      !new RegExp(`\\b${flag}=!1\\b`).test(source)
    ) {
      return true
    }
  }
  return false
}
