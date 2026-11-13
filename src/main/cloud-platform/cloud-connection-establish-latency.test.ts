import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { REPO_ROOT } from './cloud-session-e2e-harness'
import { CloudConnectClient } from './cloud-connect-client'
import { ensureCloudWorkspace } from './cloud-workspace-ensure'
import { startRelayStack, stopRelayStack, type RelayStack } from './cloud-relay-stack-fixture'
import { assertLatencyBudget, latencyStats, type LatencyStats } from './cloud-latency-samples'

/**
 * M104 (requirements §5.1): connection establishment, from fetching the connect
 * credential to the workspace answering, is direct P95 ≤ 2s and relay P95 ≤ 3s.
 * Each sample is a brand-new client and socket so nothing is measured warm from
 * an earlier sample. A delayed hop proves the number follows the path.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm104-connection-latency')
const DIRECT_BUDGET_MS = 2_000
const RELAY_BUDGET_MS = 3_000
const SAMPLES = 20
const WARMUP = 2
const CONTROL_SAMPLES = 3
const INJECTED_DELAY_MS = 800

function saveEvidence(file: string, content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, file), JSON.stringify(content, null, 2))
}

/** One fresh client: login, then time credential → workspace answering. */
async function measureOnce(stack: RelayStack): Promise<number> {
  const client = new CloudConnectClient({
    apiUrl: stack.platform.url,
    tlsRejectUnauthorized: false
  })
  try {
    // Login is setup, not connection establishment: the budget starts at the
    // credential fetch for a user who is already signed in.
    await client.login('zhangsan', 'Passw0rd!')
    const started = performance.now()
    const ensured = await ensureCloudWorkspace(client, stack.projectId)
    if (!ensured.ok) {
      throw new Error(`workspace ensure failed: ${ensured.code} ${ensured.message ?? ''}`)
    }
    const status = await client.rpc('status.get')
    const elapsed = performance.now() - started
    if (!status.ok) {
      throw new Error(`status.get failed: ${JSON.stringify(status)}`)
    }
    return elapsed
  } finally {
    client.close()
  }
}

async function sample(stack: RelayStack, count: number): Promise<LatencyStats> {
  const values: number[] = []
  for (let index = 0; index < count; index += 1) {
    values.push(await measureOnce(stack))
  }
  return latencyStats(values)
}

function saveRun(
  route: 'direct' | 'relay',
  normal: LatencyStats,
  injected: LatencyStats,
  restored: LatencyStats,
  budgetMs: number
): void {
  saveEvidence(`connection-latency-${route}.json`, {
    route,
    budgetMs,
    samples: SAMPLES,
    normal,
    injected: { delayMs: INJECTED_DELAY_MS, ...injected },
    restored,
    platform: process.platform,
    node: process.version
  })
}

describe('连接建立延迟：直连（真实平台 + 真实 TLS Runtime + 真实 WSS）', () => {
  let stack: RelayStack

  beforeAll(async () => {
    stack = await startRelayStack({ name: 'm104-direct', directOnly: true })
  }, 180_000)

  afterAll(async () => {
    await stopRelayStack(stack)
  })

  it('M104-1 直连建立 P95 ≤ 2s；注入 800ms 延迟时同一断言转红', async () => {
    expect(stack.route).toBe('direct')
    await sample(stack, WARMUP)
    const normal = await sample(stack, SAMPLES)
    assertLatencyBudget('direct connection', normal, DIRECT_BUDGET_MS)

    stack.hop.setDelayMs(INJECTED_DELAY_MS)
    const injected = await sample(stack, CONTROL_SAMPLES)
    expect(() => assertLatencyBudget('direct connection', injected, DIRECT_BUDGET_MS)).toThrow(
      /over budget/
    )

    stack.hop.setDelayMs(0)
    const restored = await sample(stack, CONTROL_SAMPLES)
    assertLatencyBudget('direct connection', restored, DIRECT_BUDGET_MS)

    saveRun('direct', normal, injected, restored, DIRECT_BUDGET_MS)
    expect(injected.p95).toBeGreaterThanOrEqual(normal.p95 + INJECTED_DELAY_MS)
  }, 180_000)
})

describe('连接建立延迟：中继（真实中继进程 + 真实 TLS Runtime + 真实 WSS）', () => {
  let stack: RelayStack

  beforeAll(async () => {
    stack = await startRelayStack({ name: 'm104-relay' })
  }, 180_000)

  afterAll(async () => {
    await stopRelayStack(stack)
  })

  it('M104-2 中继建立 P95 ≤ 3s；注入 800ms 延迟时同一断言转红', async () => {
    expect(stack.route).toBe('relay')
    await sample(stack, WARMUP)
    const normal = await sample(stack, SAMPLES)
    assertLatencyBudget('relay connection', normal, RELAY_BUDGET_MS)

    stack.hop.setDelayMs(INJECTED_DELAY_MS)
    const injected = await sample(stack, CONTROL_SAMPLES)
    expect(() => assertLatencyBudget('relay connection', injected, RELAY_BUDGET_MS)).toThrow(
      /over budget/
    )

    stack.hop.setDelayMs(0)
    const restored = await sample(stack, CONTROL_SAMPLES)
    assertLatencyBudget('relay connection', restored, RELAY_BUDGET_MS)

    saveRun('relay', normal, injected, restored, RELAY_BUDGET_MS)
    expect(injected.p95).toBeGreaterThanOrEqual(normal.p95 + INJECTED_DELAY_MS)
  }, 180_000)
})
