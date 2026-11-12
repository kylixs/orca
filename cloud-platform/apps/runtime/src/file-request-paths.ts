import { isAbsolute, normalize, sep } from 'node:path'

/**
 * Real Orca addresses files as `{ worktree, relativePath }`, not as one
 * project-absolute `path`. A client written against a different shape would pass
 * review here and then fail on the real runtime, so the simulator accepts exactly
 * the real contract and rejects anything else loudly.
 */

export type FileRoots = { projectRoot: string; workspaceRoot: string }

export type FileRequestPath =
  | { ok: true; absolute: string }
  | { ok: false; code: string; message: string }

function bad(code: string, message: string): FileRequestPath {
  return { ok: false, code, message }
}

/** Write targets must be the caller's own worktree; reads may use the shared project root. */
export function resolveFileRequestPath(
  roots: FileRoots,
  params: Record<string, unknown>,
  mode: 'read' | 'write'
): FileRequestPath {
  if (typeof params.path === 'string') {
    // The old simulator shape. Failing loudly beats serving a client the real host rejects.
    return bad('MISSING_RELATIVE_PATH', '使用 worktree + relativePath 寻址，而不是绝对 path。')
  }
  const worktree = params.worktree
  const relativePath = params.relativePath
  if (typeof relativePath !== 'string' || relativePath === '') {
    return bad('MISSING_RELATIVE_PATH', '缺少 relativePath。')
  }
  if (typeof worktree !== 'string' || worktree === '') {
    return bad('MISSING_WORKTREE', '缺少 worktree 选择器。')
  }
  if (isAbsolute(relativePath) || /^[A-Za-z]:/.test(relativePath)) {
    return bad('PATH_OUTSIDE_ROOT', 'relativePath 必须是相对路径。')
  }
  let root: string
  if (worktree === roots.workspaceRoot) {
    root = roots.workspaceRoot
  } else if (worktree === roots.projectRoot) {
    if (mode === 'write') {
      return bad('PATH_OUTSIDE_ROOT', '写操作只能落在本人工作区内。')
    }
    root = roots.projectRoot
  } else {
    return bad('WORKTREE_NOT_FOUND', '未知的工作区选择器。')
  }
  const absolute = normalize(`${root}${sep}${relativePath}`)
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`
  if (absolute !== root && !absolute.startsWith(prefix)) {
    return bad('PATH_OUTSIDE_ROOT', '路径超出项目或工作区范围。')
  }
  return { ok: true, absolute }
}
