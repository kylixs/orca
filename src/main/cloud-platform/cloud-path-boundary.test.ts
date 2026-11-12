import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  checkCloudTargetScope,
  checkCloudWorktreeScope,
  isWithinRoot,
  resolveRealPath
} from './cloud-path-boundary'
import { checkCloudRpcPath } from './cloud-path-guard'

/**
 * Design §8.3 / AC-11 / AC-27. These pin the boundary arithmetic on a real
 * filesystem, including the symlink case that a pure `startsWith` check misses:
 * a link inside the project must not become a door out of it.
 */

function fixture(): {
  projectRoot: string
  workspaceRoot: string
  otherProject: string
} {
  // Why realpath: macOS puts temp dirs under /var, itself a link to /private/var.
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-cloud-path-')))
  const projectRoot = join(base, 'project')
  const workspaceRoot = join(projectRoot, '.orca-worktrees', 'zhangsan')
  const otherProject = join(base, 'other')
  mkdirSync(join(projectRoot, 'src'), { recursive: true })
  mkdirSync(workspaceRoot, { recursive: true })
  mkdirSync(otherProject, { recursive: true })
  writeFileSync(join(projectRoot, 'src', 'app.ts'), 'export {}\n')
  writeFileSync(join(otherProject, 'secret.ts'), 'secret\n')
  // A link inside the project pointing outside it.
  symlinkSync(otherProject, join(projectRoot, 'escape'))
  return { projectRoot, workspaceRoot, otherProject }
}

describe('路径容器化', () => {
  it('分隔符感知：/srv/work/svc 不包含 /srv/work/svc-evil', () => {
    expect(isWithinRoot('/srv/work/svc', '/srv/work/svc/file.ts')).toBe(true)
    expect(isWithinRoot('/srv/work/svc', '/srv/work/svc')).toBe(true)
    expect(isWithinRoot('/srv/work/svc', '/srv/work/svc-evil/file.ts')).toBe(false)
    expect(isWithinRoot('/srv/work/svc', '/srv/work')).toBe(false)
  })

  it('不存在的新文件按最近的已存在祖先解析', () => {
    const { projectRoot, workspaceRoot } = fixture()
    expect(resolveRealPath(join(workspaceRoot, 'new', 'deep', 'file.ts'))).toBe(
      join(workspaceRoot, 'new', 'deep', 'file.ts')
    )
    expect(resolveRealPath(join(projectRoot, 'src'))).toBe(join(projectRoot, 'src'))
  })

  it('工作区根内的写入放行，项目其它位置只读', () => {
    const { projectRoot, workspaceRoot } = fixture()
    const roots = { projectRoot, workspaceRoot }
    expect(checkCloudTargetScope(roots, 'read', join(projectRoot, 'src', 'app.ts')).ok).toBe(true)
    expect(checkCloudTargetScope(roots, 'write', join(projectRoot, 'src', 'app.ts'))).toMatchObject(
      {
        ok: false,
        reason: 'workspace_scope'
      }
    )
    expect(checkCloudTargetScope(roots, 'write', join(workspaceRoot, 'feature.ts')).ok).toBe(true)
  })

  it('符号链接解析后仍须在根内：项目里的 escape 链接不能指向外面', () => {
    const { projectRoot, workspaceRoot, otherProject } = fixture()
    const roots = { projectRoot, workspaceRoot }
    const decision = checkCloudTargetScope(roots, 'read', join(projectRoot, 'escape', 'secret.ts'))
    expect(decision).toMatchObject({ ok: false, reason: 'project_scope' })
    // And the same target through the resolved path is refused too.
    expect(checkCloudTargetScope(roots, 'read', join(otherProject, 'secret.ts')).ok).toBe(false)
  })

  it('工作区链接到项目之外时，工作区本身的检查也会拒绝', () => {
    const { otherProject } = fixture()
    const decision = checkCloudWorktreeScope(
      { projectRoot: join(otherProject, 'project'), workspaceRoot: join(otherProject, 'ws') },
      otherProject
    )
    expect(decision).toMatchObject({ ok: false, reason: 'project_scope' })
  })
})

describe('RPC 路径检查', () => {
  const runtime = {
    resolveWorktreeRootPath: async (selector: string) => selector.slice(5),
    resolveRepoRootPath: async (selector: string) => selector.slice(5)
  }

  it('非文件方法不参与路径检查', async () => {
    const decision = await checkCloudRpcPath({
      runtime,
      roots: { projectRoot: '/p', workspaceRoot: '/p/ws' },
      method: 'terminal.list',
      params: {}
    })
    expect(decision).toBeNull()
  })

  it('缺 worktree 选择器一律拒绝，而不是落到 handler', async () => {
    const decision = await checkCloudRpcPath({
      runtime,
      roots: { projectRoot: '/p', workspaceRoot: '/p/ws' },
      method: 'files.read',
      params: { relativePath: 'a.ts' }
    })
    expect(decision).toMatchObject({ ok: false, reason: 'worktree_unknown' })
  })

  it('绝对路径被拒（join 会把它当成相对段）', async () => {
    const { projectRoot, workspaceRoot } = fixture()
    const decision = await checkCloudRpcPath({
      runtime,
      roots: { projectRoot, workspaceRoot },
      method: 'files.read',
      params: { worktree: `path:${projectRoot}`, relativePath: '/etc/passwd' }
    })
    expect(decision).toMatchObject({ ok: false, reason: 'absolute_path' })
  })

  it('rename 的两个路径都检查：一个是项目外的目标就拒绝', async () => {
    const { projectRoot, workspaceRoot } = fixture()
    const decision = await checkCloudRpcPath({
      runtime,
      roots: { projectRoot, workspaceRoot },
      method: 'files.rename',
      params: {
        worktree: `path:${workspaceRoot}`,
        oldRelativePath: 'a.ts',
        newRelativePath: '../../../outside.ts'
      }
    })
    expect(decision).toMatchObject({ ok: false, reason: 'workspace_scope' })
  })

  it('选择器无法解析时明确返回 worktree_unknown', async () => {
    const decision = await checkCloudRpcPath({
      runtime: {
        resolveWorktreeRootPath: async () => {
          throw new Error('selector_not_found')
        },
        resolveRepoRootPath: async () => {
          throw new Error('selector_not_found')
        }
      },
      roots: { projectRoot: '/p', workspaceRoot: '/p/ws' },
      method: 'files.read',
      params: { worktree: 'id:missing', relativePath: 'a.ts' }
    })
    expect(decision).toMatchObject({ ok: false, reason: 'worktree_unknown' })
  })
})
