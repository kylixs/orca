/**
 * Worktree RPCs for cloud sessions (design §8.3 / T301a).
 *
 * `worktree.create` takes no target path: the host derives one from its own
 * workspace settings, so a cloud session could create a checkout of any repo it
 * names, on any path the host prefers — outside the ticket's workspaceRoot and
 * therefore unusable, but also outside every boundary M36/M37 enforce. The design
 * answers this with `worktree.createManaged` (implemented in M39), so plain
 * creation stays refused rather than left open.
 *
 * Everything else is deny-by-default, because most of these calls are fleet-wide
 * (`ps`, `activate`, `set`) or carry no single worktree to check. The two catalog
 * reads that name a repo are allowed but checked against the project.
 */

/** Managed creation names its own root, so it is checked as an absolute target. */
export const MANAGED_CREATE_METHOD = 'worktree.createManaged'

export type CloudWorktreeAccess =
  | { kind: 'read' }
  | { kind: 'write' }
  | { kind: 'deny'; message: string }

const READ_METHODS: ReadonlySet<string> = new Set(['worktree.show'])

/**
 * Catalog reads that take a repo instead of a worktree. Allowed because opening a
 * project needs to know whether the user's checkout already exists (design §8.3
 * step 3); the repo is checked against the project, so the answer stays scoped.
 */
const REPO_SCOPED_READ_METHODS: ReadonlySet<string> = new Set([
  'worktree.list',
  'worktree.detectedList'
])

export function isCloudRepoScopedWorktreeMethod(method: string): boolean {
  return REPO_SCOPED_READ_METHODS.has(method)
}

const WRITE_METHODS: ReadonlySet<string> = new Set([
  'worktree.rm',
  'worktree.forceDeleteBranch',
  // Managed creation: the root it names must stay inside the ticket's workspace.
  MANAGED_CREATE_METHOD
])

const CREATE_MESSAGE =
  'Git worktree creation from a cloud session requires managed creation, which this host does not offer yet. Open an existing workspace instead.'

export function cloudWorktreeAccessOf(method: string): CloudWorktreeAccess | null {
  if (!method.startsWith('worktree.')) {
    return null
  }
  if (READ_METHODS.has(method) || REPO_SCOPED_READ_METHODS.has(method)) {
    return { kind: 'read' }
  }
  if (WRITE_METHODS.has(method)) {
    return { kind: 'write' }
  }
  if (method === 'worktree.create') {
    return { kind: 'deny', message: CREATE_MESSAGE }
  }
  return {
    kind: 'deny',
    message: `Method '${method}' is not available to cloud sessions.`
  }
}
