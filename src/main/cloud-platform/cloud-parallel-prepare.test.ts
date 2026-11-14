import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  startParallelPrepareHarness,
  type ParallelPrepareHarness
} from './cloud-parallel-prepare-fixture'

/**
 * M64: sign-in prepares every project's clone/ticket with bounded overlap, then
 * registers environments in project order. Real platform, host, TLS runtime, git.
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

const PREPARE_CONCURRENCY = 2

type PrepareSpan = { projectId: string; start: number; end: number }

/** End events first so intervals that only touch do not count as overlap. */
function maxConcurrent(spans: readonly PrepareSpan[]): number {
  const events = spans.flatMap((span) => [
    { at: span.start, delta: 1 },
    { at: span.end, delta: -1 }
  ])
  events.sort((a, b) => a.at - b.at || a.delta - b.delta)
  let active = 0
  let peak = 0
  for (const event of events) {
    active += event.delta
    peak = Math.max(peak, active)
  }
  return peak
}

function gitToplevel(path: string): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: path,
    encoding: 'utf8'
  }).trim()
}

let harness: ParallelPrepareHarness

beforeAll(async () => {
  harness = await startParallelPrepareHarness(ipcHandlers, PREPARE_CONCURRENCY)
}, 120_000)

afterAll(async () => {
  await harness?.stop()
})

describe('签到准备的网络/clone 阶段有界并行（真实平台 + 真实 TLS Runtime + 真实 git）', () => {
  it('M64-1 有界重叠、结果顺序稳定、坏项目失败隔离且真实 clone 成功', async () => {
    const sessionState = harness.session.getState()
    const projectOrder =
      sessionState.status === 'signed-in' ? sessionState.projects.map((entry) => entry.id) : []
    expect(projectOrder).toHaveLength(3)

    // U44: sign-in registration happens after the kick settles, so a provisioning
    // project is no longer reported as a failure.
    await harness.beatUntilSettled()

    const spans: PrepareSpan[] = []
    // Why delay: tiny local repos can finish in a few ms, which would hide real overlap.
    const realEnsure = harness.session.ensureProjectPrepared.bind(harness.session)
    vi.spyOn(harness.session, 'ensureProjectPrepared').mockImplementation(async (projectId) => {
      const start = performance.now()
      await new Promise((resolve) => setTimeout(resolve, 150))
      try {
        return await realEnsure(projectId)
      } finally {
        spans.push({ projectId, start, end: performance.now() })
      }
    })

    const registration = await harness.registerProjects()
    const successful = harness.projects.filter((project) => project.readme !== null)
    const broken = harness.projects.filter((project) => project.readme === null)
    expect(broken).toHaveLength(1)

    const baseStart = Math.min(...spans.map((span) => span.start))
    const peak = maxConcurrent(spans)
    const relativeSpans = spans.map((span) => ({
      projectId: span.projectId,
      startMs: Number((span.start - baseStart).toFixed(2)),
      endMs: Number((span.end - baseStart).toFixed(2))
    }))
    const successfulOrder = projectOrder.filter((projectId) =>
      successful.some((project) => project.projectId === projectId)
    )

    harness.saveEvidence('m64-parallel.json', {
      prepareConcurrency: PREPARE_CONCURRENCY,
      ensureProjectPreparedSpans: relativeSpans,
      maxConcurrentPrepareTasks: peak,
      overlapDetected: peak >= 2,
      projectOrder,
      successfulOrder,
      environmentOrder: registration.environments.map((entry) => entry.projectId),
      failures: registration.failures,
      timestamp: new Date().toISOString()
    })

    // Overlap proves the clone/ticket phase really ran in parallel.
    expect(peak).toBeGreaterThanOrEqual(2)
    expect(peak).toBeLessThanOrEqual(PREPARE_CONCURRENCY)
    expect(spans).toHaveLength(3)

    // Environments come out in `state.projects` order, minus the failed project.
    expect(registration.environments.map((entry) => entry.projectId)).toEqual(successfulOrder)

    // Failure stays isolated and keeps the retry contract; the failed project is
    // now rejected by the connect gate before any ticket exists (U20).
    expect(registration.failures).toHaveLength(1)
    expect(registration.failures[0]).toMatchObject({
      projectId: broken[0].projectId,
      projectKey: broken[0].key,
      projectName: broken[0].name,
      code: 'PROJECT_NOT_PREPARED'
    })
    expect(existsSync(broken[0].root)).toBe(false)

    for (const project of successful) {
      const environment = registration.environments.find(
        (entry) => entry.projectId === project.projectId
      )
      expect(environment?.projectRoot).toBe(project.root)
      expect(readFileSync(join(project.root, 'README.md'), 'utf8')).toBe(project.readme)
      expect(gitToplevel(project.root)).toBe(project.root)
    }
  }, 240_000)
})
