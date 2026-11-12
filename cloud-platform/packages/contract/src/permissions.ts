import type { Permission } from './credential.ts'

export type MethodRule = {
  /** Exact method name or prefix ending with '.' */
  method: string
  permission: Permission | null
  /** Export-class methods never allowed under a managed project. */
  exportClass?: boolean
}

/**
 * Method → permission mapping. Unknown methods are denied by the caller, so a
 * new upstream Orca method cannot inherit access automatically.
 */
export const METHOD_RULES: MethodRule[] = [
  { method: 'files.read', permission: 'file:read' },
  { method: 'files.readDir', permission: 'file:read' },
  { method: 'files.readChunk', permission: 'file:read' },
  { method: 'files.stat', permission: 'file:read' },
  { method: 'files.searchPaths', permission: 'file:read' },
  { method: 'files.readPreview', permission: 'file:read' },
  { method: 'files.readDocPreview', permission: 'file:read' },
  { method: 'files.write', permission: 'file:write' },
  { method: 'files.writeBase64', permission: 'file:write' },
  { method: 'files.createFile', permission: 'file:write' },
  { method: 'files.rename', permission: 'file:write' },
  { method: 'files.copy', permission: 'file:write' },
  { method: 'files.delete', permission: 'file:write' },
  { method: 'files.commitUpload', permission: 'file:write' },
  { method: 'files.download', permission: 'download', exportClass: true },
  { method: 'files.downloadFolder', permission: 'download', exportClass: true },
  { method: 'terminal.exportArtifact', permission: 'download', exportClass: true },
  { method: 'pty.', permission: 'terminal' },
  { method: 'terminal.', permission: 'terminal' },
  { method: 'agent.', permission: 'agent' },
  { method: 'agentSession.', permission: 'agent' },
  { method: 'git.', permission: 'terminal' },
  { method: 'worktree.create', permission: 'terminal' },
  { method: 'worktree.remove', permission: 'terminal' },
  // Managed worktree creation: path is constrained by the credential's workspaceRoot.
  { method: 'worktree.createManaged', permission: 'terminal' },
  { method: 'terminalArtifact.', permission: 'terminal' },
  { method: 'agentProvider.', permission: 'agent' },
  // Export rules must precede the browser.* prefix rule: first match wins.
  { method: 'browser.download', permission: 'download', exportClass: true },
  { method: 'browser.savePage', permission: 'download', exportClass: true },
  { method: 'browser.', permission: 'browser' },
  // Explicitly registered introspection only — a bare prefix would auto-grant future methods.
  { method: 'sessions.whoami', permission: null },
  { method: 'sessions.list', permission: null },
  { method: 'workspace.info', permission: null }
]

export type MethodDecision =
  | { allow: true; permission: Permission | null }
  | { allow: false; code: 'METHOD_NOT_REGISTERED' | 'PERMISSION_MISSING' | 'EXPORT_DENIED' }

export function decideMethod(
  method: string,
  perms: readonly Permission[],
  downloadPolicy: 'deny' | 'allow'
): MethodDecision {
  const rule = METHOD_RULES.find((r) =>
    r.method.endsWith('.') ? method.startsWith(r.method) : r.method === method
  )
  if (!rule) return { allow: false, code: 'METHOD_NOT_REGISTERED' }
  if (rule.exportClass && downloadPolicy === 'deny') {
    return { allow: false, code: 'EXPORT_DENIED' }
  }
  if (rule.permission && !perms.includes(rule.permission)) {
    return { allow: false, code: 'PERMISSION_MISSING' }
  }
  return { allow: true, permission: rule.permission }
}

/** True when `target` resolves inside `root` after normalisation. */
function segments(p: string): string[] {
  const parts: string[] = []
  for (const segment of p.replaceAll('\\', '/').split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      parts.pop()
      continue
    }
    parts.push(segment)
  }
  return parts
}

function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)
}

function driveOf(p: string): string | null {
  const match = p.match(/^([A-Za-z]):[\\/]/)
  return match ? match[1].toLowerCase() : null
}

/**
 * Lexical containment for project-absolute paths. Handles both POSIX and
 * Windows separators and rejects cross-drive escapes (path.relative returns an
 * absolute path for `C:\root` → `D:\evil`, which a naive check would accept).
 */
export function isInsideRoot(root: string, target: string): boolean {
  if (!isAbsolutePath(root) || !isAbsolutePath(target)) return false
  const rootDrive = driveOf(root)
  const targetDrive = driveOf(target)
  if (rootDrive !== targetDrive) return false
  const rootParts = segments(root)
  const targetParts = segments(target)
  if (targetParts.length < rootParts.length) return false
  return rootParts.every((part, i) => targetParts[i] === part)
}

export function requiresWritePath(method: string): boolean {
  return (
    method.startsWith('files.write') ||
    method.startsWith('files.createFile') ||
    method.startsWith('files.rename') ||
    method.startsWith('files.copy') ||
    method.startsWith('files.delete') ||
    method.startsWith('files.commitUpload') ||
    method.startsWith('worktree.') ||
    method === 'browser.savePage'
  )
}

/** Methods whose path parameters are not named `path`; all listed values are write targets. */
export const MULTI_PATH_WRITE_PARAMS: Record<string, string[]> = {
  'files.rename': ['from', 'to', 'oldPath', 'newPath'],
  'files.copy': ['from', 'to', 'sourcePath', 'targetPath']
}
