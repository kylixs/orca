import { validateProjectPath } from '../../../packages/contract/src/project-path.ts'
import type { Host, Project } from './store.ts'

/** Developer self-service project policy: host selection, derived path, quota. */

export const SELF_SERVICE_PROJECT_LIMIT = 20

/** Bound on the directory list a host may report per beat. */
export const PROJECT_DIR_LIMIT = 200

export type ProjectDirVerdict =
  | { ok: true; dir: string }
  | { ok: false; code: 'INVALID_DIR' | 'PATH_OUTSIDE_ROOT'; message: string }

const DIR_SEPARATOR = /[\\/\u0000-\u001f\u007f]/

/**
 * FR-3.7: the developer picks the directory by name, the platform joins it onto
 * the host's root. One relative segment is the whole contract — `..`, separators
 * or an absolute path would leave the root, so they never reach the join.
 */
export function validateProjectDir(value: unknown): ProjectDirVerdict {
  const dir = typeof value === 'string' ? value.trim() : ''
  if (dir === '') {
    return { ok: false, code: 'INVALID_DIR', message: '项目目录不能为空。' }
  }
  if (dir.length > 200 || dir === '.' || dir === '..' || DIR_SEPARATOR.test(dir)) {
    return {
      ok: false,
      code: 'INVALID_DIR',
      message: '项目目录只能是单级目录名，不能包含路径分隔符。'
    }
  }
  return { ok: true, dir }
}

/** Host-reported listing: names only, deduplicated, sorted, bounded. */
export function parseProjectDirs(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  const names = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue
    }
    const name = entry.trim()
    if (name !== '' && !DIR_SEPARATOR.test(name)) {
      names.add(name)
    }
  }
  return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, PROJECT_DIR_LIMIT)
}

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
