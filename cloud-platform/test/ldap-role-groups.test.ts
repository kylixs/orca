import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { LDAP_ROLE_GROUP_MAP, rolesFromGroups } from '../apps/api/src/ldap-role-groups.ts'

/**
 * LGA-1 (ldap-group-authz-design.md §2.1 + LG-9): the group→role table is a
 * security whitelist, so these cases pin the fail-safe direction — only exact
 * table hits derive privileges, everything else lands on the `developer` base.
 */

describe('LDAP 组→角色映射：映射命中', () => {
  test('platform-admins 派生 developer 底座 + platform:admin', () => {
    assert.deepEqual(rolesFromGroups(['platform-admins']), ['developer', 'platform:admin'])
  })

  test('platform-auditors 派生 developer 底座 + platform:auditor', () => {
    assert.deepEqual(rolesFromGroups(['platform-auditors']), ['developer', 'platform:auditor'])
  })

  test('映射全覆盖：表内每个键都派生其声明的角色', () => {
    for (const [group, roles] of Object.entries(LDAP_ROLE_GROUP_MAP)) {
      assert.deepEqual(rolesFromGroups([group]), ['developer', ...roles].sort(), group)
    }
  })

  test('developer 是认证基座而非映射目标：映射表不得出现 developer 键', () => {
    assert.equal('developer' in LDAP_ROLE_GROUP_MAP, false)
  })
})

describe('LDAP 组→角色映射：多组并集', () => {
  test('复合派生：admins+auditors → 三角色（设计 §2.1 原例）', () => {
    assert.deepEqual(rolesFromGroups(['platform-admins', 'platform-auditors']), [
      'developer',
      'platform:admin',
      'platform:auditor'
    ])
  })

  test('输入顺序不影响输出（确定性排序）', () => {
    assert.deepEqual(
      rolesFromGroups(['platform-auditors', 'platform-admins']),
      rolesFromGroups(['platform-admins', 'platform-auditors'])
    )
    assert.deepEqual(rolesFromGroups(['platform-auditors', 'platform-admins']), [
      'developer',
      'platform:admin',
      'platform:auditor'
    ])
  })

  test('重复组只派生一次（去重）', () => {
    assert.deepEqual(rolesFromGroups(['platform-admins', 'platform-admins']), [
      'developer',
      'platform:admin'
    ])
  })

  test('命中组与未知组混合：未知组不稀释派生结果', () => {
    assert.deepEqual(rolesFromGroups(['team-payment', 'platform-admins', 'developers']), [
      'developer',
      'platform:admin'
    ])
  })
})

describe('LDAP 组→角色映射：未知组兜底', () => {
  test('表外组不派生任何位，安全兜底 developer（fail-safe 方向）', () => {
    assert.deepEqual(rolesFromGroups(['developers']), ['developer'])
    assert.deepEqual(rolesFromGroups(['team-payment']), ['developer'])
    assert.deepEqual(rolesFromGroups(['unknown-group']), ['developer'])
  })

  test('全部未知组 → 仅 developer', () => {
    assert.deepEqual(rolesFromGroups(['developers', 'team-payment', 'nope']), ['developer'])
  })
})

describe('LDAP 组→角色映射：空组', () => {
  test('空数组 → developer 兜底', () => {
    assert.deepEqual(rolesFromGroups([]), ['developer'])
  })
})

describe('LDAP 组→角色映射：大小写边界', () => {
  test('大小写不一致视为未知组，只降权不提权（精确白名单匹配）', () => {
    assert.deepEqual(rolesFromGroups(['PLATFORM-ADMINS']), ['developer'])
    assert.deepEqual(rolesFromGroups(['Platform-Admins']), ['developer'])
    assert.deepEqual(rolesFromGroups(['Platform-Auditors']), ['developer'])
    assert.deepEqual(rolesFromGroups(['PLATFORM-ADMINS', 'platform-auditors']), [
      'developer',
      'platform:auditor'
    ])
  })
})

describe('LDAP 组→角色映射：纯函数契约', () => {
  test('不修改输入数组', () => {
    const groups = ['platform-admins', 'unknown-group']
    const snapshot = [...groups]
    rolesFromGroups(groups)
    assert.deepEqual(groups, snapshot)
  })

  test('同输入恒同输出（引用无关、可重复）', () => {
    assert.deepEqual(rolesFromGroups(['platform-admins']), rolesFromGroups(['platform-admins']))
    assert.deepEqual(rolesFromGroups(['platform-admins']), ['developer', 'platform:admin'])
  })
})
