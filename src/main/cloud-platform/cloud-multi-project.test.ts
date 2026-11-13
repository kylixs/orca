import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readString } from '../../shared/json-fields'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { Store } from '../persistence/loading-store/store'
import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { ALL_RPC_METHODS } from '../runtime/rpc/methods'
import { MANAGED_WORKTREE_METHODS } from '../runtime/rpc/methods/worktree-create-managed'
import {
  startCloudRuntimeAdmission,
  type CloudRuntimeAdmission
} from '../startup/cloud-runtime-admission'
import { CloudSessionService } from './cloud-session-service'
import {
  makeSelfSignedTls,
  REPO_ROOT,
  startCloudRuntime,
  startPlatform,
  type CloudRuntime,
  type Platform
} from './cloud-session-e2e-harness'

/**
 * M53: two projects on ONE enrolled host, each opened over its own socket from a
 * single platform login. Both tickets must name the same registered device key,
 * and closing one socket must leave the other answering.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm53-multi-project')
const PERMISSIONS = ['open', 'terminal', 'agent', 'file:read', 'file:write', 'download']

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
  writeFileSync(join(path, 'README.md'), '# m53\n')
  git(path, 'add', '.')
  git(path, 'commit', '-qm', 'init')
}

function runtimeIdOf(
  outcome: { ok: true; result: unknown } | { ok: false; code: string }
): string | null {
  return outcome.ok ? readString(outcome.result, 'runtimeId') : null
}

let platform: Platform
let admission: CloudRuntimeAdmission
let cloud: CloudRuntime
let session: CloudSessionService
let rootA = ''
let rootB = ''
let projectA = ''
let projectB = ''

async function createProject(key: string, path: string, adminToken: string): Promise<string> {
  const res = await fetch(`${platform.url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ key, name: key, hostId: admission.host()!.hostId, path })
  })
  expect(res.status, await res.clone().text()).toBe(201)
  const id = readString(await res.json(), 'id')
  if (id === null) {
    throw new Error(`project ${key} has no id`)
  }
  await fetch(`${platform.url}/v1/projects/${id}/grants`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      subjectType: 'group',
      subjectId: 'team-payment',
      permissions: PERMISSIONS
    })
  })
  return id
}

beforeAll(async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-m53-multi-')))
  rootA = join(base, 'alpha-service')
  rootB = join(base, 'beta-service')
  initRepo(rootA)
  initRepo(rootB)

  const dataDir = mkdtempSync(join(tmpdir(), 'orca-m53-data-'))
  installFakeAppEnvironment({ getPath: () => dataDir })
  const store = createSqliteTestStore(Store, { dataFile: join(dataDir, 'orca-data.json') })
  store.addRepo({
    id: 'repo-alpha',
    path: rootA,
    displayName: 'alpha-service',
    badgeColor: 'gray',
    addedAt: 1
  })
  store.addRepo({
    id: 'repo-beta',
    path: rootB,
    displayName: 'beta-service',
    badgeColor: 'gray',
    addedAt: 1
  })
  store.updateSettings({ workspaceDir: join(base, 'host-workspaces') })
  store.flushOrThrow()
  const service = new OrcaRuntimeService(store)

  platform = await startPlatform()
  const admin = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'm53-admin' })
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
      ORCA_CLOUD_HOST_NAME: 'dev-m53',
      ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1'
    },
    { userDataPath: mkdtempSync(join(tmpdir(), 'orca-m53-host-')) }
  )
  if (!started) {
    throw new Error('cloud admission not enabled')
  }
  admission = started
  await admission.ready

  cloud = await startCloudRuntime({
    admission: admission.admission,
    connectionGate: admission.connectionGate,
    userDataPrefix: 'orca-m53-',
    service,
    tls: makeSelfSignedTls('dev-m53'),
    methods: [...ALL_RPC_METHODS, ...MANAGED_WORKTREE_METHODS]
  })
  admission.bindRuntime(cloud.runtime)
  await admission.client!.refresh()

  projectA = await createProject('m53-alpha', rootA, adminToken)
  projectB = await createProject('m53-beta', rootB, adminToken)
  // Grant changes invalidate tickets minted before them.
  await new Promise((resolve) => setTimeout(resolve, 1200))

  session = new CloudSessionService({ apiUrl: platform.url, tlsRejectUnauthorized: false })
  await session.login('zhangsan', 'Passw0rd!')
}, 120_000)

afterAll(async () => {
  admission?.stop()
  await cloud?.runtime.stop()
  await platform?.stop()
  await closeTestStores()
})

describe('M53 每项目独立连接（真实平台 + 真实 TLS Runtime）', () => {
  it('两个项目同时在线、共享同一设备身份，关闭一个不影响另一个', async () => {
    const openedA = await session.openProject(projectA)
    const openedB = await session.openProject(projectB)
    expect(openedA.ok, JSON.stringify(openedA)).toBe(true)
    expect(openedB.ok, JSON.stringify(openedB)).toBe(true)
    expect(session.connectedProjectIds.sort()).toEqual([projectA, projectB].sort())

    // Each socket is scoped to its own project on the same host: the allowed
    // call succeeds on its own connection and is refused on the other one.
    const listA = await session.rpc('worktree.list', { repo: `path:${rootA}` }, projectA)
    const listB = await session.rpc('worktree.list', { repo: `path:${rootB}` }, projectB)
    expect(listA.ok, JSON.stringify(listA)).toBe(true)
    expect(listB.ok, JSON.stringify(listB)).toBe(true)
    const cross = await session.rpc('worktree.list', { repo: `path:${rootB}` }, projectA)
    expect(cross.ok).toBe(false)
    if (!cross.ok) {
      expect(cross.code).toBe('forbidden')
    }

    const statusA = await session.rpc('status.get', {}, projectA)
    const statusB = await session.rpc('status.get', {}, projectB)
    const runtimeIdA = runtimeIdOf(statusA)
    const runtimeIdB = runtimeIdOf(statusB)
    expect(runtimeIdA, JSON.stringify(statusA)).toEqual(expect.any(String))
    expect(runtimeIdB, JSON.stringify(statusB)).toEqual(expect.any(String))
    expect(runtimeIdA).toBe(runtimeIdB)

    // One login, one registered device: both tickets name the same key and the
    // host accepted both (so each hello key matched its ticket).
    const deviceKeyPair = session.deviceKeyPair()
    if (!deviceKeyPair) {
      throw new Error('signed-in session has no device keys')
    }
    const devicePubKey = Buffer.from(deviceKeyPair.publicKey).toString('base64')
    const identities = session.connectionIdentities()
    expect(identities).toHaveLength(2)
    expect(identities.map((entry) => entry.devicePubKey)).toEqual([devicePubKey, devicePubKey])
    expect(session.currentDeviceId.length).toBeGreaterThan(0)

    const evidence = {
      projects: { projectA, projectB, rootA, rootB },
      identity: {
        deviceId: session.currentDeviceId,
        devicePubKey,
        connections: identities
      },
      projectScopedRpc: { listA, listB, cross },
      statusGet: { projectA: statusA, projectB: statusB }
    }
    saveEvidence('m53-1-both-projects.json', evidence)
    console.log('[m53] both projects connected:', JSON.stringify(evidence))

    expect(session.closeProject(projectA)).toEqual({ ok: true })
    expect(session.isProjectConnected(projectA)).toBe(false)
    expect(session.isProjectConnected(projectB)).toBe(true)

    const closedA = await session.rpc('status.get', {}, projectA)
    const afterB = await session.rpc('status.get', {}, projectB)
    expect(closedA).toEqual({ ok: false, code: 'NOT_CONNECTED' })
    expect(runtimeIdOf(afterB)).toBe(runtimeIdB)
    // The surviving family still names the same device.
    expect(session.connectionIdentities()).toEqual([
      { projectId: projectB, route: identities[1].route, devicePubKey }
    ])

    const afterClose = {
      closedProject: projectA,
      closedA,
      projectBStatus: afterB,
      remainingConnections: session.connectionIdentities()
    }
    saveEvidence('m53-2-close-one.json', afterClose)
    console.log('[m53] after closing alpha:', JSON.stringify(afterClose))
  }, 180_000)
})
