import type { Project, Store } from './store.ts'

/**
 * Archived projects keep their row for audit and revocation, but they no longer
 * own their key or directory: an archive must free both for a later create.
 */

export function projectKeyTaken(
  store: Pick<Store, 'projectsByKey'>,
  key: string,
  excludeProjectId?: string
): boolean {
  const existing = store.projectsByKey.get(key)
  if (!existing || existing.status === 'archived') {
    return false
  }
  return existing.id !== excludeProjectId
}

export function projectPathTaken(
  store: Pick<Store, 'projects'>,
  path: string,
  excludeProjectId?: string
): boolean {
  for (const project of store.projects.values()) {
    if (project.id === excludeProjectId || project.status === 'archived') {
      continue
    }
    if (project.path === path) {
      return true
    }
  }
  return false
}

export function isProjectCreator(project: Project, username: string): boolean {
  return project.createdBy === username
}
