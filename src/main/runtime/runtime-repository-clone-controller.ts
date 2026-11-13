import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { DEFAULT_REPO_BADGE_COLOR } from '../../shared/constants'
import {
  getRepoSshConnectionId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../shared/execution-host'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import type { Repo } from '../../shared/repo-types'
import { getGitCloneFailureMessage } from '../../shared/git-clone-failure-message'
import {
  cleanupClaimedCloneTarget,
  claimCloneTarget,
  deriveValidatedClonePath,
  getClonePathComparisonKey,
  type ClaimedCloneTarget
} from '../git/repo-clone-path'
import { gitSpawnAfterWindowsEnvironmentReady, promptGuardGitEnv } from '../git/runner'
import { reuseSavedCloneTarget } from '../git/saved-clone-target'
import { runWithGitReadCacheInvalidation } from '../git/status'
import { invalidateAuthorizedRootsCache } from '../ipc/filesystem-auth'
import { isFolderRepo } from '../../shared/repo-kind'
import { detectRepoIconAndUpstream } from '../repo-icon-autodetect'
import { getRepoName } from '../git/repo'
import { prepareLocalWorktreeRootForRepo } from '../worktree-root-preparation'
import type { RuntimeStore } from './runtime-store-contract'
import { runtimeRepoMatchesExecutionHost } from './runtime-worktree-selection'

type RuntimeRepositoryCloneDependencies = {
  getStore: () => RuntimeStore | null
  invalidateResolvedWorktrees: () => void
  invalidateWorktreeScan: (repoId: string) => void
  notifyReposChanged: () => void
}

export class RuntimeRepositoryCloneController {
  private readonly inFlightByPath = new Map<string, Promise<void>>()

  constructor(private readonly deps: RuntimeRepositoryCloneDependencies) {}

  async clone(
    url: string,
    destination: string,
    executionHostId?: ExecutionHostId | null
  ): Promise<Repo> {
    if (!this.deps.getStore()) {
      throw new Error('runtime_unavailable')
    }
    const trimmedUrl = url.trim()
    const trimmedDestination = destination.trim()
    if (!trimmedDestination) {
      throw new Error('Clone destination is required')
    }
    const clonePath = deriveValidatedClonePath({ url: trimmedUrl, destination: trimmedDestination })
    const clonePathKey = getClonePathComparisonKey(clonePath)
    return this.withPathLock(clonePathKey, () =>
      runWithGitReadCacheInvalidation(() =>
        this.cloneAfterPathLock(
          trimmedUrl,
          trimmedDestination,
          clonePath,
          clonePathKey,
          executionHostId
        )
      )
    )
  }

  /**
   * Cloud provisioning clones into the exact path signed into the ticket, rather
   * than `destination/<repo name>`. Local-only by construction: git runs in this
   * process, so the checkout is always on this host.
   */
  async cloneToPath(
    url: string,
    checkoutPath: string,
    options: { branch?: string } = {}
  ): Promise<Repo> {
    if (!this.deps.getStore()) {
      throw new Error('runtime_unavailable')
    }
    const trimmedUrl = url.trim()
    const target = checkoutPath.trim()
    if (
      !target ||
      !isAbsolute(target) ||
      (process.platform !== 'win32' && isWindowsAbsolutePathLike(target))
    ) {
      throw new Error('Clone checkout path must be an absolute path')
    }
    const clonePathKey = getClonePathComparisonKey(target)
    return this.withPathLock(clonePathKey, () =>
      runWithGitReadCacheInvalidation(async () => {
        // Why always clone: the caller only asks when the path is not a repo, and a
        // stale store row must not hide a checkout that was deleted underneath it.
        await mkdir(dirname(target), { recursive: true })
        const claimedTarget = await claimCloneTarget(target)
        await this.runGitClone(trimmedUrl, target, dirname(target), claimedTarget, options.branch)
        return this.finishClone(target, clonePathKey, LOCAL_EXECUTION_HOST_ID)
      })
    )
  }

  private async withPathLock<T>(clonePathKey: string, run: () => Promise<T>): Promise<T> {
    const previous = this.inFlightByPath.get(clonePathKey) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(
      () => current,
      () => current
    )
    this.inFlightByPath.set(clonePathKey, tail)
    try {
      await previous
      return await run()
    } finally {
      release()
      if (this.inFlightByPath.get(clonePathKey) === tail) {
        this.inFlightByPath.delete(clonePathKey)
      }
    }
  }

  private findSavedAtPath(
    clonePathKey: string,
    executionHostId?: ExecutionHostId | null
  ): Repo | undefined {
    return this.deps
      .getStore()
      ?.getRepos()
      .find((repo) => {
        return (
          getClonePathComparisonKey(repo.path) === clonePathKey &&
          runtimeRepoMatchesExecutionHost(repo, executionHostId) &&
          !getRepoSshConnectionId(repo)
        )
      })
  }

  private async cloneAfterPathLock(
    trimmedUrl: string,
    trimmedDestination: string,
    clonePath: string,
    clonePathKey: string,
    executionHostId?: ExecutionHostId | null
  ): Promise<Repo> {
    if (!this.deps.getStore()) {
      throw new Error('runtime_unavailable')
    }
    const reused = await reuseSavedCloneTarget(
      () => this.findSavedAtPath(clonePathKey, executionHostId),
      trimmedUrl,
      LOCAL_EXECUTION_HOST_ID
    )
    if (reused) {
      return reused
    }

    await mkdir(trimmedDestination, { recursive: true })
    const claimedTarget = await claimCloneTarget(clonePath)
    await this.runGitClone(trimmedUrl, clonePath, trimmedDestination, claimedTarget)
    return this.finishClone(clonePath, clonePathKey, executionHostId)
  }

  private async runGitClone(
    url: string,
    checkoutPath: string,
    cwd: string,
    claimedTarget: ClaimedCloneTarget,
    branch?: string
  ): Promise<void> {
    let proc: Awaited<ReturnType<typeof gitSpawnAfterWindowsEnvironmentReady>>
    try {
      proc = await gitSpawnAfterWindowsEnvironmentReady(
        ['clone', '--progress', ...(branch ? ['--branch', branch] : []), '--', url, checkoutPath],
        {
          cwd,
          admissionTier: 'interactive',
          env: promptGuardGitEnv(),
          stdio: ['ignore', 'ignore', 'pipe']
        }
      )
    } catch (error) {
      await cleanupClaimedCloneTarget(checkoutPath, claimedTarget)
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Clone failed: ${message}`)
    }
    await new Promise<void>((resolve, reject) => {
      let stderrTail = ''
      let settled = false
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-4096)
      })
      const finish = async (code: number | null, signal: NodeJS.Signals | null, error?: Error) => {
        if (settled) {
          return
        }
        settled = true
        if (error || code !== 0 || signal) {
          await cleanupClaimedCloneTarget(checkoutPath, claimedTarget)
        }
        if (error) {
          reject(new Error(`Clone failed: ${error.message}`))
        } else if (signal === 'SIGTERM') {
          reject(new Error('Clone aborted'))
        } else if (code === 0) {
          resolve()
        } else {
          reject(
            new Error(
              `Clone failed: ${getGitCloneFailureMessage(stderrTail, { clonePath: checkoutPath })}`
            )
          )
        }
      }
      proc.on('error', (error) => void finish(null, null, error))
      proc.on('close', (code, signal) => void finish(code, signal))
    })
  }

  private async finishClone(
    clonePath: string,
    clonePathKey: string,
    executionHostId?: ExecutionHostId | null
  ): Promise<Repo> {
    const store = this.deps.getStore()
    if (!store) {
      throw new Error('runtime_unavailable')
    }
    const existing = this.findSavedAtPath(clonePathKey, executionHostId)
    if (existing) {
      if (isFolderRepo(existing)) {
        const updated = store.updateRepo(existing.id, { kind: 'git' })
        if (updated) {
          await prepareLocalWorktreeRootForRepo(store, updated)
          invalidateAuthorizedRootsCache()
          this.invalidate(updated.id)
          return updated
        }
      }
      // Why: git re-created this project's folder, so its worktree root is gone with it and the
      // authorized-roots cache still holds the answers from before the folder came back.
      await prepareLocalWorktreeRootForRepo(store, existing)
      invalidateAuthorizedRootsCache()
      this.invalidate(existing.id)
      return existing
    }
    // `runGitClone` ran `git clone` in this process, so the checkout is here
    // regardless of the host id stamped on the row.
    const detected = await detectRepoIconAndUpstream({
      repoPath: clonePath,
      kind: 'git',
      executionHostId: LOCAL_EXECUTION_HOST_ID
    })
    const repo: Repo = {
      id: randomUUID(),
      path: clonePath,
      displayName: getRepoName(clonePath),
      badgeColor: DEFAULT_REPO_BADGE_COLOR,
      ...(executionHostId != null ? { executionHostId } : {}),
      ...detected,
      addedAt: Date.now(),
      kind: 'git',
      externalWorktreeVisibilityLegacy: false
    }
    store.addRepo(repo)
    await prepareLocalWorktreeRootForRepo(store, repo)
    invalidateAuthorizedRootsCache()
    this.invalidate(repo.id)
    return store.getRepo(repo.id) ?? repo
  }

  private invalidate(repoId: string): void {
    this.deps.invalidateResolvedWorktrees()
    this.deps.invalidateWorktreeScan(repoId)
    this.deps.notifyReposChanged()
  }
}
