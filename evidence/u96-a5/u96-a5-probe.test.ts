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

const OUT = join(process.cwd(), 'evidence', 'u96-a5')
const PROJECT_KEY = 'u96-a5-probe'
const MARKER = 'U96_A5_LIVE_MARKER'

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
let client1: CloudConnectClient
let workspacePath = ''
let projectId = ''
let firstTerminalHandle: string | null = null
let secondTerminalHandle: string | null = null

beforeAll(async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-u96-a5-')))
  const projectRoot = join(base, 'probe-project')
  initRepo(projectRoot)
  const dataDir = mkdtempSync(join(tmpdir(), 'orca-u96-a5-data-'))
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
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'u96-a5-admin' })
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
      ORCA_CLOUD_HOST_NAME: 'dev-u96-a5',
      ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1'
    },
    { userDataPath: mkdtempSync(join(tmpdir(), 'orca-u96-a5-host-')) }
  )
  if (!started) {
    throw new Error('cloud admission not enabled')
  }
  admission = started
  await admission.ready
  cloud = await startCloudRuntime({
    admission: admission.admission,
    connectionGate: admission.connectionGate,
    userDataPrefix: 'orca-u96-a5-',
    service,
    tls: makeSelfSignedTls('dev-u96-a5'),
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
  projectId = readString(await create.json(), 'id') ?? ''
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
  client1 = new CloudConnectClient({ apiUrl: platform.url, tlsRejectUnauthorized: false })
  await client1.login('zhangsan', 'Passw0rd!')
  const ensured = await ensureCloudWorkspace(client1, projectId)
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

afterAll(async () => {
  client1?.close()
  admission?.client?.stop()
  await cloud?.runtime.stop()
  await platform?.stop()
  await closeTestStores()
})

type ReadReply = { ok: true; result: unknown } | { ok: false; code: string; message?: string }

async function call(
  client: CloudConnectClient,
  method: string,
  params?: Record<string, unknown>,
  timeoutMs = 10_000
): Promise<ReadReply> {
  const reply = await client.rpc(method, params ?? {}, timeoutMs)
  return reply.ok
    ? { ok: true, result: reply.result }
    : { ok: false, code: reply.code, message: reply.message }
}

function summarize(snapshot: unknown): Record<string, unknown> {
  const result = readField(snapshot, 'result')
  const tabs = Array.isArray(readField(result, 'tabs'))
    ? (readField(result, 'tabs') as unknown[])
    : []
  const groups = Array.isArray(readField(result, 'tabGroups'))
    ? (readField(result, 'tabGroups') as unknown[])
    : []
  return {
    worktree: readString(result, 'worktree'),
    tabCount: tabs.length,
    groupCount: groups.length,
    activeTabId: readString(result, 'activeTabId'),
    activeGroupId: readString(result, 'activeGroupId'),
    tabs: tabs.map((tab) => ({
      id: readString(tab, 'id') ?? readString(tab, 'parentTabId'),
      title: readString(tab, 'title'),
      type: readString(tab, 'type'),
      ptyId: readString(readField(tab, 'terminal'), 'ptyId'),
      handle: readString(readField(tab, 'terminal'), 'handle')
    })),
    groups
  }
}

it('U96 A-5 probe: 2 groups / 2 live terminals survive a client reconnect', async () => {
  const out: Record<string, unknown> = { marker: MARKER, workspacePath }
  const selector = { worktree: `path:${workspacePath}` }
  out['workspace.info'] = await call(client1, 'workspace.info')
  out['session.tabs.list.before'] = summarize(await call(client1, 'session.tabs.list', selector))

  const first = await call(client1, 'terminal.create', {
    ...selector,
    title: 'U96 A5 terminal 1',
    tabId: 'u96-a5-tab-1',
    leafId: 'u96-a5-leaf-1'
  })
  out['terminal.create.first'] = first
  firstTerminalHandle =
    readString(readField(readField(first, 'result'), 'terminal'), 'handle') ?? null
  if (firstTerminalHandle) {
    await call(client1, 'terminal.send', {
      terminal: firstTerminalHandle,
      text: `printf '${MARKER}_ONE\\n'\r`
    })
  }

  const second = await call(client1, 'terminal.create', {
    ...selector,
    title: 'U96 A5 terminal 2',
    tabId: 'u96-a5-tab-2',
    leafId: 'u96-a5-leaf-2'
  })
  out['terminal.create.second'] = second
  const secondHandle =
    readString(readField(readField(second, 'result'), 'terminal'), 'handle') ?? null
  if (secondHandle) {
    secondTerminalHandle = secondHandle
    await call(client1, 'terminal.send', {
      terminal: secondHandle,
      text: `printf '${MARKER}_TWO\\n'\r`
    })
  }

  await new Promise((resolve) => setTimeout(resolve, 1200))
  const listed = summarize(await call(client1, 'session.tabs.list', selector))
  out['session.tabs.list.afterCreate'] = listed
  const beforeIdList = (
    (out['session.tabs.list.before'] as Record<string, unknown>)['tabs'] as { id?: string }[]
  )
    .map((tab) => tab.id)
    .filter((id): id is string => typeof id === 'string')
  const secondSurfaceId = (listed['tabs'] as { id?: string; type?: string }[]).find(
    (tab) => tab.type === 'terminal' && typeof tab.id === 'string' && !beforeIdList.includes(tab.id)
  )?.id
  out['session.tabs.move.second'] = secondSurfaceId
    ? await call(client1, 'session.tabs.move', {
        kind: 'move-to-group',
        worktree: `path:${workspacePath}`,
        tabId: secondSurfaceId,
        targetGroupId: 'u96-a5-group-2'
      })
    : 'no second surface id'

  await new Promise((resolve) => setTimeout(resolve, 800))
  out['session.tabs.list.afterMove'] = summarize(await call(client1, 'session.tabs.list', selector))
  out['terminal.read.first.beforeReopen'] = firstTerminalHandle
    ? await call(client1, 'terminal.read', { terminal: firstTerminalHandle })
    : null

  // Close the page-equivalent client; the host and its PTYs keep running.
  client1.close()
  await new Promise((resolve) => setTimeout(resolve, 800))

  const client2 = new CloudConnectClient({ apiUrl: platform.url, tlsRejectUnauthorized: false })
  await client2.login('zhangsan', 'Passw0rd!')
  const reopened = await ensureCloudWorkspace(client2, projectId)
  out['reopen.ensure'] = reopened

  out['session.tabs.list.reopened'] = summarize(await call(client2, 'session.tabs.list', selector))
  out['terminal.list.reopened'] = await call(client2, 'terminal.list', selector)
  out['terminal.read.first.reopened'] = firstTerminalHandle
    ? await call(client2, 'terminal.read', { terminal: firstTerminalHandle })
    : null
  out['terminal.read.second.reopened'] = secondTerminalHandle
    ? await call(client2, 'terminal.read', { terminal: secondTerminalHandle })
    : null

  mkdirSync(OUT, { recursive: true })
  writeFileSync(join(OUT, 'probe-result.json'), JSON.stringify(out, null, 2))
  client2.close()
}, 240_000)
