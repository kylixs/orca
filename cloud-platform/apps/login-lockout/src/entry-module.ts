import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * U302: Node's ESM entry resolves symlinks, so `import.meta.url` is a realpath
 * while `argv[1]` is the literal path the caller typed. Realpath both sides
 * (symlinked release dirs `current -> repo`, `/tmp` -> `/private/tmp`, Windows
 * drive case / 8.3 names / junction) before comparing.
 */
function realpathOrNull(target: string): string | undefined {
  try {
    return realpathSync.native(target)
  } catch {
    return undefined
  }
}

export function isEntryModule(metaUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined) {
    return false
  }
  const selfPath = realpathOrNull(fileURLToPath(metaUrl))
  const entryPath = realpathOrNull(resolve(argv1))
  if (selfPath === undefined || entryPath === undefined) {
    return false
  }
  return pathToFileURL(selfPath).href === pathToFileURL(entryPath).href
}
