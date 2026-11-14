import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { Store } from '../persistence/loading-store/store'
import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { OrcaRuntimeService } from './orca-runtime'
import { RuntimeRepositoryCloneController } from './runtime-repository-clone-controller'
import { initializeEmptyRepositoryAt } from './runtime-repository-init'

/**
 * W12b-1: a cloud project with no repo URL must still open, so the host
 * initializes the ticket's directory itself. These tests pin the Git 2.25
 * init sequence and the facts the downstream open flow needs: a registered
 * repo row, a branch that exists (one commit), and a `worktree.createManaged`
 * that works on top of it.
 */

let base = ''
let store: Store

beforeAll(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-repository-init-')))
  const dataDir = mkdtempSync(join(tmpdir(), 'orca-repository-init-data-'))
  installFakeAppEnvironment({ getPath: () => dataDir })
  store = createSqliteTestStore(Store, { dataFile: join(dataDir, 'orca-data.json') })
  store.updateSettings({ workspaceDir: join(base, 'host-workspaces') })
  store.flushOrThrow()
})

afterAll(async () => {
  await closeTestStores()
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function controller(): RuntimeRepositoryCloneController {
  return new RuntimeRepositoryCloneController({
    getStore: () => store,
    invalidateResolvedWorktrees: () => undefined,
    invalidateWorktreeScan: () => undefined,
    notifyReposChanged: () => undefined
  })
}

/** Simulates a host with no git identity configured, restoring the previous env. */
async function withoutGitIdentity(run: () => Promise<void>): Promise<void> {
  const cleanHome = mkdtempSync(join(tmpdir(), 'orca-repository-init-home-'))
  // Why useConfigOnly: a desktop OS auto-detects user@hostname, so a merely
  // empty config still commits; a config that forbids guessing is the portable
  // way to reproduce the "Please tell me who you are" failure.
  writeFileSync(join(cleanHome, 'gitconfig'), '[user]\n\tuseConfigOnly = true\n')
  const previousGlobal = process.env.GIT_CONFIG_GLOBAL
  const previousNosystem = process.env.GIT_CONFIG_NOSYSTEM
  process.env.GIT_CONFIG_GLOBAL = join(cleanHome, 'gitconfig')
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  try {
    await run()
  } finally {
    if (previousGlobal === undefined) {
      delete process.env.GIT_CONFIG_GLOBAL
    } else {
      process.env.GIT_CONFIG_GLOBAL = previousGlobal
    }
    if (previousNosystem === undefined) {
      delete process.env.GIT_CONFIG_NOSYSTEM
    } else {
      process.env.GIT_CONFIG_NOSYSTEM = previousNosystem
    }
  }
}

describe('initializeEmptyRepositoryAt（Git 2.25 兼容初始化序列）', () => {
  it('不用 -b：symbolic-ref 把票面分支钉到未出生 HEAD，并落一个初始提交', async () => {
    const target = join(base, 'seq-branch-pin')
    mkdirSync(target, { recursive: true })
    await initializeEmptyRepositoryAt(target, 'trunk')
    expect(git(target, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('trunk')
    expect(git(target, 'rev-list', '--count', 'HEAD').trim()).toBe('1')
  })

  it('宿主未配置身份时用 -c 兜底完成初始提交', async () => {
    const target = join(base, 'seq-identity-fallback')
    mkdirSync(target, { recursive: true })
    await withoutGitIdentity(async () => {
      await initializeEmptyRepositoryAt(target, 'main')
    })
    expect(git(target, 'rev-list', '--count', 'HEAD').trim()).toBe('1')
    expect(git(target, 'log', '-1', '--format=%an <%ae>').trim()).toBe(
      'orca-cloud <orca-cloud@localhost>'
    )
  })
})

describe('RuntimeRepositoryCloneController.initToPath', () => {
  it('目录不存在时创建目录、初始化并在 store 登记该检出', async () => {
    const target = join(base, 'init-new-dir')
    const repo = await controller().initToPath(target, { branch: 'trunk' })
    expect(repo.path).toBe(target)
    expect(existsSync(join(target, '.git'))).toBe(true)
    expect(git(target, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('trunk')
    expect(store.getRepos().find((entry) => entry.path === target)?.kind).toBe('git')
  })

  it('已有普通目录（非 git）时原目录文件保留', async () => {
    const target = join(base, 'init-existing-plain')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'notes.txt'), 'keep me\n')
    await controller().initToPath(target, { branch: 'main' })
    expect(readFileSync(join(target, 'notes.txt'), 'utf8')).toBe('keep me\n')
    expect(git(target, 'rev-list', '--count', 'HEAD').trim()).toBe('1')
    expect(git(target, 'status', '--porcelain').trim()).toBe('?? notes.txt')
  })

  it('重试幂等：第二次调用不再初始化、不产生第二个提交或第二行登记', async () => {
    const target = join(base, 'init-idempotent')
    const controllerInstance = controller()
    await controllerInstance.initToPath(target, { branch: 'main' })
    await controllerInstance.initToPath(target, { branch: 'main' })
    expect(git(target, 'rev-list', '--count', 'HEAD').trim()).toBe('1')
    expect(store.getRepos().filter((entry) => entry.path === target)).toHaveLength(1)
  })

  it('初始化失败时清理刚创建的目录，不留无提交的半成品仓库', async () => {
    const target = join(base, 'init-failed-cleanup')
    // '..' is an invalid refname, so symbolic-ref fails after `git init` ran.
    await expect(controller().initToPath(target, { branch: 'bad..branch' })).rejects.toThrow(
      /symbolic-ref|invalid reference/i
    )
    expect(existsSync(target)).toBe(false)
  })

  it('服务链：provisionCloudProject 初始化后 createManagedWorktree 可建出工作区', async () => {
    const target = join(base, 'init-then-managed-worktree')
    const service = new OrcaRuntimeService(store)
    const provisioned = await service.provisionCloudProject({
      projectRoot: target,
      repoUrl: '',
      defaultBranch: 'trunk'
    })
    expect(provisioned).toEqual({ ok: true, provisioned: true })
    const workspaceRoot = join(target, '.orca-worktrees', 'zhangsan')
    const result = await service.createManagedWorktree({
      repoSelector: `path:${target}`,
      workspaceRoot,
      name: 'trunk',
      baseBranch: 'trunk',
      telemetrySource: 'unknown'
    })
    expect(existsSync(result.worktree.path)).toBe(true)
    expect(result.worktree.path.startsWith(`${workspaceRoot}/`)).toBe(true)
    expect(realpathSync(git(result.worktree.path, 'rev-parse', '--show-toplevel').trim())).toBe(
      realpathSync(result.worktree.path)
    )
    expect(
      git(target, 'worktree', 'list')
        .split('\n')
        .filter((line) => line.trim() !== '')
    ).toHaveLength(2)
  }, 60_000)
})
