import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateProjectRepoUrl } from '../packages/contract/src/repo-url.ts'

const POSITIVE = [
  'https://git.example.com/org/repo.git',
  'http://git.internal/team/repo',
  'https://probe-user:S3cretProbe@git.example.com/team/secret.git',
  'ssh://git@git.example.com:2222/org/repo.git',
  'git://git.example.com/org/repo.git',
  'git@git.example.com:org/repo.git',
  'git@host:org/repo.git',
  'example.com:org/repo.git',
  'localhost:org/repo.git',
  'file:///srv/git/repo.git',
  'file://localhost/srv/git/repo.git'
]

const NEGATIVE = [
  'not-a-valid-url',
  'bare-word',
  '/tmp/does-not-exist.git',
  './repo.git',
  '../repo.git',
  'C:/repos/demo.git',
  'C:\\repos\\demo.git',
  'https://git.example.com',
  'https://git.example.com/',
  'https:///org/repo.git',
  'ftp://git.example.com/org/repo.git',
  'git@host:',
  'has space',
  'https://git.example.com/org/repo .git',
  'https://git.example.com/org/repo\\x.git',
  '-oops',
  '-https://git.example.com/org/repo.git',
  'ext::sh -c id'
]

test('仓库地址：空值表示无仓库项目，保持合法', () => {
  for (const empty of [undefined, null, '', '   ']) {
    assert.deepEqual(validateProjectRepoUrl(empty), { ok: true, repoUrl: '' })
  }
})

test('仓库地址：受支持的 VCS 地址形态放行', () => {
  for (const repoUrl of POSITIVE) {
    const verdict = validateProjectRepoUrl(repoUrl)
    assert.equal(verdict.ok, true, `${repoUrl} 应被接受`)
    assert.equal(verdict.ok === true ? verdict.repoUrl : '', repoUrl)
  }
  assert.deepEqual(validateProjectRepoUrl('  https://git.example.com/org/repo.git  '), {
    ok: true,
    repoUrl: 'https://git.example.com/org/repo.git'
  })
})

test('仓库地址：裸字符串、本地路径与畸形地址拒绝', () => {
  for (const repoUrl of NEGATIVE) {
    const verdict = validateProjectRepoUrl(repoUrl)
    assert.equal(verdict.ok, false, `${JSON.stringify(repoUrl)} 必须被拒绝`)
    assert.equal(verdict.ok === false ? verdict.code : '', 'REPO_URL_INVALID')
  }
})

test('仓库地址：非字符串、超长与控制字符拒绝', () => {
  assert.deepEqual(validateProjectRepoUrl(7), {
    ok: false,
    code: 'REPO_URL_INVALID',
    message: '仓库地址必须是字符串。'
  })
  const tooLong = `https://git.example.com/${'x'.repeat(4096)}`
  const longVerdict = validateProjectRepoUrl(tooLong)
  assert.equal(longVerdict.ok, false)
  assert.equal(longVerdict.ok === false ? longVerdict.message : '', '仓库地址过长。')

  const control = validateProjectRepoUrl('https://git.example.com/a\u0000b.git')
  assert.equal(control.ok, false)
  assert.equal(control.ok === false ? control.message : '', '仓库地址包含控制字符。')
})
