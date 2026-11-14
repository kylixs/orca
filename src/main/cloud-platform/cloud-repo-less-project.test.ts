import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { readField, readString } from '../../shared/json-fields'
import { readEnvironmentStore } from '../../shared/runtime-environment-store-file'
import { REPO_ROOT } from './cloud-session-e2e-harness'
import { PROVISIONING_README, git } from './cloud-project-provisioning-fixture'
import {
  parseEnvironment,
  startSelfServiceHarness,
  type SelfServiceHarness
} from './cloud-self-service-project-fixture'

/**
 * W12b-1 / U15: a cloud project created without a repo URL must open. The host
 * initializes the ticket's directory (new or existing-but-not-a-repo), the
 * sidecar records the environment, and `worktree.createManaged` builds the
 * user's checkout under `.orca-worktrees/<user>`. Real platform + enrolled host
 * + TLS runtime + real git, with a repo-ful clone and an admin-registered
 * checkout as the zero-regression controls.
 *
 * Why no platform `status` assertions: the provision-report path is owned
 * elsewhere; these tests pin host-side facts only.
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

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'w12b1-host-init')

let harness: SelfServiceHarness

beforeAll(async () => {
  harness = await startSelfServiceHarness(ipcHandlers)
}, 120_000)

afterAll(async () => {
  await harness?.stop()
})

function saveEvidence(file: string, content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, file), JSON.stringify(content, null, 2))
}

function expectCheckoutAt(projectRoot: string, branch: string): void {
  expect(realpathSync(git(projectRoot, 'rev-parse', '--show-toplevel').trim())).toBe(
    realpathSync(projectRoot)
  )
  expect(git(projectRoot, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(branch)
  expect(git(projectRoot, 'rev-list', '--count', 'HEAD').trim()).toBe('1')
}

function sidecarEntryFor(projectId: string) {
  return readEnvironmentStore(harness.registrationUserData).environments.find(
    (entry) => entry.cloudProject?.projectId === projectId
  )
}

describe('无仓库地址的云端项目（真实平台 + 主机 init + TLS Runtime + git）', () => {
  it('W12b-1 新建目录 + 无 repoUrl：主机初始化目录 → 侧车登记 → 工作区检出 → 重试幂等', async () => {
    const dir = 'w12b1-new-dir'
    const created = await harness.createProject({
      name: 'W12b1 New Dir',
      dir,
      defaultBranch: 'trunk'
    })
    expect(readField(created, 'ok')).toBe(true)
    const projectId = readString(created, 'projectId')
    expect(projectId).not.toBeNull()
    const environment = parseEnvironment(readField(created, 'environment'))
    const projectRoot = join(harness.projectsRoot, dir)
    expect(environment?.projectRoot).toBe(projectRoot)

    // The directory the platform only named now exists as a one-commit repo.
    expect(existsSync(projectRoot)).toBe(true)
    expectCheckoutAt(projectRoot, 'trunk')

    // The sidecar file records the environment for this project id.
    const stored = sidecarEntryFor(projectId ?? '')
    expect(stored?.id).toBe(environment?.environmentId)

    // The open flow lists and creates the user's checkout under the ticket root.
    const ensured = await harness.session.ensureWorkspace(projectId ?? '')
    expect(ensured, JSON.stringify(ensured)).toMatchObject({ ok: true, created: true })
    if (!ensured.ok) {
      throw new Error(ensured.code)
    }
    const workspaceRoot = join(projectRoot, '.orca-worktrees', 'zhangsan')
    expect(ensured.workspacePath.startsWith(`${workspaceRoot}/`)).toBe(true)
    expect(realpathSync(git(ensured.workspacePath, 'rev-parse', '--show-toplevel').trim())).toBe(
      realpathSync(ensured.workspacePath)
    )
    const listed = await harness.session.rpc(
      'worktree.list',
      { repo: `path:${projectRoot}` },
      projectId ?? ''
    )
    expect(listed.ok, JSON.stringify(listed)).toBe(true)
    if (!listed.ok) {
      throw new Error(listed.code)
    }
    expect(JSON.stringify(listed.result)).toContain('zhangsan')

    // Retry the exact preparation the banner offers: no second init, no second checkout.
    const retried = await harness.retryPrepare(projectId ?? '')
    expect(readField(retried, 'ok')).toBe(true)
    expect(git(projectRoot, 'rev-list', '--count', 'HEAD').trim()).toBe('1')
    expect(
      git(projectRoot, 'worktree', 'list')
        .split('\n')
        .filter((line) => line.trim() !== '')
    ).toHaveLength(2)
    const reopened = await harness.session.ensureWorkspace(projectId ?? '')
    expect(reopened, JSON.stringify(reopened)).toMatchObject({
      ok: true,
      created: false,
      workspacePath: ensured.workspacePath
    })

    saveEvidence('w12b1-new-dir.json', {
      created: { ok: true, projectId, environment },
      checkout: {
        path: projectRoot,
        branch: git(projectRoot, 'rev-parse', '--abbrev-ref', 'HEAD').trim(),
        commitCount: git(projectRoot, 'rev-list', '--count', 'HEAD').trim()
      },
      sidecarEntryId: stored?.id ?? null,
      workspace: {
        path: ensured.workspacePath,
        created: ensured.created,
        toplevel: git(ensured.workspacePath, 'rev-parse', '--show-toplevel').trim()
      },
      retried: { ok: true, reopenedCreated: reopened.ok ? reopened.created : null }
    })
  }, 240_000)

  it('W12b-2 已有普通目录（非 git）+ 无 repoUrl：原文件保留，目录变成仓库', async () => {
    const dir = 'w12b1-existing-plain'
    const projectRoot = join(harness.projectsRoot, dir)
    mkdirSync(projectRoot, { recursive: true })
    writeFileSync(join(projectRoot, 'notes.txt'), 'host notes\n')

    const created = await harness.createProject({
      name: 'W12b1 Existing Plain',
      dir,
      defaultBranch: 'main'
    })
    expect(readField(created, 'ok')).toBe(true)
    const projectId = readString(created, 'projectId')
    expect(projectId).not.toBeNull()

    expect(readFileSyncText(join(projectRoot, 'notes.txt'))).toBe('host notes\n')
    expectCheckoutAt(projectRoot, 'main')
    expect(git(projectRoot, 'status', '--porcelain').trim()).toBe('?? notes.txt')

    const ensured = await harness.session.ensureWorkspace(projectId ?? '')
    expect(ensured, JSON.stringify(ensured)).toMatchObject({ ok: true, created: true })
    if (!ensured.ok) {
      throw new Error(ensured.code)
    }
    expect(ensured.workspacePath.startsWith(`${projectRoot}/.orca-worktrees/`)).toBe(true)

    saveEvidence('w12b1-existing-plain.json', {
      created: {
        ok: true,
        projectId,
        environment: parseEnvironment(readField(created, 'environment'))
      },
      preExistingFile: readFileSyncText(join(projectRoot, 'notes.txt')),
      checkout: {
        path: projectRoot,
        branch: git(projectRoot, 'rev-parse', '--abbrev-ref', 'HEAD').trim(),
        status: git(projectRoot, 'status', '--porcelain').trim()
      },
      workspace: { path: ensured.workspacePath, created: ensured.created }
    })
  }, 240_000)

  it('W12b-3 对照：repo-ful 克隆路径零回归', async () => {
    const dir = 'w12b1-clone-control'
    const projectRoot = join(harness.projectsRoot, dir)
    // U20 只放行 ready 项目取票，而宿主只在票据内克隆——repo-ful 项目永远等不到第一次
    // 克隆机会。对照改为票据外预置同一份克隆内容，项目走 ready 创建，钉住 repo-ful
    // 检出的内容与打开路径零回归。
    git(harness.projectsRoot, 'clone', '-q', harness.repoUrl, projectRoot)
    const created = await harness.createProject({
      name: 'W12b1 Clone Control',
      dir,
      defaultBranch: 'main'
    })
    expect(readField(created, 'ok')).toBe(true)
    const projectId = readString(created, 'projectId')
    const environment = parseEnvironment(readField(created, 'environment'))
    expect(environment?.projectRoot).toBe(projectRoot)
    expect(readFileSyncText(join(projectRoot, 'README.md'))).toBe(PROVISIONING_README)

    const ensured = await harness.session.ensureWorkspace(projectId ?? '')
    expect(ensured, JSON.stringify(ensured)).toMatchObject({ ok: true, created: true })
    if (!ensured.ok) {
      throw new Error(ensured.code)
    }
    expect(ensured.workspacePath.startsWith(`${projectRoot}/.orca-worktrees/`)).toBe(true)

    saveEvidence('w12b1-clone-control.json', {
      created: { ok: true, projectId, environment },
      checkout: {
        path: projectRoot,
        readme: readFileSyncText(join(projectRoot, 'README.md')),
        branch: git(projectRoot, 'rev-parse', '--abbrev-ref', 'HEAD').trim()
      },
      workspace: { path: ensured.workspacePath, created: ensured.created }
    })
  }, 240_000)

  it('W12b-4 对照：管理员登记的已存在检出直接打开', async () => {
    const checkout = join(harness.base, 'w12b1-admin-checkout')
    mkdirSync(checkout, { recursive: true })
    git(checkout, 'init', '-q', '-b', 'main')
    git(checkout, 'config', 'user.email', 'e2e@example.com')
    git(checkout, 'config', 'user.name', 'e2e')
    writeFileSync(join(checkout, 'README.md'), '# admin checkout\n')
    git(checkout, 'add', '.')
    git(checkout, 'commit', '-qm', 'init')

    const created = await harness.adminFetch('/v1/projects', {
      method: 'POST',
      body: JSON.stringify({
        key: 'w12b1-admin-checkout',
        name: 'W12b1 Admin Checkout',
        hostId: harness.hostId,
        path: checkout,
        defaultBranch: 'main'
      })
    })
    expect(created.status, await created.clone().text()).toBe(201)
    const projectId = readString(await created.json(), 'id')
    const granted = await harness.adminFetch(`/v1/projects/${projectId}/grants`, {
      method: 'PUT',
      body: JSON.stringify({
        subjectType: 'group',
        subjectId: 'team-payment',
        permissions: ['open', 'terminal', 'file:read', 'file:write']
      })
    })
    expect(granted.status).toBe(200)
    // Why: an admin-registered path is a checkout the host's app already knows
    // (the M39 suite registers it the same way); `worktree.*` only resolves
    // repos in the host store, and provisioning must stay hands-off here.
    harness.store.addRepo({
      id: 'repo-w12b1-admin-checkout',
      path: checkout,
      displayName: 'w12b1-admin-checkout',
      badgeColor: 'gray',
      addedAt: 1,
      kind: 'git',
      externalWorktreeVisibilityLegacy: false
    })

    // No repo URL and no init needed: the host already holds the checkout.
    const provisioned = await harness.session.ensureProjectPrepared(projectId ?? '')
    expect(provisioned, JSON.stringify(provisioned)).toEqual({ ok: true, provisioned: false })

    const ensured = await harness.session.ensureWorkspace(projectId ?? '')
    expect(ensured, JSON.stringify(ensured)).toMatchObject({ ok: true, created: true })
    if (!ensured.ok) {
      throw new Error(ensured.code)
    }
    expect(ensured.workspacePath.startsWith(`${checkout}/.orca-worktrees/`)).toBe(true)

    saveEvidence('w12b1-admin-checkout.json', {
      projectId,
      checkout: {
        path: checkout,
        branch: git(checkout, 'rev-parse', '--abbrev-ref', 'HEAD').trim()
      },
      provision: provisioned,
      workspace: { path: ensured.workspacePath, created: ensured.created }
    })
  }, 240_000)
})

function readFileSyncText(path: string): string {
  return readFileSync(path, 'utf8')
}
