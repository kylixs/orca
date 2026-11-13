import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readField, readString } from '../../shared/json-fields'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { Store } from '../persistence/loading-store/store'
import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { ALL_RPC_METHODS } from '../runtime/rpc/methods'
import { MANAGED_WORKTREE_METHODS } from '../runtime/rpc/methods/worktree-create-managed'
import {
  REPO_ROOT,
  makeSelfSignedTls,
  startCloudRuntime,
  startPlatform,
  type CloudRuntime,
  type Platform
} from './cloud-session-e2e-harness'
import {
  startCloudRuntimeAdmission,
  type CloudRuntimeAdmission
} from '../startup/cloud-runtime-admission'
import { CloudConnectClient } from './cloud-connect-client'
import { ensureCloudWorkspace } from './cloud-workspace-ensure'

/**
 * M44 agent boundary, end to end: a real cloud ticket, a real TLS runtime, a real
 * managed worktree, and real terminals in three different checkouts. The agent
 * methods carry no worktree selection of their own, so the boundary is the
 * worktree each named session runs in.
 *
 * The client is allowed an agent method whose session lives in its own workspace,
 * and refused the same call for a session in the shared checkout or another team's
 * repository — before the handler runs. Host-wide agent methods are refused whole.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm44-agent-boundary')
const PROJECT_KEY = 'agent-project'

function saveEvidence(file: string, content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, file), JSON.stringify(content, null, 2))
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function initRepo(path: string): void {
  mkdirSync(path, { recursive: true })
  git(path, 'init', '-q', '-b', 'main')
  git(path, 'config', 'user.email', 'e2e@example.com')
  git(path, 'config', 'user.name', 'e2e')
  writeFileSync(join(path, 'README.md'), 'hello\n')
  git(path, 'add', '.')
  git(path, 'commit', '-qm', 'init')
}

/** A real shell: node-pty spawns it, and its output feeds the runtime's own path. */
function installRealPtyController(service: OrcaRuntimeService): void {
  const terminals = new Map<string, { write(data: string): void; kill(): void }>()
  let seq = 0
  service.setPtyController({
    spawn: async (opts) => {
      const nodePty = await import('node-pty')
      const id = `pty-real-${++seq}`
      const term = nodePty.spawn(process.env.SHELL ?? '/bin/sh', [], {
        name: 'xterm-256color',
        cols: opts.cols,
        rows: opts.rows,
        cwd: opts.cwd ?? process.cwd(),
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: process.env.HOME ?? tmpdir(),
          TERM: 'xterm-256color',
          PS1: '$ '
        }
      })
      term.onData((data) => service.onPtyData(id, data, Date.now()))
      terminals.set(id, { write: (data) => term.write(data), kill: () => term.kill() })
      return { id, pid: term.pid }
    },
    write: (ptyId, data) => {
      terminals.get(ptyId)?.write(data)
      return true
    },
    kill: (ptyId) => {
      terminals.get(ptyId)?.kill()
      return true
    },
    getForegroundProcess: async () => null
  })
}

let platform: Platform
let admission: CloudRuntimeAdmission
let cloud: CloudRuntime
let service: OrcaRuntimeService
let projectRoot = ''
let otherRepoPath = ''
let desktop: CloudConnectClient
let workspacePath = ''
let ownSession = ''
let sharedSession = ''
let otherSession = ''

