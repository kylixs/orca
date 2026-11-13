import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readField, readString } from '../../shared/json-fields'
import { REPO_ROOT } from './cloud-session-e2e-harness'
import {
  startAgentLaunchStack,
  type AgentLaunchStack
} from './cloud-agent-launch-execution-fixture'

/**
 * M72: a cloud denial keeps the wire code `forbidden` but now carries the
 * machine-readable reason the platform documents, over a real TLS runtime.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm72-denial-details')

function saveEvidence(file: string, content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, file), JSON.stringify(content, null, 2))
}

function denialOf(reply: unknown): unknown {
  return readField(reply, 'data')
}

let stack: AgentLaunchStack

beforeAll(async () => {
  stack = await startAgentLaunchStack()
}, 120_000)

afterAll(async () => {
  stack?.stopPtyController()
  stack?.desktop.close()
  stack?.admission.client?.stop()
  await stack?.cloud.runtime.stop()
  await stack?.platform.stop()
})

describe('云端拒绝携带机器可读原因（真实平台 + 真实 TLS Runtime）', () => {
  it('M72-1 越过工作区写入 → forbidden + PATH_OUTSIDE_ROOT', async () => {
    const reply = await stack.desktop.rpc('files.write', {
      worktree: `path:${stack.projectRoot}`,
      relativePath: 'escape.txt',
      content: 'x'
    })
    expect(reply.ok).toBe(false)
    if (!reply.ok) {
      expect(reply.code).toBe('forbidden')
      expect(denialOf(reply)).toMatchObject({ denial: 'PATH_OUTSIDE_ROOT' })
      expect(readString(denialOf(reply), 'reason')).not.toBeNull()
    }
    saveEvidence('m72-path-denial.json', { reply })
  }, 60_000)

  it('M72-2 主机级方法 → forbidden + METHOD_NOT_AVAILABLE', async () => {
    const reply = await stack.desktop.rpc('settings.update', { settings: {} })
    expect(reply.ok).toBe(false)
    if (!reply.ok) {
      expect(reply.code).toBe('forbidden')
      expect(denialOf(reply)).toMatchObject({ denial: 'METHOD_NOT_AVAILABLE' })
    }
    saveEvidence('m72-method-denial.json', { reply })
  }, 60_000)
})
