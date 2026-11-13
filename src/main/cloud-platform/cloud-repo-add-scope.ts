import { isAbsolute } from 'node:path'
import { resolveRealPath, type CloudPathDecision, type CloudPathRoots } from './cloud-path-boundary'

/**
 * `repo.add` is how a cloud project becomes a sidebar row, so it is the one
 * method a session needs under the `open` permission. The client names the path,
 * so the guard pins it to the project root the ticket was signed for — anything
 * else would let a session register a repo on the host it was never granted.
 */

export const PROJECT_ROOT_METHODS: ReadonlySet<string> = new Set(['repo.add'])

function stringField(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object' || !(key in value)) {
    return null
  }
  const field: unknown = key in value ? Reflect.get(value, key) : undefined
  return typeof field === 'string' ? field : null
}

export function checkProjectRootTarget(args: {
  roots: CloudPathRoots
  method: string
  params: unknown
}): CloudPathDecision {
  const path = stringField(args.params, 'path')
  const kind = stringField(args.params, 'kind')
  if (path === null || (kind !== null && kind !== 'git')) {
    return {
      ok: false,
      reason: 'repo_add_incomplete',
      message: `Method '${args.method}' can only register the project's own git root.`
    }
  }
  if (!isAbsolute(path)) {
    return { ok: false, reason: 'absolute_path', message: 'Project paths must be absolute.' }
  }
  // Why realpath: a symlink to the project would resolve inside it and register
  // under a path the host's own rows do not use.
  if (resolveRealPath(path) !== resolveRealPath(args.roots.projectRoot)) {
    return {
      ok: false,
      reason: 'project_scope',
      message: 'A cloud session can only register the project it was granted.'
    }
  }
  return { ok: true }
}
