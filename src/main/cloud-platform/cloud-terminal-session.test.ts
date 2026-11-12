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
 * T206 terminal pane, end to end: a real cloud ticket, a real TLS runtime, a real
 * worktree, and a **real shell in a real PTY** (node-pty). The client creates a
 * terminal through the cloud link, subscribes to its stream, types into it, and
 * reads the shell's own output back.
 *
 * The boundary half is the point: the same client is refused a terminal in the
 * shared checkout or in another team's, and refused a live handle that belongs to
 * a terminal outside its workspace.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm43-cloud-terminal')
const PROJECT_KEY = 'terminal-project'
const MARKER = 'ORCA_CLOUD_TERMINAL_OK'

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

/** Waits for a stream event matching `predicate`, with a hard timeout. */
function waitForEvent(
  events: unknown[],
  predicate: (event: unknown) => boolean,
  timeoutMs = 15_000
): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = (): void => {
      if (events.some(predicate)) {
        resolve()
        return
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`timed out waiting for a stream event; saw ${JSON.stringify(events)}`))
        return
      }
      setTimeout(tick, 50)
    }
    tick()
  })
}

const isDataContaining = (needle: string) => (event: unknown) =>
  readString(event, 'type') === 'data' && (readString(event, 'chunk') ?? '').includes(needle)

let platform: Platform
let admission: CloudRuntimeAdmission
let cloud: CloudRuntime
let projectRoot = ''
let otherRepoPath = ''
let projectId = ''
let desktop: CloudConnectClient
let workspacePath = ''

beforeAll(async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-cloud-terminal-')))
  projectRoot = join(base, 'payment-service')
  otherRepoPath = join(base, 'other-team')
  initRepo(projectRoot)
  initRepo(otherRepoPath)

  const dataDir = mkdtempSync(join(tmpdir(), 'orca-cloud-terminal-data-'))
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
  const service = new OrcaRuntimeService(store)
  installRealPtyController(service)

  platform = await startPlatform()
  const admin = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'terminal-admin' })
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
      ORCA_CLOUD_HOST_NAME: 'dev-terminal',
      ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1'
    },
    { userDataPath: mkdtempSync(join(tmpdir(), 'orca-cloud-terminal-host-')) }
  )
  if (!started) {
    throw new Error('cloud admission not enabled')
  }
  admission = started
  await admission.ready

  cloud = await startCloudRuntime({
    admission: admission.admission,
    connectionGate: admission.connectionGate,
    userDataPrefix: 'orca-cloud-terminal-',
    service,
    tls: makeSelfSignedTls('dev-terminal'),
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
  projectId = readString(await create.json(), 'id') ?? ''
  const grant = await fetch(`${platform.url}/v1/projects/${projectId}/grants`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      subjectType: 'group',
      subjectId: 'team-payment',
      permissions: ['open', 'terminal', 'file:read', 'file:write']
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
})

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
      terminals.set(id, {
        write: (data) => term.write(data),
        kill: () => term.kill()
      })
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

afterAll(async () => {
  desktop?.close()
  admission?.client?.stop()
  await cloud?.runtime.stop()
  await platform?.stop()
  await closeTestStores()
})

describe('云端终端（真实平台 + 真实 Runtime + 真实 PTY）', () => {
  it('M43-1 在工作区内创建终端、订阅流并读到 shell 真实输出', async () => {
    const created = await desktop.rpc('terminal.create', {
      worktree: `path:${workspacePath}`,
      title: 'cloud-pane'
    })
    expect(created.ok, JSON.stringify(created)).toBe(true)
    const terminal = created.ok ? readString(readField(created.result, 'terminal'), 'handle') : null
    if (terminal === null) {
      throw new Error(`no terminal handle in ${JSON.stringify(created)}`)
    }

    const events: unknown[] = []
    const subscription = desktop.subscribe('terminal.subscribe', { terminal }, (event) => {
      events.push(event)
    })
    if (subscription === null) {
      throw new Error('subscribe returned null')
    }
    // First frame is the host's scrollback snapshot, not the prompt.
    await waitForEvent(events, (event) => readString(event, 'type') === 'scrollback')

    const sent = await desktop.rpc('terminal.send', { terminal, text: `echo ${MARKER}\n` })
    expect(sent.ok, JSON.stringify(sent)).toBe(true)
    await waitForEvent(events, isDataContaining(MARKER))

    // The stream ends when the client asks the host to release the terminal.
    const unsubscribed = await desktop.rpc('terminal.unsubscribe', {
      subscriptionId: terminal,
      requestId: subscription.requestId
    })
    expect(unsubscribed.ok, JSON.stringify(unsubscribed)).toBe(true)
    const ended = await subscription.done
    expect(ended.ok, JSON.stringify(ended)).toBe(true)

    await desktop.rpc('terminal.close', { terminal })
    saveEvidence('m43-1-stream.json', {
      terminal,
      requestId: subscription.requestId,
      eventTypes: events.map((event) => readString(event, 'type')),
      sawMarker: events.some(isDataContaining(MARKER)),
      unsubscribed
    })
  }, 90000)

  it('M43-2 边界：共享检出区与他人仓库不能开终端，窗口级方法被拒', async () => {
    const shared = await desktop.rpc('terminal.create', { worktree: `path:${projectRoot}` })
    expect(shared.ok).toBe(false)
    if (!shared.ok) {
      expect(shared.code).toBe('forbidden')
      expect(shared.message).toContain('workspace root')
    }

    const other = await desktop.rpc('terminal.create', { worktree: `path:${otherRepoPath}` })
    expect(other.ok).toBe(false)
    if (!other.ok) {
      expect(other.code).toBe('forbidden')
    }

    const noWorktree = await desktop.rpc('terminal.create', {})
    expect(noWorktree.ok).toBe(false)

    // Host-wide listing and window control are not a cloud user's business.
    for (const method of ['terminal.list', 'terminal.closeAll', 'terminal.focus']) {
      const refused = await desktop.rpc(method, {})
      expect(refused.ok, method).toBe(false)
      if (!refused.ok) {
        expect(refused.code, method).toBe('forbidden')
      }
    }

    saveEvidence('m43-2-boundary.json', { shared, other, noWorktree })
  }, 60000)

  it('M43-3 名不存在的终端句柄被拒，不会落到 handler', async () => {
    const unknown = await desktop.rpc('terminal.send', {
      terminal: 'handle-that-never-existed',
      text: 'echo nope\n'
    })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) {
      expect(unknown.code).toBe('forbidden')
      expect(unknown.message).toContain('not available to the cloud session')
    }
    saveEvidence('m43-3-unknown-handle.json', { unknown })
  }, 40000)
})
