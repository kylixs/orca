import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { Store } from '../persistence/loading-store/store'
import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { OrcaRuntimeService } from './orca-runtime'
import { MANAGED_WORKTREE_METHODS } from './rpc/methods/worktree-create-managed'

/**
 * U24: two concurrent opens share one create through the idempotency key, and
 * the joiner used to report `created: true` like the winner. The host now marks
 * the joiner's reply (`createdByThisCall: false`), so exactly one caller claims
 * the checkout.
 */

const MANAGED_CREATE = MANAGED_WORKTREE_METHODS[0]

let base = ''
let store: Store

beforeAll(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-create-join-flag-')))
  const dataDir = mkdtempSync(join(tmpdir(), 'orca-create-join-flag-data-'))
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

describe('并发 createManaged 的建出方标志（U24）', () => {
  it('并发 open 共享一次创建：恰一方 createdByThisCall !== false，且只落一个检出', async () => {
    const projectRoot = join(base, 'join-flag-project')
    mkdirSync(projectRoot, { recursive: true })
    git(projectRoot, 'init', '-q', '-b', 'main')
    git(projectRoot, 'config', 'user.email', 'u24@example.com')
    git(projectRoot, 'config', 'user.name', 'u24')
    git(projectRoot, 'commit', '-q', '--allow-empty', '-m', 'init')
    store.addRepo({
      id: 'repo-join-flag',
      path: projectRoot,
      displayName: 'join-flag-project',
      badgeColor: 'gray',
      addedAt: 1,
      kind: 'git',
      externalWorktreeVisibilityLegacy: false
    })
    const runtime = new OrcaRuntimeService(store)
    const params = MANAGED_CREATE.params.parse({
      repo: `path:${projectRoot}`,
      workspaceRoot: join(projectRoot, '.orca-worktrees', 'zhangsan'),
      name: 'main',
      baseBranch: 'main',
      idempotencyKey: 'cloud-open:proj_u24:main'
    })

    const [first, second] = await Promise.all([
      MANAGED_CREATE.handler(params, { runtime }),
      MANAGED_CREATE.handler(params, { runtime })
    ])
    expect(second.worktree.path).toBe(first.worktree.path)
    expect(first.worktree.path.startsWith(`${projectRoot}/.orca-worktrees/`)).toBe(true)
    const claimed = [first, second].filter((result) => result.createdByThisCall !== false)
    expect(claimed).toHaveLength(1)
    expect(
      git(projectRoot, 'worktree', 'list')
        .split('\n')
        .filter((line) => line.trim() !== '')
    ).toHaveLength(2)
  }, 60_000)
})
