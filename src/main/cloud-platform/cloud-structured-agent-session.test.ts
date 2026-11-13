import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readArray, readField, readString } from '../../shared/json-fields'
import { closeTestStores } from '../persistence-test-harness'
import { stopStructuredAgentSessionRuntime } from '../runtime/structured-agent-session-runtime'
import {
  realClaudeAuthenticated,
  realClaudeCliGate
} from '../claude/claude-real-cli-availability-test-support'
import { REPO_ROOT } from './cloud-session-e2e-harness'
import {
  startAgentLaunchStack,
  type AgentLaunchStack
} from './cloud-agent-launch-execution-fixture'

/**
 * M69: the structured outcome of `agent.launch` must be usable from a cloud session.
 *
 * M67 proved a cloud session really executes a terminal launch. This proves the other outcome
 * `agent.launch.v2` promises: a real Claude chat is created in the caller's own checkout, its
 * journal is readable through the cloud transport, and a turn reaches an assistant answer.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm69-cloud-structured-agent')

const gateSkipReason =
  realClaudeCliGate.skipReason ??
  (realClaudeAuthenticated ? null : 'the real claude CLI is not signed in')
const suiteTitle = `M69 云端会话的结构化 agent 路径${
  gateSkipReason === null ? '' : ` (skipped: ${gateSkipReason})`
}`

function saveEvidence(file: string, content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, file), JSON.stringify(content, null, 2))
}

let stack: AgentLaunchStack
let openSessionId: string | null = null

beforeAll(async () => {
  stack = await startAgentLaunchStack()
  // The M67 fixture pins a fake CLI for the terminal path; a structured chat spawns the real one.
  stack.store.updateSettings({
    experimentalNativeChat: true,
    agentCmdOverrides: {}
  })
}, 180_000)

afterAll(async () => {
  if (openSessionId !== null) {
    await stack?.desktop.rpc('agentSession.close', { sessionId: openSessionId }).catch(() => {})
  }
  await stopStructuredAgentSessionRuntime().catch(() => {})
  stack?.stopPtyController()
  stack?.desktop.close()
  stack?.admission.client?.stop()
  await stack?.cloud.runtime.stop()
  await stack?.platform.stop()
  await closeTestStores()
})

async function readHistory(sessionId: string): Promise<unknown> {
  const reply = await stack.desktop.rpc('agentSession.history', {
    sessionId,
    direction: 'tail',
    limit: 50
  })
  expect(reply.ok, JSON.stringify(reply)).toBe(true)
  return readField(reply, 'result')
}

/** Assistant text only: the assertion is "the model answered", never what it said. */
function assistantTexts(history: unknown): string[] {
  const items = readArray(readField(history, 'page'), 'items') ?? []
  return items.flatMap((item) => {
    const body = readField(item, 'body')
    if (readString(body, 'kind') !== 'message' || readString(body, 'role') !== 'assistant') {
      return []
    }
    return (readArray(body, 'blocks') ?? []).flatMap((block) =>
      readString(block, 'type') === 'text' ? [readString(block, 'text') ?? ''] : []
    )
  })
}

function itemCounts(history: unknown): { total: number; user: number; assistant: number } {
  const items = readArray(readField(history, 'page'), 'items') ?? []
  let user = 0
  let assistant = 0
  for (const item of items) {
    const body = readField(item, 'body')
    if (readString(body, 'kind') !== 'message') {
      continue
    }
    if (readString(body, 'role') === 'user') {
      user += 1
    } else if (readString(body, 'role') === 'assistant') {
      assistant += 1
    }
  }
  return { total: items.length, user, assistant }
}

describe.skipIf(gateSkipReason !== null)(suiteTitle, () => {
  it('本人 worktree 得到可用 structured 会话并跑出一个真实 turn', async () => {
    const startedAt = Date.now()
    const launch = await stack.desktop.rpc(
      'agent.launch',
      {
        agent: 'claude',
        target: { kind: 'existing', worktree: `path:${stack.workspacePath}` },
        prompt: { text: 'reply with the single word: pong', delivery: 'submit' }
      },
      120_000
    )
    expect(launch.ok, JSON.stringify(launch)).toBe(true)
    const result = readField(launch, 'result')
    const outcome = readField(result, 'outcome')
    expect(readString(outcome, 'kind')).toBe('structured')
    const sessionId = readString(outcome, 'sessionId')
    if (sessionId === null) {
      throw new Error('structured launch returned no session id')
    }
    openSessionId = sessionId

    // The host resolved the caller's own checkout, not the shared project root.
    const ownWorkspace = await stack.service.showTerminalWorkspaceLaunchScope(
      `path:${stack.workspacePath}`
    )
    expect(readString(result, 'worktreeId')).toBe(ownWorkspace.id)
    expect(readString(readField(result, 'prompt'), 'outcome')).toBe('journaled')

    // The journal exists at rest and is the session the launch named.
    let history = await readHistory(sessionId)
    expect(readString(readField(history, 'page'), 'sessionId')).toBe(sessionId)

    const deadline = Date.now() + 120_000
    let texts = assistantTexts(history)
    while (texts.join('').trim().length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      history = await readHistory(sessionId)
      texts = assistantTexts(history)
    }
    const turnMs = Date.now() - startedAt
    expect(texts.join('').trim().length, 'no assistant text within 120s').toBeGreaterThan(0)

    const close = await stack.desktop.rpc('agentSession.close', { sessionId: sessionId })
    expect(close.ok, JSON.stringify(close)).toBe(true)
    openSessionId = null

    saveEvidence('m69-structured.json', {
      outcome: {
        kind: readString(outcome, 'kind'),
        sessionId,
        worktreeId: readString(result, 'worktreeId'),
        promptOutcome: readString(readField(result, 'prompt'), 'outcome')
      },
      history: {
        sessionIdMatches: true,
        items: itemCounts(history),
        assistantTextLength: texts.join('').trim().length
      },
      turn: { assistantTextSeen: true, durationMs: turnMs },
      cleanup: { sessionClosed: true }
    })
  }, 180_000)

  it('共享检出仍被边界拒绝（结构化模式不放松 scope）', async () => {
    const reply = await stack.desktop.rpc('agent.launch', {
      agent: 'claude',
      target: { kind: 'existing', worktree: `path:${stack.projectRoot}` }
    })
    expect(reply.ok, JSON.stringify(reply)).toBe(false)
    if (!reply.ok) {
      expect(reply.code).toBe('forbidden')
      expect(reply.message).toContain('workspace root')
      saveEvidence('m69-boundary.json', {
        sharedCheckout: { ok: false, code: reply.code, message: reply.message }
      })
    }
  }, 60_000)
})
