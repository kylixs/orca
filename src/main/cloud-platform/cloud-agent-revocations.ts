import type { CloudRevocations } from './cloud-upgrade-admission'

/** Revocation snapshot parsing, split out to keep the polling client readable. */

export const emptyRevocations = (): Required<CloudRevocations> => ({
  projects: [],
  users: [],
  devices: [],
  jtis: []
})

/**
 * Returns null for a structurally invalid body so the caller keeps the previous
 * snapshot. Reading `{}` as "nothing is revoked" would re-admit a revoked ticket
 * (review-07 F2).
 */
export function parseRevocations(value: unknown): Required<CloudRevocations> | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const candidate = value as Record<string, unknown>
  const list = (key: 'projects' | 'users' | 'devices'): { id: string; since: number }[] | null => {
    const raw = candidate[key]
    if (!Array.isArray(raw)) {
      return null
    }
    const parsed: { id: string; since: number }[] = []
    for (const item of raw) {
      if (!item || typeof item !== 'object') {
        return null
      }
      const entry = item as Record<string, unknown>
      if (typeof entry.id !== 'string' || typeof entry.since !== 'number') {
        return null
      }
      parsed.push({ id: entry.id, since: entry.since })
    }
    return parsed
  }
  const projects = list('projects')
  const users = list('users')
  const devices = list('devices')
  const rawJtis = candidate.jtis
  if (!projects || !users || !devices || !Array.isArray(rawJtis)) {
    return null
  }
  if (!rawJtis.every((jti): jti is string => typeof jti === 'string')) {
    return null
  }
  return { projects, users, devices, jtis: rawJtis }
}
