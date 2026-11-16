import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateProjectRepoUrl } from '../packages/contract/src/repo-url.ts'
import {
  REPO_URL_ACCEPT,
  REPO_URL_REJECT
} from '../packages/contract/src/repo-url-acceptance-cases.ts'

const POSITIVE = [
  'https://git.example.com/org/repo.git',
  'http://git.internal/team/repo',
  'https://probe-user:S3cretProbe@git.example.com/team/secret.git',
  'ssh://git@git.example.com:2222/org/repo.git',
  'git://git.example.com/org/repo.git',
  'git@git.example.com:org/repo.git',
  'git@host:org/repo.git',
  'file:///srv/git/repo.git',
  'file://localhost/srv/git/repo.git',
  '/srv/git/repo.git',
  '/srv/git/repo with space.git',
  'C:/repos/demo.git',
  'C:\\repos\\demo.git'
]

const NEGATIVE = [
  'not-a-valid-url',
  'bare-word',
  './repo.git',
  '../repo.git',
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
  'ext::sh -c id',
  'example.com:org/repo.git',
  'localhost:org/repo.git',
  '\\\\server\\share\\repo.git',
  '//server/share/repo.git'
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

test('仓库地址：裸字符串与畸形地址拒绝', () => {
  for (const repoUrl of NEGATIVE) {
    const verdict = validateProjectRepoUrl(repoUrl)
    assert.equal(verdict.ok, false, `${JSON.stringify(repoUrl)} 必须被拒绝`)
    assert.equal(verdict.ok === false ? verdict.code : '', 'REPO_URL_INVALID')
  }
})

test('仓库地址：两端共享矩阵在本侧全部接受（防分叉）', () => {
  for (const repoUrl of REPO_URL_ACCEPT) {
    assert.equal(validateProjectRepoUrl(repoUrl).ok, true, `${repoUrl} 两端都必须接受`)
  }
})

test('仓库地址：无 user@ 的 SCP-like 与 UNC 两端都拒绝（防分叉）', () => {
  for (const repoUrl of REPO_URL_REJECT) {
    const verdict = validateProjectRepoUrl(repoUrl)
    assert.equal(verdict.ok, false, `${repoUrl} 两端都必须拒绝`)
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
