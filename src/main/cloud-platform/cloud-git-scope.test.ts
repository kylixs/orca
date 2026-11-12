import { describe, expect, it } from 'vitest'
import { cloudGitAccessOf, cloudGitPathsOf } from './cloud-git-scope'
import { cloudPathAccessOf } from './cloud-path-guard'

/**
 * Design §8.3: the main checkout is read-only. These pin that split and the
 * deny-by-default direction: a git method nobody classified is a write, so a new
 * mutating RPC cannot land on the shared checkout by omission.
 */

describe('git 方法读写划分', () => {
  it('只读方法不改变仓库', () => {
    for (const method of [
      'git.status',
      'git.diff',
      'git.history',
      'git.localBranches',
      'git.branchCompare',
      'git.commitDiff',
      'git.upstreamStatus'
    ]) {
      expect(cloudGitAccessOf(method), method).toBe('read')
    }
  })

  it('写方法需要工作区根', () => {
    for (const method of [
      'git.stage',
      'git.unstage',
      'git.bulkStage',
      'git.commit',
      'git.checkout',
      'git.discard',
      'git.bulkDiscard',
      'git.fetch',
      'git.pull',
      'git.push',
      'git.rebaseFromBase',
      'git.abortMerge',
      'git.forkSync'
    ]) {
      expect(cloudGitAccessOf(method), method).toBe('write')
    }
  })

  it('未登记的 git 方法按写处理（默认最严）', () => {
    expect(cloudGitAccessOf('git.futureMutation')).toBe('write')
  })

  it('非 git 方法不参与', () => {
    expect(cloudGitAccessOf('files.read')).toBeNull()
    expect(cloudGitAccessOf('terminal.create')).toBeNull()
  })

  it('路径参数收集：单值、数组与两个 rename 端点都覆盖', () => {
    expect(cloudGitPathsOf({ filePath: 'a.ts' })).toEqual(['a.ts'])
    expect(cloudGitPathsOf({ filePaths: ['a.ts', 'b.ts'] })).toEqual(['a.ts', 'b.ts'])
    expect(cloudGitPathsOf({ paths: ['x'] })).toEqual(['x'])
    expect(cloudGitPathsOf({ oldPath: 'old.ts', submodulePath: 'sub' })).toEqual(['old.ts', 'sub'])
    expect(cloudGitPathsOf({ worktree: 'path:/p' })).toEqual([])
  })

  it('RPC 路径检查把 git 与文件方法统一到同一读写语义', () => {
    expect(cloudPathAccessOf('git.status')).toBe('read')
    expect(cloudPathAccessOf('git.commit')).toBe('write')
    expect(cloudPathAccessOf('files.read')).toBe('read')
    expect(cloudPathAccessOf('files.write')).toBe('write')
    expect(cloudPathAccessOf('terminal.create')).toBeNull()
  })
})
