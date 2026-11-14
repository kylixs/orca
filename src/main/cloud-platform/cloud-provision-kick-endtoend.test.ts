import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { readArrayValue, readField, readString } from '../../shared/json-fields'
import { REPO_ROOT } from './cloud-session-e2e-harness'
import { PROVISIONING_README, git } from './cloud-project-provisioning-fixture'
import {
  startSelfServiceHarness,
  type SelfServiceHarness
} from './cloud-self-service-project-fixture'

/**
 * U37-C: the user's exact scenario end to end. A developer creates a repo-ful
 * project through the platform with no operator in the loop; the heartbeat's
 * assignment makes the host clone it outside any ticket, the existing
 * `provisioned[]` report flips the platform ready, and only then does the
 * ticket path run — as an `already-provisioned` short circuit. Real platform +
 * enrolled host + TLS runtime + real git.
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

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'u37c-kick-e2e')

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

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`condition not reached: ${what}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function auditEvents(eventType: string): Promise<unknown[]> {
  const res = await harness.adminFetch(`/v1/audit/events?eventType=${eventType}&limit=200`)
  expect(res.status).toBe(200)
  return readArrayValue(readField(await res.json(), 'events')) ?? []
}

function pathSeen(repos: { path: string }[], target: string): boolean {
  const resolved = realpathSync(target)
  return repos.some((repo) => {
    try {
      return realpathSync(repo.path) === resolved
    } catch {
      return false
    }
  })
}

describe('U37-C 心跳 kick 端到端（真实平台 + 真实注册宿主 + TLS + git）', () => {
  it('创建带 repoUrl → 心动指派 → 宿主克隆 → 回报 ready → 取票 already-provisioned → 打开工作区', async () => {
    const dir = 'u37c-kick-e2e'
    const projectRoot = join(harness.projectsRoot, dir)

    // 1) Developer creates the repo-ful self-service project. No host action yet.
    const created = await harness.session.createProject({
      name: 'U37C Kick E2E',
      dir,
      repoUrl: harness.repoUrl,
      defaultBranch: 'main'
    })
    expect(created.ok).toBe(true)
    if (!created.ok) {
      throw new Error(created.code)
    }
    const projectId = created.projectId
    expect(readString(await harness.getProject(projectId), 'status')).toBe('provisioning')
    expect(existsSync(projectRoot)).toBe(false)

    // 2) One heartbeat carries the assignment; the host clones without any ticket.
    await harness.beatOnce()
    await waitFor(() => existsSync(join(projectRoot, 'README.md')), 'kick clone to land')
    await waitFor(
      () => pathSeen(harness.store.getRepos(), projectRoot),
      'host to register the checkout'
    )
    expect(readFileSync(join(projectRoot, 'README.md'), 'utf8')).toBe(PROVISIONING_README)
    expect(realpathSync(git(projectRoot, 'rev-parse', '--show-toplevel').trim())).toBe(
      realpathSync(projectRoot)
    )
    expect(git(projectRoot, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main')

    // 3) The next beat carries provisioned[] and the platform flips provisioning → ready.
    // Why the pause: the report is queued right after the clone registration, so one
    // more beat lands it — and keeps the downlink to exactly one non-empty beat.
    await new Promise((resolve) => setTimeout(resolve, 100))
    await harness.beatOnce()
    const ready = await harness.getProject(projectId)
    expect(readString(ready, 'status')).toBe('ready')
    expect(readString(ready, 'provisioningError')).toBeNull()
    const afterReady = await harness.beatOnce().then(() => harness.getProject(projectId))
    expect(readString(afterReady, 'status')).toBe('ready')

    // 4) Connect now mints a ticket; the ticket's provision RPC is the idempotent
    // already-provisioned short circuit (no second clone, no platform write).
    const prepared = await harness.session.ensureProjectPrepared(projectId)
    expect(prepared).toEqual({ ok: true, provisioned: false })

    const ensured = await harness.session.ensureWorkspace(projectId)
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
      projectId
    )
    expect(listed.ok, JSON.stringify(listed)).toBe(true)
    if (!listed.ok) {
      throw new Error(listed.code)
    }
    expect(JSON.stringify(listed.result)).toContain('zhangsan')

    // 5) Audit chain: one batched assignment (never one per project) + one clone success.
    const assignEvents = (await auditEvents('provision_assign')).filter(
      (event) => readString(event, 'targetId') === harness.hostId
    )
    expect(assignEvents).toHaveLength(1)
    expect(readString(assignEvents[0], 'result')).toBe('success')
    expect(readField(assignEvents[0], 'metadata')).toMatchObject({
      count: 1,
      projectIds: [projectId]
    })

    const provisionEvents = (await auditEvents('project_provision')).filter(
      (event) => readString(event, 'targetId') === projectId
    )
    expect(provisionEvents).toHaveLength(1)
    expect(readString(provisionEvents[0], 'result')).toBe('success')

    saveEvidence('u37c-kick-e2e.json', {
      created: {
        ok: true,
        projectId,
        status: created.project.status,
        path: projectRoot
      },
      kick: {
        assignmentBeat: true,
        clonedByHost: true,
        readme: readFileSync(join(projectRoot, 'README.md'), 'utf8'),
        toplevel: git(projectRoot, 'rev-parse', '--show-toplevel').trim(),
        branch: git(projectRoot, 'rev-parse', '--abbrev-ref', 'HEAD').trim()
      },
      stateMachine: {
        before: 'provisioning',
        after: readString(ready, 'status'),
        provisioningError: readString(ready, 'provisioningError')
      },
      ticketPath: {
        ensureProjectPrepared: prepared,
        ensureWorkspace: ensured,
        worktreeList: listed.result
      },
      audit: {
        provisionAssign: assignEvents,
        projectProvision: provisionEvents
      }
    })
  }, 240_000)
})
