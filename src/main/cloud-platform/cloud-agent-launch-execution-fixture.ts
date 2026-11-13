import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from 'vitest'
import { readString } from '../../shared/json-fields'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { Store } from '../persistence/loading-store/store'
import { createSqliteTestStore } from '../persistence-test-harness'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { ALL_RPC_METHODS } from '../runtime/rpc/methods'
import { MANAGED_WORKTREE_METHODS } from '../runtime/rpc/methods/worktree-create-managed'
import {
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

/** Bootstrap for the M67 launch test: real platform, TLS runtime, managed worktree, fake agent. */

export const M67_PROJECT_KEY = 'm67-launch'
export const M67_FAKE_MARKER = 'M67_FAKE_CLAUDE_STARTED'

export type AgentLaunchStack = {
  platform: Platform
  admission: CloudRuntimeAdmission
  cloud: CloudRuntime
  service: OrcaRuntimeService
  projectRoot: string
  otherRepoPath: string
  desktop: CloudConnectClient
  projectId: string
  workspacePath: string
  stopPtyController: () => void
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

/** A fake `claude`: announces itself and its cwd, then stays alive like a TUI would. */
function installFakeClaude(dir: string): string {
  const path = join(dir, 'claude')
  writeFileSync(path, `#!/bin/sh\necho '${M67_FAKE_MARKER}'\npwd\nexec sleep 600\n`)
  chmodSync(path, 0o755)
  return path
}

/** The provider half of the PTY contract: it, not the runtime, delivers `opts.command`. */
function installCommandExecutingPtyController(service: OrcaRuntimeService): () => void {
  const terminals = new Map<string, { write(data: string): void; kill(): void }>()
  let seq = 0
  service.setPtyController({
    spawn: async (opts) => {
      const nodePty = await import('node-pty')
      const id = `pty-m67-${++seq}`
      const env: Record<string, string> = {}
      for (const [key, value] of Object.entries({ ...process.env, ...opts.env })) {
        if (typeof value === 'string') {
          env[key] = value
        }
      }
      env.TERM = 'xterm-256color'
      // POSIX shell regardless of $SHELL: the launch command is POSIX-quoted either way.
      const term = nodePty.spawn('/bin/sh', ['-c', opts.command ?? 'exec /bin/sh'], {
        name: 'xterm-256color',
        cols: opts.cols,
        rows: opts.rows,
        cwd: opts.cwd ?? process.cwd(),
        env
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
  return () => {
    for (const terminal of terminals.values()) {
      terminal.kill()
    }
  }
}

export async function startAgentLaunchStack(): Promise<AgentLaunchStack> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-m67-launch-')))
  const projectRoot = join(base, 'payment-service')
  const otherRepoPath = join(base, 'other-team')
  initRepo(projectRoot)
  initRepo(otherRepoPath)
  const fakeClaude = installFakeClaude(mkdtempSync(join(tmpdir(), 'orca-m67-bin-')))

  const dataDir = mkdtempSync(join(tmpdir(), 'orca-m67-data-'))
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
  store.updateSettings({
    workspaceDir: join(base, 'host-workspaces'),
    // The launched agent is a fake CLI; no real Claude login or account is touched.
    agentCmdOverrides: { claude: fakeClaude }
  })
  store.flushOrThrow()
  const service = new OrcaRuntimeService(store)
  const stopPtyController = installCommandExecutingPtyController(service)

  const platform = await startPlatform()
  const admin = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'm67-admin' })
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
      ORCA_CLOUD_HOST_NAME: 'dev-m67',
      ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1'
    },
    { userDataPath: mkdtempSync(join(tmpdir(), 'orca-m67-host-')) }
  )
  if (!started) {
    throw new Error('cloud admission not enabled')
  }
  const admission = started
  await admission.ready

  const cloud = await startCloudRuntime({
    admission: admission.admission,
    connectionGate: admission.connectionGate,
    userDataPrefix: 'orca-m67-',
    service,
    tls: makeSelfSignedTls('dev-m67'),
    methods: [...ALL_RPC_METHODS, ...MANAGED_WORKTREE_METHODS]
  })
  admission.bindRuntime(cloud.runtime)
  await admission.client!.refresh()

  const create = await fetch(`${platform.url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      key: M67_PROJECT_KEY,
      name: M67_PROJECT_KEY,
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

  const desktop = new CloudConnectClient({ apiUrl: platform.url, tlsRejectUnauthorized: false })
  await desktop.login('zhangsan', 'Passw0rd!')
  const ensured = await ensureCloudWorkspace(desktop, projectId)
  if (!ensured.ok) {
    throw new Error(`workspace ensure failed: ${ensured.code} ${ensured.message ?? ''}`)
  }

  return {
    platform,
    admission,
    cloud,
    service,
    projectRoot,
    otherRepoPath,
    desktop,
    projectId,
    workspacePath: ensured.workspacePath,
    stopPtyController
  }
}
