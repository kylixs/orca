import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { MockLdapAdapter, ldapProfile } from '../apps/api/src/ldap.ts'

/**
 * LGAA-1a (ldap-group-admission-design.md §5.1/§3.5): with `requiredGroup`
 * set, an authenticated profile outside the admission group fails closed with
 * `not_admitted` (exact case-sensitive CN equality). Without the option the
 * adapter behaves exactly as before (zero regression).
 */

const PASSWORD = 'Passw0rd!'

function makeAccounts(groups: Record<string, string[]>) {
  return new Map(
    Object.entries(groups).map(([username, userGroups]) => [
      username,
      {
        password: PASSWORD,
        profile: ldapProfile({
          username,
          displayName: username,
          dept: 'platform',
          groups: userGroups
        })
      }
    ])
  )
}

describe('Mock 准入组：在组放行', () => {
  test('在组用户凭据命中 → ok + profile.groups（200 形态）', async () => {
    const adapter = new MockLdapAdapter(makeAccounts({ zhangsan: ['developers'] }), {
      requiredGroup: 'developers'
    })
    const result = await adapter.authenticate('zhangsan', PASSWORD)
    assert.equal(result.ok, true)
    assert.ok(result.ok)
    assert.deepEqual(result.profile.groups, ['developers'])
  })

  test('多组 profile 含目标组 → 放行（精确命中其余组不干扰）', async () => {
    const adapter = new MockLdapAdapter(makeAccounts({ zhangsan: ['team-x', 'developers'] }), {
      requiredGroup: 'developers'
    })
    const result = await adapter.authenticate('zhangsan', PASSWORD)
    assert.ok(result.ok)
  })
})

describe('Mock 准入组：不在组 fail-closed', () => {
  test('不在组 → ok:false + reason not_admitted，不泄漏 profile', async () => {
    const adapter = new MockLdapAdapter(makeAccounts({ zhangsan: ['developers'] }), {
      requiredGroup: 'orca-cloud'
    })
    const result = await adapter.authenticate('zhangsan', PASSWORD)
    assert.equal(result.ok, false)
    assert.ok(!result.ok)
    assert.equal(result.reason, 'not_admitted')
    assert.equal('profile' in result, false)
  })

  test('前缀相似组不误命中：orca-cloud-2 ≠ orca-cloud', async () => {
    const adapter = new MockLdapAdapter(makeAccounts({ zhangsan: ['orca-cloud-2'] }), {
      requiredGroup: 'orca-cloud'
    })
    const result = await adapter.authenticate('zhangsan', PASSWORD)
    assert.ok(!result.ok)
    assert.equal(result.reason, 'not_admitted')
  })

  test('反向前缀不误命中：orca-cloud ≠ orca-cloud-2（精确相等双向钉死）', async () => {
    const adapter = new MockLdapAdapter(makeAccounts({ zhangsan: ['orca-cloud'] }), {
      requiredGroup: 'orca-cloud-2'
    })
    const result = await adapter.authenticate('zhangsan', PASSWORD)
    assert.ok(!result.ok)
    assert.equal(result.reason, 'not_admitted')
  })

  test('大小写偏差 fail-closed：Orca-Cloud ≠ orca-cloud（放行方向不折叠）', async () => {
    const adapter = new MockLdapAdapter(makeAccounts({ zhangsan: ['Orca-Cloud'] }), {
      requiredGroup: 'orca-cloud'
    })
    const result = await adapter.authenticate('zhangsan', PASSWORD)
    assert.ok(!result.ok)
    assert.equal(result.reason, 'not_admitted')
  })
})

describe('Mock 准入组：先核密码再判组（§5.1 与生产如实差异）', () => {
  test('错误密码 + 不在组 → invalid_credentials（非 not_admitted）', async () => {
    const adapter = new MockLdapAdapter(makeAccounts({ zhangsan: ['developers'] }), {
      requiredGroup: 'orca-cloud'
    })
    const result = await adapter.authenticate('zhangsan', 'wrong-pass')
    assert.equal(result.ok, false)
    assert.ok(!result.ok)
    assert.equal(result.reason, 'invalid_credentials')
  })

  test('未知用户 → invalid_credentials（准入开启不改变凭据路径）', async () => {
    const adapter = new MockLdapAdapter(makeAccounts({ zhangsan: ['developers'] }), {
      requiredGroup: 'developers'
    })
    const result = await adapter.authenticate('ghost', PASSWORD)
    assert.ok(!result.ok)
    assert.equal(result.reason, 'invalid_credentials')
  })
})

describe('Mock 准入组：未配 requiredGroup 零回归', () => {
  test('未传 config：不在任何准入组的用户照常放行', async () => {
    const adapter = new MockLdapAdapter(makeAccounts({ zhangsan: ['developers'] }))
    const result = await adapter.authenticate('zhangsan', PASSWORD)
    assert.ok(result.ok)
    assert.deepEqual(result.profile.groups, ['developers'])
  })

  test('config 空对象 / requiredGroup undefined 同缺省', async () => {
    const accounts = makeAccounts({ zhangsan: ['developers'] })
    for (const options of [undefined, {}, { requiredGroup: undefined }]) {
      const adapter = new MockLdapAdapter(accounts, options)
      const result = await adapter.authenticate('zhangsan', PASSWORD)
      assert.ok(result.ok, JSON.stringify(options))
    }
  })

  test('未传 config：错误密码仍 invalid_credentials（既有行为不动）', async () => {
    const adapter = new MockLdapAdapter(makeAccounts({ zhangsan: ['developers'] }))
    const result = await adapter.authenticate('zhangsan', 'wrong-pass')
    assert.ok(!result.ok)
    assert.equal(result.reason, 'invalid_credentials')
  })
})
