import type { Permission } from '../../../packages/contract/src/credential.ts'
import type { HostGrant, HostPermission, Project, Store, User } from './store.ts'

/**
 * U65/U67 host-grant synthesis: stored host rows keep the three bits, the
 * effective level is derived (never stored), and project bits never widen it.
 */

export type HostAccessLevel = 'full' | 'read-only' | null

/** Bits a full host grant supplies inside every project of that host. */
const FULL_OPS: Permission[] = ['open', 'terminal', 'agent', 'file:read', 'file:write', 'browser']
/** The read-only ceiling (and floor): view never mints more than these. */
const VIEW_OPS: Permission[] = ['open', 'file:read']

/**
 * Host bits of one subject: direct user rows union group rows. The single
 * subject-matching core — `hasHostPermission` reads through this.
 */
export function hostBitsFromRows(
  grants: HostGrant[],
  hostId: string,
  user: User
): Set<HostPermission> {
  const bits = new Set<HostPermission>()
  for (const grant of grants) {
    if (grant.hostId !== hostId) continue
    if (
      (grant.subjectType === 'user' && grant.subjectId === user.id) ||
      (grant.subjectType === 'group' && user.groups.includes(grant.subjectId))
    ) {
      for (const bit of grant.permissions) bits.add(bit)
    }
  }
  return bits
}

export function hostBits(store: Store, hostId: string, user: User): Set<HostPermission> {
  return hostBitsFromRows(store.hostGrants, hostId, user)
}

/**
 * U67 定型: full = view+provision (maintain excluded by verdict), read-only =
 * view alone. provision/maintain without view derives nothing.
 */
export function hostLevelFromBits(bits: Set<HostPermission>): HostAccessLevel {
  if (bits.has('view') && bits.has('provision')) return 'full'
  if (bits.has('view')) return 'read-only'
  return null
}

export function hostAccessLevel(store: Store, hostId: string, user: User): HostAccessLevel {
  return hostLevelFromBits(hostBits(store, hostId, user))
}

/**
 * The bits a ticket carries and every open/visibility check reads. Admin bypass
 * keeps the project row only (U40 self-grant still requires open); full is a
 * source, read-only is floor+ceiling, and download is inherited, never derived.
 */
export function effectiveProjectPermissions(
  store: Store,
  project: Project,
  user: User,
  isPlatformAdmin: boolean
): Permission[] {
  const projectBits = store.effectivePermissions(project.id, user)
  if (isPlatformAdmin) return projectBits
  const level = hostAccessLevel(store, project.hostId, user)
  if (level === 'full') {
    return [...FULL_OPS, ...projectBits.filter((p) => p === 'download')]
  }
  if (level === 'read-only') return [...VIEW_OPS]
  return projectBits
}

/** Self-service creation needs the provision bit (admin bypass); policy is legacy. */
export function canCreateProjectOnHost(
  store: Store,
  hostId: string,
  user: User,
  isPlatformAdmin: boolean
): boolean {
  return isPlatformAdmin || hostBits(store, hostId, user).has('provision')
}
