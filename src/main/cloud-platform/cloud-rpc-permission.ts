import type { CloudPermission } from './cloud-credential'

/**
 * Method → project permission for cloud sessions (design §7.3).
 *
 * The platform signs the caller's project permissions into the ticket; the host
 * executes that set and never recomputes group membership (it has no LDAP). A
 * method missing from this table is refused, so a newly added RPC cannot reach a
 * cloud session before someone decides which permission covers it.
 */

/** Admitted sessions may always introspect themselves (the workspace view calls this). */
const SESSION_METHODS: ReadonlySet<string> = new Set(['status.get', 'workspace.info'])

/** Prefixes granted by a project permission; the design groups git with terminal. */
const PREFIX_PERMISSIONS: readonly [string, CloudPermission][] = [
  ['terminal.', 'terminal'],
  ['git.', 'terminal'],
  ['agent.', 'agent'],
  ['agentSession.', 'agent'],
  ['agentProvider.', 'agent']
]

const READ_METHODS: ReadonlySet<string> = new Set([
  'files.read',
  'files.readDir',
  'files.readChunk',
  'files.stat',
  'files.search',
  'files.searchPaths',
  'files.list',
  'files.listAll',
  'files.listMarkdownDocuments',
  'files.pathsExist',
  'files.readPreview',
  'files.readDocPreview',
  // Panel actions: they only ask the host to show a file it could already read.
  'files.open',
  'files.openDiff',
  // Terminal artifacts and server-dir browsing address absolute paths; the path
  // guard refuses them for cloud sessions (CLOUD_FILE_UNBOUNDED_METHODS).
  'files.readTerminalArtifact',
  'files.readTerminalArtifactPreview',
  'files.browseServerDir',
  'files.resolveTerminalPath',
  'files.watch',
  'files.unwatch'
])

const WRITE_METHODS: ReadonlySet<string> = new Set([
  'files.write',
  'files.writeBase64',
  'files.writeTerminalArtifact',
  'files.createFile',
  'files.createDir',
  'files.createDirNoClobber',
  'files.rename',
  'files.copy',
  'files.delete',
  'files.commitUpload'
])

/** Exports: the download permission outranks the family that carries the method. */
const DOWNLOAD_METHODS: ReadonlySet<string> = new Set([
  'files.download',
  'files.downloadFolder',
  'terminal.exportArtifact',
  'browser.download',
  'browser.savePage'
])

/**
 * Methods that only ever touch the ticket's own project root. `open` is the
 * permission every admitted session carries; the path guard pins the argument.
 */
const PROJECT_METHODS: ReadonlySet<string> = new Set(['repo.add', 'project.provision'])

const WORKTREE_METHODS: ReadonlySet<string> = new Set([
  'worktree.create',
  'worktree.createManaged',
  'worktree.rm',
  'worktree.forceDeleteBranch',
  'worktree.show',
  // Repo-scoped catalog reads, needed to decide whether the user's checkout exists.
  'worktree.list',
  'worktree.detectedList'
])

export type CloudMethodAccess = CloudPermission | 'session' | null

export function cloudMethodAccess(method: string): CloudMethodAccess {
  if (SESSION_METHODS.has(method)) {
    return 'session'
  }
  if (DOWNLOAD_METHODS.has(method)) {
    return 'download'
  }
  if (READ_METHODS.has(method)) {
    return 'file:read'
  }
  if (WRITE_METHODS.has(method)) {
    return 'file:write'
  }
  if (WORKTREE_METHODS.has(method)) {
    return 'terminal'
  }
  if (PROJECT_METHODS.has(method)) {
    return 'open'
  }
  // Browser navigation is the panel's own permission; its exports are not.
  if (method.startsWith('browser.')) {
    return 'browser'
  }
  for (const [prefix, permission] of PREFIX_PERMISSIONS) {
    if (method.startsWith(prefix)) {
      return permission
    }
  }
  return null
}
