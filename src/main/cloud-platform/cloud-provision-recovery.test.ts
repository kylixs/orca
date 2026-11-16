import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CloudProjectEnvironment } from '../../shared/cloud-platform-ipc'
import { readField, readString } from '../../shared/json-fields'
import { callRuntimeEnvironment } from '../ipc/runtime-environment-transport-routing'
import {
  planCloudProjectRepos,
  syncCloudProjectRepos,
  type CloudProjectRepoPorts
} from '../../renderer/src/cloud/cloud-project-repos'
import { PROVISIONING_README, git, makeBareRepository } from './cloud-project-provisioning-fixture'
import { startRecoveryHarness, type RecoveryHarness } from './cloud-provision-recovery-fixture'

/**
 * M58: a provisioning failure must be visible and recoverable. The admin fixes
 * the repo URL on the platform, the client retries, the host clones for real, and
 * the heartbeat turns the project ready. Real platform, host, TLS runtime, git.
 */

type IpcHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>
const ipcHandlers = vi.hoisted(() => new Map<string, IpcHandler>())

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => ipcHandlers.set(channel, handler),
    removeHandler: (channel: string) => ipcHandlers.delete(channel)
  },
  BrowserWindow: { getAllWindows: () => [] }
}))

let harness: RecoveryHarness

beforeAll(async () => {
  harness = await startRecoveryHarness(ipcHandlers)
}, 120_000)

afterAll(async () => {
  await harness?.stop()
})

describe('云端项目准备失败可恢复（真实平台 + 真实 TLS Runtime + 真实 git）', () => {
  it('M58-1 失败可见 → 管理员修正 → 重试真实 clone → 心跳 ready → 侧栏 repo', async () => {
    const { projectId, projectRoot } = harness
    // U44: a provisioning project is "preparing", not a failure.
    const first = await harness.registerProjects()
    expect(first.environments).toEqual([])
    expect(first.failures).toEqual([])

    const failedDeadline = Date.now() + 60_000
    let failed = await harness.getProject(projectId)
    while (readString(failed, 'status') !== 'failed' && Date.now() < failedDeadline) {
      await harness.beat()
      failed = await harness.getProject(projectId)
    }
    expect(readString(failed, 'status')).toBe('failed')
    expect(readString(failed, 'provisioningError')).toContain('CLONE_FAILED')
    const summaries = await harness.session.listProjects()
    const failedSummary = summaries.find((entry) => entry.id === projectId)
    expect(failedSummary?.status).toBe('failed')
    expect(failedSummary?.provisioningError).toContain('CLONE_FAILED')

    // The failure is visible once the kick reports it; the connect gate names it.
    const blocked = await harness.registerProjects()
    expect(blocked.environments).toEqual([])
    expect(blocked.failures).toHaveLength(1)
    expect(blocked.failures[0]).toMatchObject({ projectId, code: 'PROJECT_NOT_PREPARED' })
    expect(blocked.failures[0].projectName).toBe('Recovered Service')

    makeBareRepository(harness.base)
    const updated = await harness.adminFetch(`/v1/projects/${projectId}`, {
      method: 'PUT',
      body: JSON.stringify({
        repoUrl: harness.repoUrlFor('payment-service.git'),
        defaultBranch: 'main'
      })
    })
    expect(updated.status).toBe(200)
    const updatedBody: unknown = await updated.json()
    expect(readString(updatedBody, 'status')).toBe('provisioning')
    expect(readString(updatedBody, 'provisioningError')).toBeNull()

    // U37: the next beats assign the fixed repo to the host and report it ready.
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      await harness.beat()
      if (readString(await harness.getProject(projectId), 'status') === 'ready') {
        break
      }
    }

    const retried = await harness.retryPrepare(projectId)
    expect(readField(retried, 'ok')).toBe(true)
    const environmentRaw = readField(retried, 'environment')
    const environment: CloudProjectEnvironment = {
      projectId: readString(environmentRaw, 'projectId') ?? '',
      projectName: readString(environmentRaw, 'projectName') ?? '',
      projectRoot: readString(environmentRaw, 'projectRoot') ?? '',
      environmentId: readString(environmentRaw, 'environmentId') ?? ''
    }
    expect(environment.projectRoot).toBe(projectRoot)
    expect(existsSync(join(projectRoot, 'README.md'))).toBe(true)
    expect(readFileSync(join(projectRoot, 'README.md'), 'utf8')).toBe(PROVISIONING_README)
    expect(realpathSync(git(projectRoot, 'rev-parse', '--show-toplevel').trim())).toBe(
      realpathSync(projectRoot)
    )

    await harness.beat()
    const ready = await harness.getProject(projectId)
    expect(readString(ready, 'status')).toBe('ready')
    expect(readString(ready, 'provisioningError')).toBeNull()

    const second = await harness.registerProjects()
    expect(second.failures).toEqual([])
    expect(second.environments.map((entry) => entry.projectId)).toEqual([projectId])

    const plan = planCloudProjectRepos({
      environments: second.environments,
      repos: harness.store.getRepos()
    })
    expect(plan.add.map((target) => target.path)).toEqual([projectRoot])

    const added: string[] = []
    const ports: Pick<CloudProjectRepoPorts, 'addRepo' | 'renameRepo'> = {
      addRepo: async (target) => {
        added.push(target.projectId)
        const response = await callRuntimeEnvironment(
          harness.registrationUserData,
          target.environmentId,
          'repo.add',
          { path: target.path, kind: 'git', displayName: target.displayName }
        )
        return response.ok === true ? harness.repoOf(response.result) : null
      },
      renameRepo: () => undefined
    }
    const sync = await syncCloudProjectRepos({
      environments: second.environments,
      repos: harness.store.getRepos(),
      ports
    })
    expect(sync.failed).toEqual([])
    expect(sync.added.map((repo) => repo.path)).toEqual([projectRoot])
    expect(sync.added[0].displayName).toBe('Recovered Service')
    expect(added).toEqual([projectId])

    harness.saveEvidence('m58-recovery.json', {
      firstRegistration: first,
      failedProject: failed,
      failedSummary,
      updatedProject: updatedBody,
      retried: { ok: true, environment },
      checkout: {
        path: projectRoot,
        readme: readFileSync(join(projectRoot, 'README.md'), 'utf8'),
        toplevel: git(projectRoot, 'rev-parse', '--show-toplevel').trim()
      },
      readyProject: ready,
      secondRegistration: second,
      plan,
      sync,
      hostRepos: harness.store.getRepos().map((repo) => ({ id: repo.id, path: repo.path }))
    })
  }, 240_000)
})
