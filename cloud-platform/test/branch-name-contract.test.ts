import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateProjectDefaultBranch } from '../packages/contract/src/branch-name.ts'

test('默认分支名：与宿主 git-ref 规则一致，拒绝宿主会 BRANCH_INVALID 的形态', () => {
  for (const branch of [
    'bad..branch',
    '.bad',
    'bad.',
    'has space',
    '-flag',
    '/leading',
    'trailing/',
    'double//slash',
    'a@{b',
    'tilde~name',
    'caret^name',
    'star*name',
    'quest?name',
    'colon:name',
    'bracket[name',
    'back\\slash',
    '@',
    'x'.repeat(201)
  ]) {
    const verdict = validateProjectDefaultBranch(branch)
    assert.equal(verdict.ok, false, `branch ${JSON.stringify(branch)} must be rejected`)
    assert.equal(verdict.ok === false ? verdict.code : '', 'BRANCH_INVALID')
  }
})

test('默认分支名：空回落宿主默认行为，合法形态放行', () => {
  assert.deepEqual(validateProjectDefaultBranch(undefined), { ok: true, defaultBranch: '' })
  assert.deepEqual(validateProjectDefaultBranch('  '), { ok: true, defaultBranch: '' })
  assert.deepEqual(validateProjectDefaultBranch(7), {
    ok: false,
    code: 'BRANCH_INVALID',
    message: '默认分支名必须是字符串。'
  })
  for (const branch of ['main', 'feature/x', 'v1.0', 'release/1.0', 'x'.repeat(200)]) {
    assert.deepEqual(validateProjectDefaultBranch(branch), { ok: true, defaultBranch: branch })
  }
})
