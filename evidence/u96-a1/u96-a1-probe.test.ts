import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, it } from 'vitest'
import { readField, readString } from '../../shared/json-fields'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { Store } from '../persistence/loading-store/store'
import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { ALL_RPC_METHODS } from '../runtime/rpc/methods'
import { WORKSPACE_INFO_METHODS } from '../runtime/rpc/methods/workspace-info'
import { MANAGED_WORKTREE_METHODS } from '../runtime/rpc/methods/worktree-create-managed'
import { makeSelfSignedTls, startCloudRuntime, startPlatform } from './cloud-session-e2e-harness'
import { startCloudRuntimeAdmission } from '../startup/cloud-runtime-admission'
import { CloudConnectClient } from './cloud-connect-client'
import { ensureCloudWorkspace } from './cloud-workspace-ensure'

const OUT = join(process.cwd(), 'evidence', 'u96-a1')
const PROJECT_KEY = 'u96-a1-probe'

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

let platform: Awaited<ReturnType<typeof startPlatform>>
let admission: ReturnType<typeof startCloudRuntimeAdmission>
let cloud: Awaited<ReturnType<typeof startCloudRuntime>>
let service: OrcaRuntimeService
let desktop: CloudConnectClient
let workspacePath = ''

beforeAll(async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-u96-a1-')))
  const projectRoot = join(base, 'probe-project')
  initRepo(projectRoot)
  const dataDir = mkdtempSync(join(tmpdir(), 'orca-u96-a1-data-'))
  installFakeAppEnvironment({ getPath: () => dataDir })
  const store = createSqliteTestStore(Store, { dataFile: join(dataDir, 'orca-data.json') })
  store.addRepo({
    id: 'repo-probe',
    path: projectRoot,
    displayName: 'probe-project',
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
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'u96-admin' })
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
      ORCA_CLOUD_HOST_NAME: 'dev-u96-a1',
      ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1'
    },
    { userDataPath: mkdtempSync(join(tmpdir(), 'orca-u96-a1-host-')) }
  )
  if (!started) {
    throw new Error('cloud admission not enabled')
  }
  admission = started
  await admission.ready
  cloud = await startCloudRuntime({
    admission: admission.admission,
    connectionGate: admission.connectionGate,
    userDataPrefix: 'orca-u96-a1-',
    service,
    tls: makeSelfSignedTls('dev-u96-a1'),
    methods: [...ALL_RPC_METHODS, ...WORKSPACE_INFO_METHODS, ...MANAGED_WORKTREE_METHODS]
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
  const projectId = readString(await create.json(), 'id') ?? ''
  if (create.status !== 201) {
    throw new Error(`project create failed: ${create.status}`)
  }
  await fetch(`${platform.url}/v1/projects/${projectId}/grants`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      subjectType: 'group',
      subjectId: 'team-payment',
      permissions: ['open', 'terminal', 'file:read', 'file:write']
    })
  })
  desktop = new CloudConnectClient({ apiUrl: platform.url, tlsRejectUnauthorized: false })
  await desktop.login('zhangsan', 'Passw0rd!')
  const ensured = await ensureCloudWorkspace(desktop, projectId)
  if (!ensured.ok) {
    throw new Error(`workspace ensure failed: ${ensured.code} ${ensured.message ?? ''}`)
  }
  workspacePath = ensured.workspacePath
})

function installRealPtyController(service: OrcaRuntimeService): void {
  const terminals = new Map<string, { write(data: string): void; kill(): void }>()
  let seq = 0
  service.setPtyController({
    spawn: async (opts) => {
      const nodePty = await import('node-pty')
      const id = `pty-probe-${++seq}`
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

it('U96 A-1 probe: cloud inventory, client tab membership, PTY disconnect', async () => {
  const out: Record<string, unknown> = {}
  const call = async (method: string, params?: unknown, timeoutMs = 5000): Promise<unknown> => {
    const reply = await desktop.rpc(method, params, timeoutMs)
    return reply.ok
      ? { ok: true, result: reply.result }
      : { ok: false, code: reply.code, message: reply.message }
  }
  const listAll = () => call('session.tabs.listAll', undefined, 20_000)
  out['workspace.info'] = await call('workspace.info')
  out['session.tabs.listAll.beforeCreate'] = await listAll()
  out['terminal.list.beforeCreate'] = await call('terminal.list', {
    worktree: `path:${workspacePath}`
  })

  const created = await call('terminal.create', {
    worktree: `path:${workspacePath}`,
    title: 'u96-probe',
    tabId: 'u96-tab',
    leafId: 'u96-leaf'
  })
  out['terminal.create'] = created
  const handle = readString(readField(readField(created, 'result'), 'terminal'), 'handle') ?? null

  await new Promise((resolve) => setTimeout(resolve, 1000))
  out['session.tabs.listAll.afterCreate'] = await listAll()
  out['session.tabs.list.afterCreate'] = await call('session.tabs.list', {
    worktree: `path:${workspacePath}`
  })
  out['terminal.list.afterCreate'] = await call('terminal.list', {
    worktree: `path:${workspacePath}`
  })

  // T10: a PTY that dies without the client asking — what does the inventory say?
  const second = await call('terminal.create', {
    worktree: `path:${workspacePath}`,
    title: 'u96-probe-pty-exit'
  })
  const secondPty = readString(readField(readField(second, 'result'), 'terminal'), 'ptyId')
  out['terminal.create.second'] = second
  if (secondPty) {
    service.onPtyExit(secondPty, 1)
  }
  await new Promise((resolve) => setTimeout(resolve, 1500))
  out['session.tabs.list.afterPtyExit'] = await call('session.tabs.list', {
    worktree: `path:${workspacePath}`
  })
  out['session.tabs.listAll.afterPtyExit'] = await listAll()

  out['terminal.close'] = handle ? await call('terminal.close', { terminal: handle }) : 'no handle'
  await new Promise((resolve) => setTimeout(resolve, 1500))
  out['session.tabs.listAll.afterClose'] = await listAll()
  out['session.tabs.list.afterClose'] = await call('session.tabs.list', {
    worktree: `path:${workspacePath}`
  })
  out['terminal.list.afterClose'] = await call('terminal.list', {
    worktree: `path:${workspacePath}`
  })

  mkdirSync(OUT, { recursive: true })
  writeFileSync(join(OUT, 'probe-result.json'), JSON.stringify(out, null, 2))
}, 240_000)
