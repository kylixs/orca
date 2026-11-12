import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CLOUD_FILE_PATH_PARAMS,
  CLOUD_FILE_UNBOUNDED_METHODS,
  CLOUD_FILE_WORKTREE_ONLY_METHODS
} from './cloud-file-path-params'
import { checkCloudRpcPath, type CloudPathGuardRuntime } from './cloud-path-guard'

/**
 * The path table is what stops a `file:read` session from reading outside its
 * project, so these pin the fields the old `…relativePath` suffix guess missed:
 * plural batches (`relativePaths`), the doc-preview entry path, and the methods
 * whose address is absolute and therefore unbounded.
 */

const base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-cloud-path-params-')))
const projectRoot = join(base, 'payment-service')
const workspaceRoot = join(projectRoot, '.orca-worktrees', 'zhangsan')
const otherRepo = join(base, 'other-team')
mkdirSync(join(projectRoot, 'src'), { recursive: true })
mkdirSync(workspaceRoot, { recursive: true })
mkdirSync(otherRepo, { recursive: true })
writeFileSync(join(projectRoot, 'README.md'), 'hello\n')
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: projectRoot })

const roots = { projectRoot, workspaceRoot }

/** Only the selectors these cases name; resolution outside the map is a failure. */
const runtime: CloudPathGuardRuntime = {
  resolveWorktreeRootPath: async (selector) => {
    if (selector === `path:${projectRoot}`) {
      return projectRoot
    }
    if (selector === `path:${workspaceRoot}`) {
      return workspaceRoot
    }
    throw new Error('unknown worktree')
  },
  resolveRepoRootPath: async () => {
    throw new Error('not used here')
  }
}

async function check(method: string, params: unknown) {
  return await checkCloudRpcPath({ runtime, roots, method, params })
}

describe('文件路径参数表', () => {
  it('每个 files.* 方法恰好归入一种处理方式', () => {
    const declared = Object.keys(CLOUD_FILE_PATH_PARAMS)
    for (const method of declared) {
      expect(method.startsWith('files.'), method).toBe(true)
      expect(CLOUD_FILE_UNBOUNDED_METHODS.has(method), method).toBe(false)
      expect(CLOUD_FILE_WORKTREE_ONLY_METHODS.has(method), method).toBe(false)
    }
    for (const method of CLOUD_FILE_UNBOUNDED_METHODS) {
      expect(CLOUD_FILE_WORKTREE_ONLY_METHODS.has(method), method).toBe(false)
    }
  })

  it('批量存在性检查里的每个路径都参与边界判断（旧的 relativePath 后缀匹配漏掉复数）', async () => {
    const inside = await check('files.pathsExist', {
      worktree: `path:${projectRoot}`,
      relativePaths: ['src/app.ts', 'README.md']
    })
    expect(inside).toEqual({ ok: true })

    const mixed = await check('files.pathsExist', {
      worktree: `path:${projectRoot}`,
      relativePaths: ['README.md', '../../other-team/secret.txt']
    })
    expect(mixed).toMatchObject({ ok: false, reason: 'project_scope' })
  })

  it('文档预览的入口路径同样受限，不能借工作区内的文件跳到项目外', async () => {
    const escape = await check('files.readDocPreview', {
      worktree: `path:${projectRoot}`,
      relativePath: 'docs/index.md',
      entryRelativePath: '../../../other-team/secret.txt'
    })
    expect(escape).toMatchObject({ ok: false, reason: 'project_scope' })
  })

  it('写方法按 workspaceRoot 限定：改名的目标落在别人的检出区就拒绝', async () => {
    const badTarget = await check('files.rename', {
      worktree: `path:${workspaceRoot}`,
      oldRelativePath: 'a.ts',
      newRelativePath: '../../../shared-checkout/a.ts'
    })
    expect(badTarget).toMatchObject({ ok: false, reason: 'workspace_scope' })

    const good = await check('files.rename', {
      worktree: `path:${workspaceRoot}`,
      oldRelativePath: 'a.ts',
      newRelativePath: 'src/b.ts'
    })
    expect(good).toEqual({ ok: true })
  })

  it('绝对路径方法整体拒绝：项目内边界无法约束它们', async () => {
    for (const method of CLOUD_FILE_UNBOUNDED_METHODS) {
      const decision = await check(method, {
        worktree: `path:${projectRoot}`,
        path: '/etc/passwd'
      })
      expect(decision, method).toMatchObject({ ok: false, reason: 'path_unbounded' })
    }
  })

  it('未声明路径的 files.* 方法默认拒绝，而不是当作无路径放行', async () => {
    const decision = await check('files.futureMethod', {
      worktree: `path:${projectRoot}`,
      relativePath: 'README.md'
    })
    expect(decision).toMatchObject({ ok: false, reason: 'path_unverifiable' })
  })

  it('面板动作（files.open/openDiff）在内侧放行', async () => {
    for (const method of ['files.open', 'files.openDiff']) {
      const decision = await check(method, {
        worktree: `path:${projectRoot}`,
        relativePath: 'README.md'
      })
      expect(decision, method).toEqual({ ok: true })
    }
  })
})
