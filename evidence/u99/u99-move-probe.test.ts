import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
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

const OUT = join(process.cwd(), 'evidence', 'u99')
const PROJECT_KEY = 'u99-probe'
const MARKER = 'U99_MOVE_MARKER'

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
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-u99-')))
  const projectRoot = join(base, 'probe-project')
  initRepo(projectRoot)
  const dataDir = mkdtempSync(join(tmpdir(), 'orca-u99-data-'))
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
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'u99-admin' })
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
      ORCA_CLOUD_HOST_NAME: 'dev-u99',
      ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1'
    },
    { userDataPath: mkdtempSync(join(tmpdir(), 'orca-u99-host-')) }
  )
  if (!started) {
    throw new Error('cloud admission not enabled')
  }
  admission = started
  await admission.ready
  cloud = await startCloudRuntime({
    admission: admission.admission,
    connectionGate: admission.connectionGate,
    userDataPrefix: 'orca-u99-',
    service,
    tls: makeSelfSignedTls('dev-u99'),
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

it('U99: session.tabs.move (split / move-to-group / reorder) works headlessly and survives reconnect', async () => {
  const out: Record<string, unknown> = { marker: MARKER, workspacePath }
  const selector = { worktree: `path:${workspacePath}` }
  out['workspace.info'] = await call(client1, 'workspace.info')
  out['session.tabs.list.before'] = summarize(await call(client1, 'session.tabs.list', selector))

  const first = await call(client1, 'terminal.create', {
    ...selector,
    title: 'U99 terminal 1',
    tabId: 'u99-tab-1',
    leafId: 'u99-leaf-1'
  })
  out['terminal.create.first'] = first
  firstTerminalHandle =
    readString(readField(readField(first, 'result'), 'terminal'), 'handle') ?? null

  const second = await call(client1, 'terminal.create', {
    ...selector,
    title: 'U99 terminal 2',
    tabId: 'u99-tab-2',
    leafId: 'u99-leaf-2'
  })
  out['terminal.create.second'] = second
  secondTerminalHandle =
    readString(readField(readField(second, 'result'), 'terminal'), 'handle') ?? null

  await new Promise((resolve) => setTimeout(resolve, 1200))
  const listed = summarize(await call(client1, 'session.tabs.list', selector))
  out['session.tabs.list.afterCreate'] = listed
  const groupsAfterCreate = listed['groups'] as { id: string; tabOrder: string[] }[]
  const sourceGroupId = groupsAfterCreate[0]?.id ?? ''
  const surfaceIds = (listed['tabs'] as { id?: string; type?: string }[])
    .filter((tab) => tab.type === 'terminal')
    .map((tab) => tab.id)
    .filter((id): id is string => typeof id === 'string')

  // 1) split: pull one tab out into a brand-new group (renderer drag-to-split-group).
  const splitTarget = surfaceIds[surfaceIds.length - 1] ?? ''
  out['session.tabs.move.split'] = await call(client1, 'session.tabs.move', {
    kind: 'split',
    worktree: `path:${workspacePath}`,
    tabId: splitTarget,
    targetGroupId: sourceGroupId,
    splitDirection: 'right'
  })
  await new Promise((resolve) => setTimeout(resolve, 600))
  const afterSplit = summarize(await call(client1, 'session.tabs.list', selector))
  out['session.tabs.list.afterSplit'] = afterSplit
  const splitGroups = afterSplit['groups'] as { id: string; tabOrder: string[] }[]
  const newGroupId = splitGroups.find((group) => group.id !== sourceGroupId)?.id ?? ''

  // 2) move-to-group: drag another tab into the new group at index 0.
  const moveTarget = surfaceIds.find((id) => id !== splitTarget) ?? ''
  out['session.tabs.move.toGroup'] = await call(client1, 'session.tabs.move', {
    kind: 'move-to-group',
    worktree: `path:${workspacePath}`,
    tabId: moveTarget,
    targetGroupId: newGroupId,
    index: 0
  })
  await new Promise((resolve) => setTimeout(resolve, 600))
  out['session.tabs.list.afterMoveToGroup'] = summarize(
    await call(client1, 'session.tabs.list', selector)
  )

  // 3) reorder: reverse the remaining source group's order.
  const afterMove = out['session.tabs.list.afterMoveToGroup'] as {
    groups: { id: string; tabOrder: string[] }[]
  }
  const sourceNow = afterMove.groups.find((group) => group.id === sourceGroupId)
  const requestedOrder = [...(sourceNow?.tabOrder ?? [])].reverse()
  out['session.tabs.move.reorder'] = await call(client1, 'session.tabs.move', {
    kind: 'reorder',
    worktree: `path:${workspacePath}`,
    tabId: requestedOrder[0] ?? '',
    targetGroupId: sourceGroupId,
    tabOrder: requestedOrder
  })
  await new Promise((resolve) => setTimeout(resolve, 600))
  const afterReorder = summarize(await call(client1, 'session.tabs.list', selector))
  out['session.tabs.list.afterReorder'] = afterReorder

  // Reconnect as a new client; the host keeps running.
  client1.close()
  await new Promise((resolve) => setTimeout(resolve, 800))
  const client2 = new CloudConnectClient({ apiUrl: platform.url, tlsRejectUnauthorized: false })
  await client2.login('zhangsan', 'Passw0rd!')
  out['reopen.ensure'] = await ensureCloudWorkspace(client2, projectId)
  const reopened = summarize(await call(client2, 'session.tabs.list', selector))
  out['session.tabs.list.reopened'] = reopened

  const groupMembership = (group: { id: string; tabOrder: string[] }) => ({
    id: group.id,
    tabOrder: group.tabOrder
  })
  const reorderedGroups = afterReorder['groups'] as { id: string; tabOrder: string[] }[]
  const reopenedGroups = reopened['groups'] as { id: string; tabOrder: string[] }[]
  out['u99_verdict'] = {
    move_split_ok: (out['session.tabs.move.split'] as { ok?: boolean }).ok === true,
    move_to_group_ok: (out['session.tabs.move.toGroup'] as { ok?: boolean }).ok === true,
    move_reorder_ok: (out['session.tabs.move.reorder'] as { ok?: boolean }).ok === true,
    split_created_second_group: splitGroups.length === 2 && newGroupId.length > 0,
    reorder_landed:
      JSON.stringify(
        reorderedGroups.find((group) => group.id === sourceGroupId)?.tabOrder ?? []
      ) === JSON.stringify(requestedOrder),
    // Why: group.activeTabId is selection state the host re-derives on rebuild;
    // the move contract is group membership + order.
    reconnect_preserved_groups_and_order:
      JSON.stringify(reopenedGroups.map(groupMembership)) ===
      JSON.stringify(reorderedGroups.map(groupMembership)),
    reopened_group_count: reopenedGroups.length,
    no_rpc_timeout: [
      out['session.tabs.move.split'],
      out['session.tabs.move.toGroup'],
      out['session.tabs.move.reorder']
    ].every((reply) => (reply as { code?: string }).code !== 'RPC_TIMEOUT')
  }

  mkdirSync(OUT, { recursive: true })
  writeFileSync(join(OUT, 'probe-result.json'), JSON.stringify(out, null, 2))

  expect(out['u99_verdict']).toMatchObject({
    move_split_ok: true,
    move_to_group_ok: true,
    move_reorder_ok: true,
    split_created_second_group: true,
    reorder_landed: true,
    reconnect_preserved_groups_and_order: true,
    reopened_group_count: 2,
    no_rpc_timeout: true
  })
})
