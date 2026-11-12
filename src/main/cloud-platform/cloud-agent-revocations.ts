import { readArray, readNumber, readString } from '../../shared/json-fields'
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
  const list = (key: 'projects' | 'users' | 'devices'): { id: string; since: number }[] | null => {
    const raw = readArray(value, key)
    if (raw === null) {
      return null
    }
    const parsed: { id: string; since: number }[] = []
    for (const item of raw) {
      const id = readString(item, 'id')
      const since = readNumber(item, 'since')
      if (id === null || since === null) {
        return null
      }
      parsed.push({ id, since })
    }
    return parsed
  }
  const projects = list('projects')
  const users = list('users')
  const devices = list('devices')
  const rawJtis = readArray(value, 'jtis')
  if (!projects || !users || !devices || rawJtis === null) {
    return null
  }
  if (!rawJtis.every((jti): jti is string => typeof jti === 'string')) {
    return null
  }
  return { projects, users, devices, jtis: rawJtis }
}
