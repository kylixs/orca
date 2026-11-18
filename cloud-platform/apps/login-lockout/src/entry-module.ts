import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * U302/U304: Node's ESM entry realpaths `import.meta.url` while `argv[1]` is
 * the literal path the caller typed. Realpath both sides so a symlink on either
 * one (`current -> repo`, `/tmp` -> `/private/tmp`, Windows junction) still
 * compares equal. `fileURLToPath` stays inside the try so a non-`file:` metaUrl
 * is "not this entry" instead of `ERR_INVALID_URL_SCHEME`.
 */
function realpathSelfOrNull(metaUrl: string): string | undefined {
  try {
    return realpathSync.native(fileURLToPath(metaUrl))
  } catch {
    return undefined
  }
}

function realpathArgvOrNull(argv1: string): string | undefined {
  try {
    return realpathSync.native(resolve(argv1))
  } catch {
    return undefined
  }
}

export function isEntryModule(metaUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined) {
    return false
  }
  const selfPath = realpathSelfOrNull(metaUrl)
  const entryPath = realpathArgvOrNull(argv1)
  if (selfPath === undefined || entryPath === undefined) {
    return false
  }
  return pathToFileURL(selfPath).href === pathToFileURL(entryPath).href
}
