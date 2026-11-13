import { readdirSync } from 'node:fs'

/** FR-3.7: the first-level directories a developer may pick a project from. */

export const PROJECT_DIR_LIMIT = 200

/** The part of `readdirSync(…, { withFileTypes: true })` the listing needs. */
type DirectoryEntryReader = (
  path: string,
  options: { withFileTypes: true }
) => { name: string; isDirectory(): boolean }[]

/**
 * Reads the host's self-service root. A missing or unreadable root is an empty
 * list, never a failed heartbeat — the listing is a convenience, not a liveness
 * signal.
 */
export function listProjectDirs(
  projectsRoot: string | undefined,
  readdir: DirectoryEntryReader = readdirSync
): string[] {
  if (!projectsRoot || projectsRoot.trim() === '') {
    return []
  }
  let names: string[]
  try {
    names = readdir(projectsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
  return names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, PROJECT_DIR_LIMIT)
}
