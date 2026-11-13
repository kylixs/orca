import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { readField, readString } from '../../shared/json-fields'
import { planCloudProjectRepos } from '../../renderer/src/cloud/cloud-project-repos'
import { REPO_ROOT } from './cloud-session-e2e-harness'
import { PROVISIONING_README, git } from './cloud-project-provisioning-fixture'
import {
  parseEnvironment,
  startSelfServiceHarness,
  type SelfServiceHarness
} from './cloud-self-service-project-fixture'

/**
 * M60: creation succeeds on the platform, preparation fails, and the failure
 * keeps its project identity so the M58 retry banner can recover it.
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

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm60-create-failure-recovery')

function saveEvidence(file: string, content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, file), JSON.stringify(content, null, 2))
}

function projectRow(rows: unknown[], id: string | null): unknown {
  return rows.find((row) => readString(row, 'id') === id)
}

let harness: SelfServiceHarness

beforeAll(async () => {
  harness = await startSelfServiceHarness(ipcHandlers)
}, 120_000)

afterAll(async () => {
  await harness?.stop()
})

describe('创建成功但准备失败的项目可恢复（真实平台 + 主机 + TLS Runtime + git）', () => {
  it('M60-1 创建返回 projectId → 平台 failed → 管理员修正 → 重试 → ready → 侧栏', async () => {
    const missingRepo = join(harness.base, 'missing-source.git')
    expect(existsSync(missingRepo)).toBe(false)

    const created = await harness.createProject({
      name: 'Broken Source',
      repoUrl: missingRepo,
      defaultBranch: 'main'
    })
    expect(readField(created, 'ok')).toBe(false)
    expect(readString(created, 'code')).toBe('CLONE_FAILED')
    const projectId = readString(created, 'projectId')
    expect(projectId).not.toBeNull()
    const createdProject = readField(created, 'project')
    expect(readString(createdProject, 'name')).toBe('Broken Source')
    expect(readString(createdProject, 'key')).toBe('broken-source')
    expect(readString(createdProject, 'status')).toBe('provisioning')

    await harness.beat()
    const failedRow = projectRow(await harness.listPlatformProjects(), projectId)
    expect(readString(failedRow, 'status')).toBe('failed')
    expect(readString(failedRow, 'provisioningError')).toContain('CLONE_FAILED')

    const updated = await harness.adminFetch(`/v1/projects/${projectId}`, {
      method: 'PUT',
      body: JSON.stringify({ repoUrl: harness.repoUrl, defaultBranch: 'main' })
    })
    expect(updated.status).toBe(200)
    expect(readString(await updated.json(), 'status')).toBe('provisioning')

    const retried = await harness.retryPrepare(projectId ?? '')
    expect(readField(retried, 'ok')).toBe(true)
    const environment = parseEnvironment(readField(retried, 'environment'))
    const projectRoot = join(harness.projectsRoot, 'broken-source')
    expect(environment?.projectRoot).toBe(projectRoot)
    expect(existsSync(join(projectRoot, 'README.md'))).toBe(true)
    expect(readFileSync(join(projectRoot, 'README.md'), 'utf8')).toBe(PROVISIONING_README)
    expect(realpathSync(git(projectRoot, 'rev-parse', '--show-toplevel').trim())).toBe(
      realpathSync(projectRoot)
    )

    await harness.beat()
    const ready = await harness.getProject(projectId ?? '')
    expect(readString(ready, 'status')).toBe('ready')
    expect(readString(ready, 'provisioningError')).toBeNull()

    const plan = planCloudProjectRepos({
      environments: environment === null ? [] : [environment],
      repos: harness.store.getRepos()
    })
    expect(plan.add.map((target) => target.path)).toEqual([projectRoot])

    saveEvidence('m60-create-failure.json', {
      created: { ok: false, code: 'CLONE_FAILED', projectId, project: createdProject },
      failedPlatformProject: failedRow,
      updatedPlatformProject: {
        status: 'provisioning',
        repoUrl: harness.repoUrl
      },
      retried: { ok: true, environment },
      checkout: {
        path: projectRoot,
        readme: readFileSync(join(projectRoot, 'README.md'), 'utf8'),
        toplevel: git(projectRoot, 'rev-parse', '--show-toplevel').trim()
      },
      readyPlatformProject: ready,
      plan
    })
  }, 240_000)
})
