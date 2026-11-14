import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * U36: a web bundle built without `VITE_EXPOSE_STORE=true` folds the e2e
 * oracles out at compile time, and the specs then fail on assertions that name
 * no cause (W13c-2 rebuilt out/web without the flag and B4 went silently red).
 *
 * `__webRuntimeSessionE2E` is installed only under `if (e2eConfig.exposeStore)`
 * (store/index.ts), so its presence in the built assets is the artifact-level
 * proof that the whole instrumented surface — `window.__store`, the
 * `window.__monacoEditorE2E` editor probe — survived the build.
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
    return readFileSync(path.join(assetsDir, entry), 'utf8').includes(WEB_STORE_ORACLE_MARKER)
  })
}
