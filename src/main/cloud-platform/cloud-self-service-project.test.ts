import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { readField, readString } from '../../shared/json-fields'
import { callRuntimeEnvironment } from '../ipc/runtime-environment-transport-routing'
import {
  planCloudProjectRepos,
  syncCloudProjectRepos,
  type CloudProjectRepoPorts
} from '../../renderer/src/cloud/cloud-project-repos'
import { PROVISIONING_README, git } from './cloud-project-provisioning-fixture'
import {
  parseEnvironment,
  startSelfServiceHarness,
  type SelfServiceHarness
} from './cloud-self-service-project-fixture'

/**
 * M59: a developer creates a project through the real IPC handler. The platform
 * derives the host path from the host-declared projectsRoot, the host clones for
 * real, the heartbeat turns it ready, and the sidebar plan shows the repo.
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

let harness: SelfServiceHarness

beforeAll(async () => {
  harness = await startSelfServiceHarness(ipcHandlers)
}, 120_000)

afterAll(async () => {
  await harness?.stop()
})

describe('开发者自助创建云端项目（真实平台 + 主机 + TLS Runtime + git）', () => {
  it('M59-1 创建 → 主机 clone 到 projectsRoot/dir → 心跳 ready → 侧栏 repo', async () => {
    const hosts = await harness.listProvisionableHosts()
    expect(hosts).toContainEqual({
      id: harness.hostId,
      name: 'dev-m59-self-service',
      online: true,
      provisionable: true,
      projectDirs: []
    })

    const created = await harness.createProject({
      name: 'Self Service Demo',
      dir: 'self-service-demo',
      repoUrl: harness.repoUrl,
      defaultBranch: 'main'
    })
    expect(readField(created, 'ok')).toBe(true)
    const projectId = readString(created, 'projectId')
    expect(projectId).not.toBeNull()
    const environment = parseEnvironment(readField(created, 'environment'))
    expect(environment).not.toBeNull()
    const projectRoot = join(harness.projectsRoot, 'self-service-demo')
    expect(environment?.projectRoot).toBe(projectRoot)
    expect(environment?.projectName).toBe('Self Service Demo')

    expect(existsSync(join(projectRoot, 'README.md'))).toBe(true)
    expect(readFileSync(join(projectRoot, 'README.md'), 'utf8')).toBe(PROVISIONING_README)
    expect(realpathSync(git(projectRoot, 'rev-parse', '--show-toplevel').trim())).toBe(
      realpathSync(projectRoot)
    )

    const createdProject = await harness.getProject(projectId ?? '')
    expect(readString(createdProject, 'path')).toBe(projectRoot)
    expect(readString(createdProject, 'status')).toBe('provisioning')

    await harness.beat()
    const ready = await harness.getProject(projectId ?? '')
    expect(readString(ready, 'status')).toBe('ready')
    expect(readString(ready, 'provisioningError')).toBeNull()

    const summaries = await harness.session.listProjects()
    const summary = summaries.find((entry) => entry.id === projectId)
    expect(summary?.status).toBe('ready')

    const environments = environment === null ? [] : [environment]
    const plan = planCloudProjectRepos({
      environments,
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
      environments,
      repos: harness.store.getRepos(),
      ports
    })
    expect(sync.failed).toEqual([])
    expect(sync.added.map((repo) => repo.path)).toEqual([projectRoot])
    expect(sync.added[0].displayName).toBe('Self Service Demo')
    expect(added).toEqual([projectId])

    harness.saveEvidence('m59-self-service.json', {
      provisionableHosts: hosts,
      created: { ok: true, projectId, environment },
      createdProject,
      readyProject: ready,
      summary,
      checkout: {
        path: projectRoot,
        readme: readFileSync(join(projectRoot, 'README.md'), 'utf8'),
        toplevel: git(projectRoot, 'rev-parse', '--show-toplevel').trim()
      },
      plan,
      sync,
      hostRepos: harness.store.getRepos().map((repo) => ({ id: repo.id, path: repo.path }))
    })
  }, 240_000)

  it('M59-2 显式 path 被平台拒绝，项目未创建', async () => {
    const result = await harness.createProject({
      name: 'Path Injection',
      dir: 'path-injection',
      key: 'path-injection',
      repoUrl: harness.repoUrl,
      path: join(harness.projectsRoot, '..', 'outside')
    })
    expect(readField(result, 'ok')).toBe(false)
    expect(readString(result, 'code')).toBe('PROJECT_PATH_FORBIDDEN')
    expect(existsSync(join(harness.projectsRoot, '..', 'outside'))).toBe(false)
  })
})
