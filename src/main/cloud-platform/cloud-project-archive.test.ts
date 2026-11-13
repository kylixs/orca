import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { readEnvironmentStore } from '../../shared/runtime-environment-store-file'
import { toRuntimeExecutionHostId } from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import { cloudProjectReposOnHosts } from '../../renderer/src/cloud/cloud-project-repos'
import { connectCloudSession, openPlatformSession } from './cloud-session-e2e-harness'
import { startArchiveHarness, type ArchiveHarness } from './cloud-project-archive-fixture'

/**
 * M65: archiving a project retires its local runtime environment, frees its key
 * for a new project, and the host closes live sessions from the revocation beat.
 * Real platform process, self-service host, TLS runtime, bare git, real IPC.
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

const KEY = 'm65-archive'
const CLOSE_TIMEOUT_MS = 15_000

let harness: ArchiveHarness

beforeAll(async () => {
  harness = await startArchiveHarness(ipcHandlers)
}, 120_000)

afterAll(async () => {
  await harness?.stop()
})

function environmentFor(projectId: string): { id: string } | undefined {
  return readEnvironmentStore(harness.registrationUserData).environments.find(
    (entry) => entry.cloudProject?.projectId === projectId
  )
}

describe('M65 项目归档闭环（真实平台 + 真实主机 + 真实 TLS Runtime）', () => {
  it('归档释放 key、删除侧车环境并让主机关闭 Live 会话', { timeout: 120_000 }, async () => {
    const created = await harness.createProject({
      name: 'Archive Demo',
      dir: KEY,
      key: KEY,
      repoUrl: harness.repoUrl,
      defaultBranch: 'main'
    })
    expect(created.ok, JSON.stringify(created)).toBe(true)
    if (!created.ok) {
      throw new Error(created.code)
    }
    const projectId = created.projectId
    const environmentId = created.environment.environmentId
    expect(environmentFor(projectId)?.id).toBe(environmentId)

    const opened = await harness.openWorkspace(projectId)
    expect(opened.ok, JSON.stringify(opened)).toBe(true)
    expect(harness.session.isProjectConnected(projectId)).toBe(true)

    // Why a second, independently owned socket: the handler closes its own
    // connection, so only this one proves the host acted on the revocation.
    const rawSession = await openPlatformSession(
      { url: harness.platformUrl, stop: async () => undefined },
      { projectKey: KEY, deviceName: 'm65-raw-live' }
    )
    const live = await connectCloudSession(
      harness.endpoint,
      harness.serverPublicKeyB64,
      rawSession,
      8000,
      { tlsRejectUnauthorized: false }
    )
    expect(live.status).toBe('authenticated')
    if (live.status !== 'authenticated') {
      throw new Error(`raw cloud session refused: ${live.close.code}`)
    }

    const startedAt = performance.now()
    const archived = await harness.archiveProject(projectId)
    expect(archived).toEqual({ ok: true, environmentId })
    expect(harness.session.isProjectConnected(projectId)).toBe(false)

    const closed = await Promise.race([
      live.close,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), CLOSE_TIMEOUT_MS))
    ])
    const closeElapsedMs = Math.round(performance.now() - startedAt)
    expect(closed, 'host did not close the revoked session').not.toBeNull()
    expect(closed?.code).toBe(4403)

    expect(environmentFor(projectId)).toBeUndefined()
    const listed = await harness.adminListProjects()
    expect(listed.find((project) => project.id === projectId)?.status).toBe('archived')
    const detail = await harness.adminGetProject(projectId)
    expect(detail.status).toBe(404)

    // The renderer's plan function must select the retired row by environment id.
    const row: Repo = {
      id: 'repo-m65-archive',
      path: join(harness.projectsRoot, KEY),
      displayName: KEY,
      badgeColor: '#888888',
      addedAt: 0,
      executionHostId: toRuntimeExecutionHostId(environmentId)
    }
    expect(cloudProjectReposOnHosts([row], [environmentId])).toEqual([row])

    const reborn = await harness.createProject({
      name: 'Archive Demo Reborn',
      dir: KEY,
      key: KEY,
      repoUrl: harness.repoUrl,
      defaultBranch: 'main'
    })
    const oldCheckoutSurvived = existsSync(row.path)

    harness.saveEvidence('m65-archive.json', {
      projectId,
      environmentId,
      archived,
      socketClose: { code: closed?.code, elapsedMs: closeElapsedMs },
      adminStatus: listed.find((project) => project.id === projectId)?.status,
      detailStatus: detail.status,
      sidecarEnvironmentRemoved: environmentFor(projectId) === undefined,
      oldCheckoutSurvived,
      reborn,
      timestamp: new Date().toISOString()
    })

    // Archive does not delete the host checkout; the new project reuses it.
    expect(oldCheckoutSurvived).toBe(true)
    expect(reborn.ok, JSON.stringify(reborn)).toBe(true)
    if (reborn.ok) {
      expect(reborn.projectId).not.toBe(projectId)
      expect(reborn.environment.projectRoot).toBe(row.path)
    }
  })
})
