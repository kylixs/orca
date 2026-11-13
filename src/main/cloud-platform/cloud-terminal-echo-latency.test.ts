import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readField, readString } from '../../shared/json-fields'
import { REPO_ROOT } from './cloud-session-e2e-harness'
import { startRelayStack, stopRelayStack, type RelayStack } from './cloud-relay-stack-fixture'

/**
 * M102 (requirements §5.1): terminal input echo P95 ≤ 120ms. Measured on the
 * worst line the product offers — relayed TCP, real TLS, E2EE, real runtime and
 * a real PTY with a real shell — from the byte leaving the client to the echoed
 * byte arriving back. A delayed hop proves the number measures the path.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm102-terminal-echo-latency')
const BUDGET_MS = 120
const SAMPLES = 50
const WARMUP = 5
const CONTROL_SAMPLES = 20
const INJECTED_DELAY_MS = 150
const KEYS = 'qjkvxzwypbfghmnrstuioledca'
const QUIET_MS = 80

function saveEvidence(file: string, content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, file), JSON.stringify(content, null, 2))
}

type EchoStats = { samples: number; p50: number; p95: number; min: number; max: number }

function statsOf(values: number[]): EchoStats {
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

function round(value: number): number {
  return Math.round(value * 100) / 100
}

/** The product's own acceptance check; the delayed run must make this throw. */
function assertEchoBudget(stats: EchoStats, budget: number): void {
  if (stats.p95 > budget) {
    throw new Error(`terminal echo P95 ${stats.p95}ms over budget ${budget}ms`)
  }
}

let stack: RelayStack

beforeAll(async () => {
  stack = await startRelayStack({ name: 'm102', realPty: true })
  expect(stack.route).toBe('relay')
}, 180_000)

afterAll(async () => {
  await stopRelayStack(stack)
})

describe('终端输入回显延迟（真实中继 + 真实 TLS + E2EE + 真实 PTY）', () => {
  it('M102-1 中继线路上的输入回显 P95 ≤ 120ms；注入 150ms 延迟时同一断言转红', async () => {
    expect(stack.route).toBe('relay')
    const created = await stack.client.rpc('terminal.create', {
      worktree: `path:${stack.workspacePath}`,
      title: 'm102-echo-pane'
    })
    expect(created.ok, JSON.stringify(created)).toBe(true)
    if (!created.ok) {
      return
    }
    const terminal = readString(readField(created.result, 'terminal'), 'handle')
    if (terminal === null) {
      throw new Error(`no terminal handle in ${JSON.stringify(created)}`)
    }

    let lastDataAt = 0
    let expected: string | null = null
    let resolveEcho: ((at: number) => void) | null = null
    const subscription = stack.client.subscribe('terminal.subscribe', { terminal }, (event) => {
      if (readString(event, 'type') !== 'data') {
        return
      }
      const chunk = readString(event, 'chunk') ?? ''
      const at = performance.now()
      lastDataAt = at
      if (expected !== null && chunk.includes(expected) && resolveEcho !== null) {
        const done = resolveEcho
        expected = null
        resolveEcho = null
        done(at)
      }
    })
    if (subscription === null) {
      throw new Error('subscribe returned null')
    }

    const waitQuiet = async (): Promise<void> => {
      const started = Date.now()
      while (Date.now() - started < 5_000) {
        if (lastDataAt !== 0 && performance.now() - lastDataAt > QUIET_MS) {
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error('terminal never went quiet')
    }

    // Why `cat`: the line discipline echoes each byte with no prompt redraw, so a
    // keystroke maps to exactly one echo — the product's input-echo path, uncluttered.
    const started = await stack.client.rpc('terminal.send', { terminal, text: 'cat\r' })
    expect(started.ok, JSON.stringify(started)).toBe(true)
    await waitQuiet()

    const measure = async (key: string): Promise<number> => {
      const echo = new Promise<number>((resolve, reject) => {
        expected = key
        resolveEcho = resolve
        setTimeout(() => {
          if (resolveEcho === resolve) {
            expected = null
            resolveEcho = null
            reject(new Error(`no echo for ${JSON.stringify(key)}`))
          }
        }, 5_000)
      })
      const t0 = performance.now()
      const sent = await stack.client.rpc('terminal.send', { terminal, text: key })
      expect(sent.ok, JSON.stringify(sent)).toBe(true)
      return (await echo) - t0
    }

    const runSamples = async (count: number): Promise<number[]> => {
      const values: number[] = []
      for (let index = 0; index < count; index += 1) {
        const key = KEYS[index % KEYS.length] ?? 'q'
        values.push(await measure(key))
      }
      return values
    }

    await runSamples(WARMUP)
    const normal = statsOf(await runSamples(SAMPLES))
    assertEchoBudget(normal, BUDGET_MS)

    stack.hop.setDelayMs(INJECTED_DELAY_MS)
    await waitQuiet()
    await runSamples(3)
    const injected = statsOf(await runSamples(CONTROL_SAMPLES))
    expect(() => assertEchoBudget(injected, BUDGET_MS)).toThrow(/over budget/)

    stack.hop.setDelayMs(0)
    await waitQuiet()
    await runSamples(3)
    const restored = statsOf(await runSamples(CONTROL_SAMPLES))
    assertEchoBudget(restored, BUDGET_MS)

    await stack.client.rpc('terminal.send', { terminal, text: '\u0003' })
    await stack.client.rpc('terminal.unsubscribe', {
      subscriptionId: terminal,
      requestId: subscription.requestId
    })
    await subscription.done
    await stack.client.rpc('terminal.close', { terminal })

    saveEvidence('terminal-echo-latency.json', {
      route: stack.route,
      budgetMs: BUDGET_MS,
      samples: SAMPLES,
      normal,
      injected: { delayMs: INJECTED_DELAY_MS, ...injected },
      restored,
      shell: process.env.SHELL ?? '/bin/sh',
      platform: process.platform,
      node: process.version
    })

    expect(injected.p95).toBeGreaterThanOrEqual(normal.p95 + INJECTED_DELAY_MS / 2)
    expect(restored.p95).toBeLessThanOrEqual(BUDGET_MS)
  }, 180_000)
})
