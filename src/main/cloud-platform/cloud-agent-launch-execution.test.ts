import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readField, readString } from '../../shared/json-fields'
import { closeTestStores } from '../persistence-test-harness'
import { REPO_ROOT, connectCloudSession, openPlatformSession } from './cloud-session-e2e-harness'
import {
  M67_FAKE_MARKER,
  M67_PROJECT_KEY,
  startAgentLaunchStack,
  type AgentLaunchStack
} from './cloud-agent-launch-execution-fixture'

/**
 * M67: a cloud desktop session must really execute `agent.launch`, not only pass the M44 path
 * boundary. The client advertises `agent.launch.v2` on its E2EE auth, the real runtime spawns a
 * real PTY running a fake `claude`, and a legacy handshake without the capability is still
 * refused.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm67-cloud-agent-launch')

function saveEvidence(file: string, content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, file), JSON.stringify(content, null, 2))
}

let stack: AgentLaunchStack
const openedTerminals: string[] = []

beforeAll(async () => {
  stack = await startAgentLaunchStack()
}, 180_000)

afterAll(async () => {
  for (const handle of openedTerminals) {
    await stack?.service.closeTerminal(handle).catch(() => {})
  }
  stack?.stopPtyController()
  stack?.desktop.close()
  stack?.admission.client?.stop()
  await stack?.cloud.runtime.stop()
  await stack?.platform.stop()
  await closeTestStores()
})

async function waitForMarker(
  handle: string,
  marker: string,
  timeoutMs = 15_000
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs
  let tail: string[] = []
  while (Date.now() < deadline) {
    tail = (await stack.service.readTerminal(handle)).tail
    if (tail.join('\n').includes(marker)) {
      return tail
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return tail
}

describe('M67 云端会话真实执行 agent.launch', () => {
  it('M67-1 本人 worktree 的 launch 返回真实 terminal handle 并跑起假 CLI', async () => {
    const reply = await stack.desktop.rpc(
      'agent.launch',
      {
        agent: 'claude',
        target: { kind: 'existing', worktree: `path:${stack.workspacePath}` }
      },
      30_000
    )
    expect(reply.ok, JSON.stringify(reply)).toBe(true)
    const result = readField(reply, 'result')
    const outcome = readField(result, 'outcome')
    expect(readString(outcome, 'kind')).toBe('terminal')
    const handle = readString(outcome, 'handle')
    expect(handle).toBeTruthy()
    openedTerminals.push(handle!)

    const tail = await waitForMarker(handle!, M67_FAKE_MARKER)
    expect(tail.join('\n'), tail.join('\n')).toContain(M67_FAKE_MARKER)
    // The PTY really ran in the caller's own checkout, not the shared project root.
    expect(tail.map((line) => line.trim())).toContain(realpathSync(stack.workspacePath))

    // The same handle is readable through the cloud session itself.
    const read = await stack.desktop.rpc('terminal.read', { terminal: handle })
    expect(read.ok, JSON.stringify(read)).toBe(true)
    expect(JSON.stringify(readField(read, 'result'))).toContain(M67_FAKE_MARKER)

    saveEvidence('m67-1-own-launch.json', {
      request: { agent: 'claude', worktree: 'path:<own checkout>' },
      reply,
      terminalHandle: handle,
      markerSeen: true,
      cwdSeen: realpathSync(stack.workspacePath)
    })
  }, 60_000)

  it('M67-2 共享检出与队友仓库仍被边界拒绝', async () => {
    const refusals: Record<string, unknown> = {}
    for (const [label, path] of [
      ['shared-checkout', stack.projectRoot],
      ['other-team-repo', stack.otherRepoPath]
    ] as const) {
      const reply = await stack.desktop.rpc('agent.launch', {
        agent: 'claude',
        target: { kind: 'existing', worktree: `path:${path}` }
      })
      expect(reply.ok, label).toBe(false)
      expect(readString(reply, 'code'), label).toBe('forbidden')
      expect(readString(reply, 'message'), label).toContain('workspace root')
      refusals[label] = reply
    }
    saveEvidence('m67-2-boundary.json', refusals)
  }, 60_000)

  it('M67-3 不带 clientCapabilities 的旧版握手仍得到 agent_launch_unsupported', async () => {
    const legacySession = await openPlatformSession(stack.platform, {
      projectKey: M67_PROJECT_KEY
    })
    const legacy = await connectCloudSession(
      stack.cloud.endpoint,
      stack.cloud.serverPublicKeyB64,
      legacySession,
      5000,
      { tlsRejectUnauthorized: false }
    )
    expect(legacy.status).toBe('authenticated')
    if (legacy.status !== 'authenticated') {
      return
    }
    const reply = await legacy.rpc('agent.launch', {
      agent: 'claude',
      target: { kind: 'existing', worktree: `path:${stack.workspacePath}` }
    })
    expect(reply.ok).toBe(false)
    if (!reply.ok) {
      expect(reply.message).toBe('agent_launch_unsupported')
    }
    saveEvidence('m67-3-legacy-handshake.json', { reply })
    legacy.ws.close()
  }, 60_000)
})
