import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readString } from '../../shared/json-fields'
import {
  DEFAULT_INTERNAL_TOKEN,
  REPO_ROOT,
  connectCloudSession,
  openPlatformSession,
  startCloudRuntime,
  startPlatform,
  type CloudConnection,
  type CloudRuntime,
  type Platform
} from './cloud-session-e2e-harness'
import { createCloudAgentClient } from './cloud-agent-client'
import type { DeviceRegistry } from '../runtime/device-registry'

/**
 * Design §7.3: the platform signs the caller's project permissions into the
 * ticket, and the host enforces that set per RPC. Until this module the host
 * treated every paired device — cloud sessions included — as the full remote UI,
 * so a cloud user granted only "open" could read host settings and accounts.
 *
 * These drive real tickets from the real platform through real E2EE RPCs.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm34-cloud-rpc-scope')

function saveEvidence(file: string, content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, file), JSON.stringify(content, null, 2))
}

async function loginAdmin(platform: Platform): Promise<string> {
  const res = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'scope-admin' })
  })
  const token = readString(await res.json(), 'accessToken')
  if (token === null) {
    throw new Error('admin login failed')
  }
  return token
}

async function createProject(
  platform: Platform,
  token: string,
  key: string,
  permissions: string[]
): Promise<string> {
  const res = await fetch(`${platform.url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ key, name: key, hostId: 'host_dev001', path: `/srv/work/${key}` })
  })
  expect(res.status, await res.clone().text()).toBe(201)
  const id = readString(await res.json(), 'id')
  if (id === null) {
    throw new Error('project id missing')
  }
  const grant = await fetch(`${platform.url}/v1/projects/${id}/grants`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ subjectType: 'group', subjectId: 'team-payment', permissions })
  })
  expect(grant.status).toBe(200)
  return id
}

let platform: Platform
let cloud: CloudRuntime
let client: ReturnType<typeof createCloudAgentClient>
let registry: DeviceRegistry | null = null

beforeAll(async () => {
  platform = await startPlatform()
  const adminToken = await loginAdmin(platform)
  // Two projects whose grants differ in exactly the file permissions under test.
  await createProject(platform, adminToken, 'scope-readonly', ['open', 'file:read'])
  await createProject(platform, adminToken, 'scope-terminal', ['open', 'terminal'])

  client = createCloudAgentClient({
    apiUrl: platform.url,
    internalToken: DEFAULT_INTERNAL_TOKEN,
    hostId: 'host_dev001',
    hostName: 'dev-001'
  })
  await client.refresh()
  cloud = await startCloudRuntime({
    admission: (headers) => {
      const decision = client.admit(headers)
      if (decision.ok) {
        registry?.adoptCloudDevice({
          deviceId: decision.payload.deviceId,
          token: decision.payload.deviceToken,
          name: decision.payload.sub,
          publicKeyB64: decision.payload.devicePubKey,
          project: decision.payload.project,
          permissions: decision.payload.perms,
          projectRoot: decision.payload.projectRoot,
          workspaceRoot: decision.payload.workspaceRoot
        })
      }
      return decision
    },
    connectionGate: client.connectionGate,
    userDataPrefix: 'orca-cloud-scope-'
  })
  registry = cloud.runtime.getDeviceRegistry()
})

afterAll(async () => {
  client?.stop()
  await cloud?.runtime.stop()
  await platform?.stop()
})

async function connect(projectKey: string, deviceName: string): Promise<CloudConnection> {
  const session = await openPlatformSession(platform, { projectKey, deviceName })
  return await connectCloudSession(cloud.endpoint, cloud.serverPublicKeyB64, session)
}

function authenticated(
  connection: CloudConnection
): Extract<CloudConnection, { status: 'authenticated' }> {
  if (connection.status !== 'authenticated') {
    throw new Error(`expected an authenticated session, got close ${connection.close.code}`)
  }
  return connection
}

describe('云端会话的 RPC 权限（真实平台票据 + 真实 Runtime）', () => {
  it('M34-1 只授予 file:read 的项目：读方法放行，写方法被拒并指明缺少 file:write', async () => {
    const session = authenticated(await connect('scope-readonly', 'scope-readonly-1'))
    try {
      // Gate-open proof: file:read is granted, so the refusal is not an ACL one
      // (an unresolvable worktree is refused by the path boundary instead).
      const read = await session.rpc('files.read', {
        worktree: 'scope-readonly',
        relativePath: 'x'
      })
      expect(read.ok).toBe(false)
      if (!read.ok) {
        expect(read.message).not.toContain("'file:read'")
      }

      const write = await session.rpc('files.write', {
        worktree: 'scope-readonly',
        relativePath: 'x',
        content: 'x'
      })
      expect(write.ok).toBe(false)
      if (!write.ok) {
        expect(write.code).toBe('forbidden')
        expect(write.message).toContain("'file:write'")
      }

      // The read permission does not leak into terminal or agent families.
      const terminal = await session.rpc('terminal.create', { worktree: 'scope-readonly' })
      expect(terminal.ok).toBe(false)
      if (!terminal.ok) {
        expect(terminal.code).toBe('forbidden')
        expect(terminal.message).toContain("'terminal'")
      }

      saveEvidence('m34-1-readonly.json', { read, write, terminal })
    } finally {
      session.ws.close()
    }
  }, 30000)

  it('M34-2 只授予 terminal 的项目：终端方法放行，文件方法被拒', async () => {
    const session = authenticated(await connect('scope-terminal', 'scope-terminal-1'))
    try {
      // terminal permission admits the family; the host-wide listing itself is
      // refused by the M43 boundary, and the message says so rather than naming a
      // missing permission.
      const list = await session.rpc('terminal.list', {})
      expect(list.ok).toBe(false)
      if (!list.ok) {
        expect(list.code).toBe('forbidden')
        expect(list.message).toContain('not available to cloud sessions')
      }

      const read = await session.rpc('files.read', {
        worktree: 'scope-terminal',
        relativePath: 'x'
      })
      expect(read.ok).toBe(false)
      if (!read.ok) {
        expect(read.code).toBe('forbidden')
        expect(read.message).toContain("'file:read'")
      }

      saveEvidence('m34-2-terminal.json', { list, read })
    } finally {
      session.ws.close()
    }
  }, 30000)

  it('M34-3 云会话拿不到主机管理面：settings / accounts / 配对接口一律拒绝', async () => {
    const session = authenticated(await connect('scope-readonly', 'scope-escalation-1'))
    try {
      const results: Record<string, unknown> = {}
      for (const method of [
        'settings.get',
        'accounts.list',
        'pairing.getEndpoints',
        'host.platform'
      ]) {
        const reply = await session.rpc(method, {})
        results[method] = reply
        expect(reply.ok, `${method} must not be reachable from a cloud session`).toBe(false)
        if (!reply.ok) {
          expect(reply.code).toBe('forbidden')
        }
      }

      // Self-introspection stays available: the workspace view depends on it.
      const status = await session.rpc('status.get')
      expect(status.ok).toBe(true)

      saveEvidence('m34-3-no-host-admin.json', results)
    } finally {
      session.ws.close()
    }
  }, 30000)

  it('M34-4 每张票据按自己的权限集生效：同一用户、同一主机，两个项目互不影响', async () => {
    const readonly = authenticated(await connect('scope-readonly', 'scope-parallel-read'))
    const terminal = authenticated(await connect('scope-terminal', 'scope-parallel-terminal'))
    try {
      const write = await readonly.rpc('files.write', {
        worktree: 'x',
        relativePath: 'y',
        content: ''
      })
      expect(write.ok).toBe(false)
      // 'forbidden' and not a handler error: the ticket's own set refused it.
      if (!write.ok) {
        expect(write.code).toBe('forbidden')
      }
      // Reaches the family (no permission refusal), and is then refused by the
      // host-window rule — the two tickets still answer differently than a
      // permission-less one would.
      const terminalReply = await terminal.rpc('terminal.list', {})
      expect(terminalReply.ok).toBe(false)
      if (!terminalReply.ok) {
        expect(terminalReply.message).not.toContain("'terminal'")
      }
      // The cloud cap counts both, and each keeps its own grant.
      const concurrent = client.activeSessionCount()
      expect(concurrent).toBeGreaterThanOrEqual(2)
      saveEvidence('m34-4-per-ticket.json', { write, concurrent })
    } finally {
      readonly.ws.close()
      terminal.ws.close()
    }
  }, 30000)
})
