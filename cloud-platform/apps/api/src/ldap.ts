export type LdapProfile = {
  username: string
  displayName: string
  dept: string
  email: string
  groups: string[]
}

export type LdapResult =
  | { ok: true; profile: LdapProfile }
  | { ok: false; reason: 'invalid_credentials' | 'unavailable' | 'not_admitted' }

export type LdapAdapter = {
  authenticate(username: string, password: string): Promise<LdapResult>
}

/**
 * Test/dev adapter. Production wires an LDAPS simple-bind adapter behind the
 * same interface; the platform never stores the password.
 */
export type MockLdapAdapterOptions = {
  /** Admission group CN; set = profiles outside it fail closed with `not_admitted`. */
  requiredGroup?: string
}

export class MockLdapAdapter implements LdapAdapter {
  private readonly accounts: Map<string, { password: string; profile: LdapProfile }>
  private readonly requiredGroup?: string

  constructor(
    accounts: Map<string, { password: string; profile: LdapProfile }>,
    options?: MockLdapAdapterOptions
  ) {
    this.accounts = accounts
    this.requiredGroup = options?.requiredGroup
  }

  async authenticate(username: string, password: string): Promise<LdapResult> {
    const account = this.accounts.get(username)
    if (!account || account.password !== password) {
      return { ok: false, reason: 'invalid_credentials' }
    }
    // Password first, group second — reversed vs the production memberOf filter (§5.1).
    if (this.requiredGroup && !account.profile.groups.includes(this.requiredGroup)) {
      const failure: Extract<LdapResult, { ok: false }> = { ok: false, reason: 'not_admitted' }
      return failure
    }
    return { ok: true, profile: account.profile }
  }
}

export function ldapProfile(input: {
  username: string
  displayName: string
  dept: string
  groups?: string[]
}): LdapProfile {
  return {
    username: input.username,
    displayName: input.displayName,
    dept: input.dept,
    email: `${input.username}@example.com`,
    groups: input.groups ?? ['developers']
  }
}
