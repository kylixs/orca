/**
 * LDAP group → platform role mapping (ldap-group-authz-design.md §2.1).
 * The table is a security whitelist: groups absent from it derive nothing and
 * fall back to `developer` — a typo'd or deleted mapping can only demote,
 * never elevate. Mapping changes ride the PR diff as their audit trail.
 */

/** Platform role strings (ROLE_PERMISSIONS keys in server.ts). */
export type PlatformRole = 'developer' | 'platform:admin' | 'platform:auditor'

export const LDAP_ROLE_GROUP_MAP: Record<string, PlatformRole[]> = {
  'platform-admins': ['platform:admin'],
  'platform-auditors': ['platform:auditor']
}

/**
 * Derive roles from LDAP groups: `developer` base (authentication grants it to
 * everyone, so it is deliberately not a map key) + union of every mapped
 * group's roles, sorted and deduped. Unknown/empty groups → ['developer'].
 * Exact key match only: a case deviation is an unknown group (fail-safe).
 */
export function rolesFromGroups(groups: string[]): PlatformRole[] {
  const roles = new Set<PlatformRole>(['developer'])
  for (const group of groups) {
    for (const role of LDAP_ROLE_GROUP_MAP[group] ?? []) roles.add(role)
  }
  return [...roles].sort()
}
