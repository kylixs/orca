import { describe, expect, it } from 'vitest'
import {
  planCloudProjectProvision,
  validateCloudBranchName,
  validateCloudCloneUrl
} from './cloud-project-provision'
import { validateProjectRepoUrl } from '../../../cloud-platform/packages/contract/src/repo-url'
import {
  REPO_URL_ACCEPT,
  REPO_URL_REJECT
} from '../../../cloud-platform/packages/contract/src/repo-url-acceptance-cases'

describe('云项目准备：仓库地址校验', () => {
  it.each([
    'https://git.example.com/pay/service.git',
    'http://git.example.com/pay/service.git',
    'ssh://git@git.example.com/pay/service.git',
    'git://git.example.com/pay/service.git',
    'git@git.example.com:pay/service.git',
    '/srv/work/payment-service',
    '/srv/work/payment service',
    'C:\\work\\payment-service',
    'file:///srv/work/payment-service.git',
    'file://localhost/srv/work/payment-service.git',
    '  https://git.example.com/pay/service.git  '
  ])('接受 %s', (url) => {
    expect(validateCloudCloneUrl(url).ok).toBe(true)
  })

  it('接受两端共享矩阵（防分叉）', () => {
    for (const url of REPO_URL_ACCEPT) {
      expect(validateCloudCloneUrl(url).ok, `${url} 两端都必须接受`).toBe(true)
    }
  })

  it('无 user@ 的 SCP-like 与 UNC 两端都拒绝，且判定一致（防分叉）', () => {
    for (const url of REPO_URL_REJECT) {
      expect(validateCloudCloneUrl(url).ok, `${url} 宿主必须拒绝`).toBe(false)
      expect(validateProjectRepoUrl(url).ok, `${url} 平台必须拒绝`).toBe(false)
    }
  })

  it.each([
    ['', 'empty'],
    ['   ', 'blank'],
    ['-oProxyCommand=sh', 'argument-looking'],
    ['https://example.com/a\nb', 'newline'],
    ['https://example.com/a\rb', 'carriage return'],
    ['ext::sh -c touch% /tmp/pwned', 'ext transport'],
    ['EXT::sh -c id', 'ext transport uppercase'],
    ['file:///', 'file url without path'],
    ['file://', 'empty file url'],
    ['file://remote-host/srv/work/repo', 'file url with hostname'],
    ['javascript:alert(1)', 'unlisted scheme'],
    ['../relative/path', 'relative path'],
    ['example.com:org/repo.git', 'scp-like without user'],
    ['localhost:org/repo.git', 'scp-like localhost without user'],
    ['\\\\server\\share\\repo.git', 'windows UNC'],
    ['//server/share/repo.git', 'posix UNC'],
    ['git@host', 'scp-like without path']
  ])('拒绝 %s（%s）', (url) => {
    const verdict = validateCloudCloneUrl(url)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.code).toBe('CLONE_URL_INVALID')
      expect(verdict.message.length).toBeGreaterThan(0)
    }
  })
})

describe('云项目准备：分支名校验', () => {
  it.each(['main', 'develop', 'feature/cloud-provisioning', 'release-1.0'])('接受 %s', (branch) => {
    expect(validateCloudBranchName(branch).ok).toBe(true)
  })

  it.each([
    ['', 'empty'],
    ['-main', 'leading dash'],
    ['feature..x', 'double dot'],
    ['feature x', 'space'],
    ['feature\tx', 'tab'],
    ['feature~x', 'tilde'],
    ['feature^x', 'caret'],
    ['feature:x', 'colon'],
    ['feature?x', 'question mark'],
    ['feature*x', 'asterisk'],
    ['feature[x', 'bracket'],
    ['feature\\x', 'backslash'],
    ['/main', 'leading slash'],
    ['main/', 'trailing slash'],
    ['main.', 'trailing dot'],
    ['a//b', 'double slash'],
    ['a@{b', 'at-brace'],
    ['@', 'at'],
    ['x'.repeat(201), 'too long']
  ])('拒绝 %s（%s）', (branch) => {
    const verdict = validateCloudBranchName(branch)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.code).toBe('BRANCH_INVALID')
    }
  })
})

describe('云项目准备：决策', () => {
  it('已是仓库时跳过 clone（即使票据带地址）', () => {
    expect(planCloudProjectProvision({ hasRepo: true, hasRepoUrl: true })).toEqual({
      kind: 'already-provisioned'
    })
    expect(planCloudProjectProvision({ hasRepo: true, hasRepoUrl: false })).toEqual({
      kind: 'already-provisioned'
    })
  })

  it('不是仓库且有 repoUrl 时 clone', () => {
    expect(planCloudProjectProvision({ hasRepo: false, hasRepoUrl: true })).toEqual({
      kind: 'clone'
    })
  })

  it('不是仓库且无 repoUrl 时在宿主上初始化目录', () => {
    expect(planCloudProjectProvision({ hasRepo: false, hasRepoUrl: false })).toEqual({
      kind: 'init'
    })
  })
})
