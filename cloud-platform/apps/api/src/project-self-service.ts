import { validateProjectPath } from '../../../packages/contract/src/project-path.ts'
import type { Host, Project } from './store.ts'

/** Developer self-service project policy: host selection, derived path, quota. */

export const SELF_SERVICE_PROJECT_LIMIT = 20

export type SelfServiceHostSelection =
  | { ok: true; host: Host }
  | {
      ok: false
      status: 400 | 409
      code: string
      message: string
      details?: Record<string, unknown>
    }

export function selectSelfServiceHost(args: {
  hosts: Iterable<Host>
  /** Empty means the platform picks the only eligible host. */
  hostId: string
  isOnline: (host: Host) => boolean
}): SelfServiceHostSelection {
  const hosts = [...args.hosts]
  if (args.hostId !== '') {
    const host = hosts.find((entry) => entry.id === args.hostId)
    if (!host) {
      return { ok: false, status: 400, code: 'HOST_NOT_FOUND', message: '主机不存在。' }
    }
    if (!host.projectsRoot) {
      return {
        ok: false,
        status: 409,
        code: 'HOST_NOT_PROVISIONABLE',
        message: '该主机未声明可创建项目的目录。'
      }
    }
    return { ok: true, host }
  }
  const candidates = hosts.filter((host) => args.isOnline(host) && Boolean(host.projectsRoot))
  if (candidates.length === 0) {
    return {
      ok: false,
      status: 409,
      code: 'NO_PROVISIONABLE_HOST',
      message: '当前没有可创建项目的主机。'
    }
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      status: 409,
      code: 'HOST_REQUIRED',
      message: '存在多台可创建项目的主机，请选择一台。',
      details: { hosts: candidates.map((host) => ({ id: host.id, name: host.name })) }
    }
  }
  return { ok: true, host: candidates[0] }
}

/**
 * Appends an already-validated key to the host's root, keeping that host's
 * separator style. Root-only values keep their separator (`/` and `C:\`).
 */
export function joinProjectPath(root: string, key: string): string | null {
  if (root === '/') {
    return `/${key}`
  }
  if (/^[A-Za-z]:[\\/]$/.test(root)) {
    return `${root}${key}`
  }
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  const path = `${root}${separator}${key}`
  return validateProjectPath(path).ok ? path : null
}

export function countActiveProjectsCreatedBy(
  projects: Iterable<Project>,
  username: string
): number {
  let count = 0
  for (const project of projects) {
    if (project.createdBy === username && project.status !== 'archived') {
      count += 1
    }
  }
  return count
}
