import { realpath, lstat } from 'node:fs/promises'
import { dirname, join, normalize, relative, sep } from 'node:path'

/**
 * Resolves symlinks as far as the path exists. For a not-yet-created target we
 * resolve its parent, so a symlinked parent directory cannot smuggle a write
 * outside the root.
 */
export async function resolveRealTarget(target: string): Promise<string> {
  try {
    return await realpath(target)
  } catch {
    const parent = dirname(target)
    if (parent === target) return normalize(target)
    return join(await resolveRealTarget(parent), target.slice(parent.length))
  }
}

/**
 * Containment check on fully resolved paths. Uses path.relative rather than a
 * string prefix: `/root/abc` must not be treated as inside `/root/ab`.
 */
export function isInsideRealRoot(realRoot: string, realTarget: string): boolean {
  const rel = relative(realRoot, realTarget)
  if (rel === '') return true
  return !rel.startsWith('..') && !rel.startsWith(`..${sep}`) && !rel.includes(`..${sep}`)
}

export async function assertInsideRoot(realRoot: string, candidate: string): Promise<string> {
  const realTarget = await resolveRealTarget(candidate)
  if (!isInsideRealRoot(realRoot, realTarget)) {
    throw Object.assign(new Error('path escapes root after symlink resolution'), {
      code: 'PATH_OUTSIDE_ROOT'
    })
  }
  return realTarget
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target)
    return true
  } catch {
    return false
  }
}
