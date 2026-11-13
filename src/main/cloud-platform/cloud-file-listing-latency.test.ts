import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { REPO_ROOT } from './cloud-session-e2e-harness'
import { startRelayStack, stopRelayStack, type RelayStack } from './cloud-relay-stack-fixture'

/**
 * M103 (requirements §5.1): reading a 1000-entry directory P95 ≤ 400ms. Run over
 * the relayed path with real TLS and E2EE, because that is the slowest line the
 * product ships. A delayed hop proves the number follows the path.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm103-file-listing-latency')
const BUDGET_MS = 400
const ENTRIES = 1000
const SAMPLES = 30
const WARMUP = 3
const CONTROL_SAMPLES = 10
const INJECTED_DELAY_MS = 450

type ListingStats = { samples: number; p50: number; p95: number; min: number; max: number }

function saveEvidence(file: string, content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, file), JSON.stringify(content, null, 2))
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function statsOf(values: number[]): ListingStats {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (percent: number): number => {
    const index = Math.min(sorted.length - 1, Math.ceil((percent / 100) * sorted.length) - 1)
    return round(sorted[Math.max(0, index)] ?? 0)
  }
  return {
    samples: sorted.length,
    p50: at(50),
    p95: at(95),
    min: round(sorted[0] ?? 0),
    max: round(sorted.at(-1) ?? 0)
  }
}

/** The acceptance check; the delayed run must make this throw. */
function assertListingBudget(stats: ListingStats, budget: number): void {
  if (stats.p95 > budget) {
    throw new Error(`file listing P95 ${stats.p95}ms over budget ${budget}ms`)
  }
}

/** 990 files across the extensions a checkout really has, plus 10 subdirectories. */
function fillListing(dir: string): void {
  mkdirSync(dir, { recursive: true })
  const extensions = ['ts', 'tsx', 'json', 'md', 'css', 'svg', 'yaml', 'sh']
  for (let index = 0; index < ENTRIES - 10; index += 1) {
    const ext = extensions[index % extensions.length] ?? 'txt'
    writeFileSync(join(dir, `file-${String(index).padStart(4, '0')}.${ext}`), 'x')
  }
  for (let index = 0; index < 10; index += 1) {
    mkdirSync(join(dir, `package-${index}`))
  }
}

let stack: RelayStack
let listedCount = 0

beforeAll(async () => {
  stack = await startRelayStack({ name: 'm103' })
  fillListing(join(stack.workspacePath, 'listing'))
}, 180_000)

afterAll(async () => {
  await stopRelayStack(stack)
})

describe('目录读取延迟（真实中继 + 真实 TLS + E2EE + 真实 Runtime）', () => {
  it('M103-1 1000 项目录读取 P95 ≤ 400ms；注入 450ms 延迟时同一断言转红', async () => {
    expect(stack.route).toBe('relay')
    const read = () =>
      stack.client.rpc('files.readDir', {
        worktree: `path:${stack.workspacePath}`,
        relativePath: 'listing'
      })

    const first = await read()
    expect(first.ok, JSON.stringify(first)).toBe(true)
    if (!first.ok) {
      return
    }
    const entries = first.result
    if (!Array.isArray(entries)) {
      throw new Error(`expected an entry array, got ${JSON.stringify(first.result)}`)
    }
    listedCount = entries.length
    // The measurement is meaningless unless the directory really holds 1000 entries.
    expect(listedCount).toBeGreaterThanOrEqual(ENTRIES)
    expect(entries).toContainEqual({ name: 'file-0000.ts', isDirectory: false, isSymlink: false })

    const timed = async (): Promise<number> => {
      const started = performance.now()
      const reply = await read()
      const elapsed = performance.now() - started
      expect(reply.ok, JSON.stringify(reply)).toBe(true)
      return elapsed
    }
    const runSamples = async (count: number): Promise<number[]> => {
      const values: number[] = []
      for (let index = 0; index < count; index += 1) {
        values.push(await timed())
      }
      return values
    }

    await runSamples(WARMUP)
    const normal = statsOf(await runSamples(SAMPLES))
    assertListingBudget(normal, BUDGET_MS)

    stack.hop.setDelayMs(INJECTED_DELAY_MS)
    const injected = statsOf(await runSamples(CONTROL_SAMPLES))
    expect(() => assertListingBudget(injected, BUDGET_MS)).toThrow(/over budget/)

    stack.hop.setDelayMs(0)
    const restored = statsOf(await runSamples(CONTROL_SAMPLES))
    assertListingBudget(restored, BUDGET_MS)

    saveEvidence('file-listing-latency.json', {
      route: stack.route,
      budgetMs: BUDGET_MS,
      entries: listedCount,
      samples: SAMPLES,
      normal,
      injected: { delayMs: INJECTED_DELAY_MS, ...injected },
      restored,
      platform: process.platform,
      node: process.version
    })

    expect(injected.p95).toBeGreaterThanOrEqual(normal.p95 + INJECTED_DELAY_MS / 2)
    expect(restored.p95).toBeLessThanOrEqual(BUDGET_MS)
  }, 180_000)
})
