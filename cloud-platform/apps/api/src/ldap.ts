export type LdapProfile = {
  username: string
  displayName: string
  dept: string
  email: string
  groups: string[]
}

export type LdapResult =
  | { ok: true; profile: LdapProfile }
  | { ok: false; reason: 'invalid_credentials' | 'unavailable' }

export type LdapAdapter = {
  authenticate(username: string, password: string): Promise<LdapResult>
}

/**
 * Test/dev adapter. Production wires an LDAPS simple-bind adapter behind the
 * same interface; the platform never stores the password.
 */
export class MockLdapAdapter implements LdapAdapter {
  private readonly accounts: Map<string, { password: string; profile: LdapProfile }>

  constructor(accounts: Map<string, { password: string; profile: LdapProfile }>) {
    this.accounts = accounts
  }

  async authenticate(username: string, password: string): Promise<LdapResult> {
    const account = this.accounts.get(username)
    if (!account || account.password !== password) {
      return { ok: false, reason: 'invalid_credentials' }
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
