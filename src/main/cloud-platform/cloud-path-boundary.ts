import { realpathSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'

/**
 * Workspace boundary for cloud sessions (design §8.3 step 4, AC-11, AC-27).
 *
 * The ticket names a project root and a per-user workspace root, and the host has
 * to enforce both: the client controls the worktree selector and the relative
 * path, so without this a session with `file:read` could name any worktree on the
 * machine and one with `file:write` could write into it.
 *
 * Reads are allowed anywhere under the project root (teammates share source);
 * writes only under this user's own workspace root. Both are checked after
 * symlink resolution, so a link inside the project cannot point out of it.
 */

export type CloudPathRoots = { projectRoot: string; workspaceRoot: string }

export type CloudPathDecision = { ok: true } | { ok: false; reason: string; message: string }

function normalizeRoot(root: string): string {
  // Why realpath: the project root is often itself a symlink (e.g. /srv -> /data),
  // and comparing an unresolved root against a resolved candidate rejects everything.
  try {
    return realpathSync(root)
  } catch {
    return root
  }
}

export function isWithinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * Resolves the real location of a path that may not exist yet (a file about to be
 * created): resolve the nearest existing ancestor and re-append the remainder, so
 * a symlinked parent is still followed.
 */
export function resolveRealPath(candidate: string): string {
  try {
    return realpathSync(candidate)
  } catch {
    let prefix = candidate
    let suffix = ''
    for (;;) {
      const cut = Math.max(prefix.lastIndexOf(sep), prefix.lastIndexOf('/'))
      if (cut <= 0) {
        return candidate
      }
      suffix = `${prefix.slice(cut)}${suffix}`
      prefix = prefix.slice(0, cut)
      try {
        return `${realpathSync(prefix)}${suffix}`
      } catch {
        // Keep walking up: the parent may be the part that does not exist yet.
      }
    }
  }
}

/** The worktree itself must live inside the project the ticket names. */
export function checkCloudWorktreeScope(
  roots: CloudPathRoots,
  worktreePath: string
): CloudPathDecision {
  if (isWithinRoot(normalizeRoot(roots.projectRoot), resolveRealPath(worktreePath))) {
    return { ok: true }
  }
  return {
    ok: false,
    reason: 'project_scope',
    message: 'This worktree is outside the project this cloud session was granted.'
  }
}

/** A single read or write target, resolved through symlinks. */
export function checkCloudTargetScope(
  roots: CloudPathRoots,
  access: 'read' | 'write',
  targetPath: string
): CloudPathDecision {
  const root = normalizeRoot(access === 'write' ? roots.workspaceRoot : roots.projectRoot)
  if (isWithinRoot(root, resolveRealPath(targetPath))) {
    return { ok: true }
  }
  return access === 'write'
    ? {
        ok: false,
        reason: 'workspace_scope',
        message: 'Writes are limited to your own workspace root inside this project.'
      }
    : {
        ok: false,
        reason: 'project_scope',
        message: 'That file is outside the project this cloud session was granted.'
      }
}