beforeAll(async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-cloud-agent-')))
  projectRoot = join(base, 'payment-service')
  otherRepoPath = join(base, 'other-team')
  initRepo(projectRoot)
  initRepo(otherRepoPath)

  const dataDir = mkdtempSync(join(tmpdir(), 'orca-cloud-agent-data-'))
  installFakeAppEnvironment({ getPath: () => dataDir })
  const store = createSqliteTestStore(Store, { dataFile: join(dataDir, 'orca-data.json') })
  store.addRepo({
    id: 'repo-project',
    path: projectRoot,
    displayName: 'payment-service',
    badgeColor: 'gray',
    addedAt: 1
  })
  store.addRepo({
    id: 'repo-other',
    path: otherRepoPath,
    displayName: 'other-team',
    badgeColor: 'gray',
    addedAt: 1
  })
  store.updateSettings({ workspaceDir: join(base, 'host-workspaces') })
  store.flushOrThrow()
  service = new OrcaRuntimeService(store)
  installRealPtyController(service)

  platform = await startPlatform()
  const admin = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'agent-admin' })
  })
  const adminToken = readString(await admin.json(), 'accessToken')
  if (adminToken === null) {
    throw new Error('admin login failed')
  }
  const tokenRes = await fetch(`${platform.url}/v1/hosts/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}` }
  })
  const hostToken = readString(await tokenRes.json(), 'token')
  if (hostToken === null) {
    throw new Error('host token missing')
  }

  const started = startCloudRuntimeAdmission(
    {
      ORCA_CLOUD_API_URL: platform.url,
      ORCA_CLOUD_HOST_TOKEN: hostToken,
      ORCA_CLOUD_HOST_NAME: 'dev-agent',
      ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1'
    },
    { userDataPath: mkdtempSync(join(tmpdir(), 'orca-cloud-agent-host-')) }
  )
  if (!started) {
    throw new Error('cloud admission not enabled')
  }
  admission = started
  await admission.ready

  cloud = await startCloudRuntime({
    admission: admission.admission,
    connectionGate: admission.connectionGate,
    userDataPrefix: 'orca-cloud-agent-',
    service,
    tls: makeSelfSignedTls('dev-agent'),
    methods: [...ALL_RPC_METHODS, ...MANAGED_WORKTREE_METHODS]
  })
  admission.bindRuntime(cloud.runtime)
  await admission.client!.refresh()

  const create = await fetch(`${platform.url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      key: PROJECT_KEY,
      name: PROJECT_KEY,
      hostId: admission.host()!.hostId,
      path: projectRoot
    })
  })
  expect(create.status, await create.clone().text()).toBe(201)
  const projectId = readString(await create.json(), 'id') ?? ''
  const grant = await fetch(`${platform.url}/v1/projects/${projectId}/grants`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      subjectType: 'group',
      subjectId: 'team-payment',
      permissions: ['open', 'terminal', 'agent', 'file:read', 'file:write']
    })
  })
  expect(grant.status).toBe(200)

  desktop = new CloudConnectClient({ apiUrl: platform.url, tlsRejectUnauthorized: false })
  await desktop.login('zhangsan', 'Passw0rd!')
  const ensured = await ensureCloudWorkspace(desktop, projectId)
  if (!ensured.ok) {
    throw new Error(`workspace ensure failed: ${ensured.code} ${ensured.message ?? ''}`)
  }
  workspacePath = ensured.workspacePath

  // Real PTYs in three checkouts; the guard never sees these creations.
  ownSession = (await service.createTerminal(`path:${workspacePath}`, { surfaceOwner: false }))
    .handle
  sharedSession = (await service.createTerminal(`path:${projectRoot}`, { surfaceOwner: false }))
    .handle
  otherSession = (await service.createTerminal(`path:${otherRepoPath}`, { surfaceOwner: false }))
    .handle
}, 180_000)

afterAll(async () => {
  desktop?.close()
  admission?.client?.stop()
  await cloud?.runtime.stop()
  await platform?.stop()
  await closeTestStores()
})

/** The boundary's refusal, as opposed to any handler error. */
function expectForbidden(reply: unknown, method: string): string {
  expect(readField(reply, 'ok'), method).toBe(false)
  expect(readString(reply, 'code'), method).toBe('forbidden')
  return readString(reply, 'message') ?? ''
}

describe('云端 agent 边界（真实平台 + 真实 Runtime）', () => {
  it('M44-1 本人工作区内的 agent 会话调用到达 handler', async () => {
    const reply = await desktop.rpc('agentSession.history', {
      sessionId: ownSession,
      direction: 'tail'
    })
    // The guard only refuses; whether the handler can answer is not the boundary's business.
    if (!reply.ok) {
      expect(reply.code).not.toBe('forbidden')
      expect(reply.message).not.toContain('workspace root')
      expect(reply.message).not.toContain('not available to the cloud session')
    }
    saveEvidence('m44-1-own-session.json', { ownSession, reply })
  }, 60_000)

  it('M44-2 共享检出区与队友仓库的 agent 会话调用被拒', async () => {
    const shared = await desktop.rpc('agentSession.history', {
      sessionId: sharedSession,
      direction: 'tail'
    })
    expect(expectForbidden(shared, 'shared history')).toContain('workspace root')

    const other = await desktop.rpc('agentSession.history', {
      sessionId: otherSession,
      direction: 'tail'
    })
    expect(expectForbidden(other, 'other history')).toContain('workspace root')

    // The envelope form carries the session id one level down.
    const sent = await desktop.rpc('agentSession.send', {
      envelope: { sessionId: otherSession },
      body: { text: 'hello' }
    })
    expect(expectForbidden(sent, 'other send')).toContain('workspace root')

    saveEvidence('m44-2-foreign-sessions.json', { shared, other, sent })
  }, 60_000)

  it('M44-3 共享检出区与队友仓库不能启动 agent', async () => {
    const launches: Record<string, unknown> = {}
    for (const [label, worktree] of [
      ['shared', projectRoot],
      ['other', otherRepoPath]
    ] as const) {
      const reply = await desktop.rpc('agent.launch', {
        agent: 'claude',
        target: { kind: 'existing', worktree: `path:${worktree}` }
      })
      expect(expectForbidden(reply, label)).toContain('workspace root')
      launches[label] = reply
    }
    const unnamed = await desktop.rpc('agent.launch', { agent: 'claude' })
    expect(expectForbidden(unnamed, 'unnamed')).toContain('must name the workspace')
    saveEvidence('m44-3-launch-targets.json', { launches, unnamed })
  }, 60_000)

  it('M44-4 全车级与主机侧 agent 方法被拒', async () => {
    const refused: Record<string, unknown> = {}
    for (const method of [
      'agentSession.subscribeStatus',
      'agentSession.restartResumable',
      'agentSession.agents',
      'agentSession.modelCatalog'
    ]) {
      const reply = await desktop.rpc(method, {})
      expectForbidden(reply, method)
      refused[method] = reply
    }
    // Not granted by any prefix either; the permission layer answers, still forbidden.
    const attachment = await desktop.rpc('agentSessionAttachment.read', { path: '/etc/passwd' })
    expect(attachment.ok).toBe(false)
    if (!attachment.ok) {
      expect(attachment.code).toBe('forbidden')
    }
    refused['agentSessionAttachment.read'] = attachment
    saveEvidence('m44-4-host-wide.json', refused)
  }, 60_000)
})
