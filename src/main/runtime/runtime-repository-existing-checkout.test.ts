import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { Store } from '../persistence/loading-store/store'
import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { OrcaRuntimeService } from './orca-runtime'
import { RuntimeRepositoryCloneController } from './runtime-repository-clone-controller'

/**
 * U23: a cloud project pointed at a directory that is already a git repository
 * took the `already-provisioned` short circuit, so nothing registered the
 * checkout in the repo store and every open died as a false forbidden
 * ("That repository is not available to the cloud session."). Provisioning must
 * register the checkout without touching it, and stay idempotent.
 */

let base = ''
let store: Store

beforeAll(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-existing-checkout-')))
  const dataDir = mkdtempSync(join(tmpdir(), 'orca-existing-checkout-data-'))
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

function service(): OrcaRuntimeService {
  return new OrcaRuntimeService(store)
}

function controller(): RuntimeRepositoryCloneController {
  return new RuntimeRepositoryCloneController({
    getStore: () => store,
    invalidateResolvedWorktrees: () => undefined,
    invalidateWorktreeScan: () => undefined,
    notifyReposChanged: () => undefined
  })
}

/** The user's exact starting point: a real checkout with a commit and a file. */
function initExistingRepo(path: string): string {
  mkdirSync(path, { recursive: true })
  git(path, 'init', '-q', '-b', 'trunk')
  git(path, 'config', 'user.email', 'u23@example.com')
  git(path, 'config', 'user.name', 'u23')
  writeFileSync(join(path, 'README.md'), '# already here\n')
  git(path, 'add', '.')
  git(path, 'commit', '-qm', 'pre-existing')
  return git(path, 'rev-parse', 'HEAD').trim()
}

describe('自建项目选「已是 git 仓库」目录（U23 回归）', () => {
  it('prepare 成功（provisioned:false）并登记检出，随后 worktree.createManaged 可建工作区', async () => {
    const projectRoot = join(base, 'u23-existing-repo')
    const headBefore = initExistingRepo(projectRoot)
    const runtime = service()

    const prepared = await runtime.provisionCloudProject({
      projectRoot,
      repoUrl: '',
      defaultBranch: 'trunk'
    })
    expect(prepared).toEqual({ ok: true, provisioned: false })

    const rows = store.getRepos().filter((entry) => entry.path === projectRoot)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe('git')

    // The checkout itself is untouched: same HEAD, same file.
    expect(git(projectRoot, 'rev-parse', 'HEAD').trim()).toBe(headBefore)
    expect(readFileSync(join(projectRoot, 'README.md'), 'utf8')).toBe('# already here\n')

    // The open flow's create now resolves `path:<root>` instead of dying as forbidden.
    const workspaceRoot = join(projectRoot, '.orca-worktrees', 'zhangsan')
    const created = await runtime.createManagedWorktree({
      repoSelector: `path:${projectRoot}`,
      workspaceRoot,
      name: 'trunk',
      baseBranch: 'trunk',
      telemetrySource: 'unknown'
    })
    expect(created.worktree.path.startsWith(`${workspaceRoot}/`)).toBe(true)
    expect(realpathSync(git(created.worktree.path, 'rev-parse', '--show-toplevel').trim())).toBe(
      realpathSync(created.worktree.path)
    )
    expect(
      git(projectRoot, 'worktree', 'list')
        .split('\n')
        .filter((line) => line.trim() !== '')
    ).toHaveLength(2)
  }, 60_000)

  it('幂等：重复 prepare 与重复登记不产生第二行登记', async () => {
    const projectRoot = join(base, 'u23-idempotent')
    initExistingRepo(projectRoot)
    const runtime = service()

    await runtime.provisionCloudProject({ projectRoot, repoUrl: '', defaultBranch: 'trunk' })
    await runtime.provisionCloudProject({ projectRoot, repoUrl: '', defaultBranch: 'trunk' })
    await controller().registerExistingCheckout(projectRoot)
    await controller().registerExistingCheckout(projectRoot)

    expect(store.getRepos().filter((entry) => entry.path === projectRoot)).toHaveLength(1)
    expect(git(projectRoot, 'rev-list', '--count', 'HEAD').trim()).toBe('1')
  }, 60_000)

  it('已登记的检出（管理员登记路径）保持 provisioned:false 且不新增登记行', async () => {
    const projectRoot = join(base, 'u23-admin-registered')
    const headBefore = initExistingRepo(projectRoot)
    store.addRepo({
      id: 'repo-u23-admin',
      path: projectRoot,
      displayName: 'u23-admin-registered',
      badgeColor: 'gray',
      addedAt: 1,
      kind: 'git',
      externalWorktreeVisibilityLegacy: false
    })

    const prepared = await service().provisionCloudProject({
      projectRoot,
      repoUrl: '',
      defaultBranch: 'trunk'
    })
    expect(prepared).toEqual({ ok: true, provisioned: false })
    expect(store.getRepos().filter((entry) => entry.path === projectRoot)).toHaveLength(1)
    expect(git(projectRoot, 'rev-parse', 'HEAD').trim()).toBe(headBefore)
  }, 60_000)
})
