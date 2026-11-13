import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readString } from '../../shared/json-fields'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { Store } from '../persistence/loading-store/store'
import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import { ALL_RPC_METHODS } from '../runtime/rpc/methods'
import { MANAGED_WORKTREE_METHODS } from '../runtime/rpc/methods/worktree-create-managed'
import { DEVICE_REGISTRY_FILENAME } from '../runtime/mobile-pairing-files'
import type { DeviceEntry } from '../runtime/device-registry'
import {
  startCloudRuntimeAdmission,
  type CloudRuntimeAdmission
} from '../startup/cloud-runtime-admission'
import { CloudSessionService } from './cloud-session-service'
import {
  REPO_ROOT,
  makeSelfSignedTls,
  startCloudRuntime,
  startPlatform,
  type CloudRuntime,
  type Platform
} from './cloud-session-e2e-harness'

/**
 * M63: a cloud device row is a one-shot ticket. Closing the socket must release
 * it, and a process restart must discard whatever rows a crash left behind —
 * while paired mobile devices keep their tokens throughout.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm63-cloud-device-release')

function saveEvidence(content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, 'm63-release.json'), JSON.stringify(content, null, 2))
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function initRepo(path: string): void {
  mkdirSync(path, { recursive: true })
  git(path, 'init', '-q', '-b', 'main')
  git(path, 'config', 'user.email', 'e2e@example.com')
  git(path, 'config', 'user.name', 'e2e')
  writeFileSync(join(path, 'README.md'), '# m63\n')
  git(path, 'add', '.')
  git(path, 'commit', '-qm', 'init')
}

async function waitForCount(read: () => number, expected: number): Promise<number> {
  const deadline = Date.now() + 5000
  let value = read()
  while (value !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    value = read()
  }
  return value
}

let platform: Platform
let admission: CloudRuntimeAdmission
let cloud: CloudRuntime
let session: CloudSessionService
let store: Store
let runtimeUserData = ''
let projectId = ''
let pairedToken = ''
let restart: OrcaRuntimeRpcServer | null = null
let runtimeStopped = false

function registryFile(): string {
  return join(runtimeUserData, DEVICE_REGISTRY_FILENAME)
}

function parseRows(text: string): DeviceEntry[] {
  const parsed: unknown = JSON.parse(text)
  if (!Array.isArray(parsed)) {
    throw new Error('device registry is not an array')
  }
  return parsed.filter(
    (row): row is DeviceEntry => row !== null && typeof row === 'object' && !Array.isArray(row)
  )
}

function readRows(): DeviceEntry[] {
  return parseRows(readFileSync(registryFile(), 'utf-8'))
}

function pairedRowCount(rows: readonly DeviceEntry[]): number {
  return rows.filter((row) => row.cloudSession === undefined).length
}

beforeAll(async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-m63-')))
  const projectRoot = join(base, 'device-release-service')
  initRepo(projectRoot)

  const dataDir = mkdtempSync(join(tmpdir(), 'orca-m63-data-'))
  installFakeAppEnvironment({ getPath: () => dataDir })
  store = createSqliteTestStore(Store, { dataFile: join(dataDir, 'orca-data.json') })
  store.addRepo({
    id: 'repo-m63',
    path: projectRoot,
    displayName: 'device-release-service',
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
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'm63-admin' })
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
      ORCA_CLOUD_HOST_NAME: 'dev-m63',
      ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1'
    },
    { userDataPath: mkdtempSync(join(tmpdir(), 'orca-m63-host-')) }
  )
  if (!started) {
    throw new Error('cloud admission not enabled')
  }
  admission = started
  await admission.ready

  runtimeUserData = mkdtempSync(join(tmpdir(), 'orca-m63-runtime-'))
  cloud = await startCloudRuntime({
    admission: admission.admission,
    connectionGate: admission.connectionGate,
    userDataPath: runtimeUserData,
    service,
    tls: makeSelfSignedTls('dev-m63'),
    methods: [...ALL_RPC_METHODS, ...MANAGED_WORKTREE_METHODS]
  })
  admission.bindRuntime(cloud.runtime)
  await admission.client!.refresh()

  const created = await fetch(`${platform.url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      key: 'm63-device-release',
      name: 'M63 Device Release',
      hostId: admission.host()!.hostId,
      path: projectRoot
    })
  })
  expect(created.status, await created.clone().text()).toBe(201)
  projectId = readString(await created.json(), 'id') ?? ''
  const granted = await fetch(`${platform.url}/v1/projects/${projectId}/grants`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      subjectType: 'group',
      subjectId: 'team-payment',
      permissions: ['open', 'terminal', 'file:read', 'file:write']
    })
  })
  expect(granted.status, await granted.clone().text()).toBe(200)

  session = new CloudSessionService({ apiUrl: platform.url, tlsRejectUnauthorized: false })
  await session.login('zhangsan', 'Passw0rd!')

  // A paired phone that must survive every cloud release and restart.
  pairedToken = cloud.runtime.getDeviceRegistry()!.addDevice('paired-phone').token
}, 120_000)

afterAll(async () => {
  session?.logout()
  admission?.stop()
  if (!runtimeStopped) {
    await cloud?.runtime.stop()
  }
  await restart?.stop()
  await platform?.stop()
  await closeTestStores()
})

describe('M63 主机关闭/重启释放云端设备 token（真实平台 + 真实 TLS Runtime）', () => {
  it('关闭云会话释放该 token，重启丢弃死票，paired 设备不受影响', async () => {
    const registry = cloud.runtime.getDeviceRegistry()!
    const pairedBefore = pairedRowCount(registry.listDevices())
    expect(pairedBefore).toBeGreaterThan(0)
    expect(registry.countCloudTokens()).toBe(0)

    const opened = await session.ensureWorkspace(projectId)
    expect(opened.ok, JSON.stringify(opened)).toBe(true)
    expect(registry.countCloudTokens()).toBe(1)
    const cloudRow = registry.listDevices().find((row) => row.cloudSession !== undefined)
    expect(cloudRow).toBeDefined()
    const cloudToken = cloudRow!.token
    expect(registry.validateToken(cloudToken)?.cloudSession?.projectId).toBe(projectId)
    const pairedAfterOpen = pairedRowCount(registry.listDevices())

    expect(session.closeProject(projectId)).toEqual({ ok: true })
    expect(await waitForCount(() => registry.countCloudTokens(), 0)).toBe(0)
    expect(registry.validateToken(cloudToken)).toBeNull()
    expect(registry.validateToken(pairedToken)).not.toBeNull()
    expect(pairedRowCount(registry.listDevices())).toBe(pairedBefore)
    const afterCloseRows = readRows()

    const reopened = await session.ensureWorkspace(projectId)
    expect(reopened.ok, JSON.stringify(reopened)).toBe(true)
    expect(await waitForCount(() => registry.countCloudTokens(), 1)).toBe(1)
    const secondToken = registry.listDevices().find((row) => row.cloudSession !== undefined)!.token
    // Snapshot a live-but-about-to-crash registry: the reopened row is real and on disk.
    const liveSnapshot = readFileSync(registryFile(), 'utf-8')
    expect(parseRows(liveSnapshot)).toHaveLength(pairedBefore + 1)

    await cloud.runtime.stop()
    runtimeStopped = true
    // Simulate the crash: restore the row the stopped process released on close.
    writeFileSync(registryFile(), liveSnapshot)
    restart = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(store),
      userDataPath: runtimeUserData,
      enableWebSocket: true,
      wsPort: 0
    })
    await restart.start()
    const restartedRegistry = restart.getDeviceRegistry()!
    expect(restartedRegistry.countCloudTokens()).toBe(0)
    expect(restartedRegistry.validateToken(secondToken)).toBeNull()
    expect(restartedRegistry.validateToken(pairedToken)).not.toBeNull()
    const restartRows = readRows()
    expect(restartRows).toHaveLength(pairedBefore)
    expect(restartRows.some((row) => row.cloudSession !== undefined)).toBe(false)
    expect(readFileSync(registryFile(), 'utf-8')).not.toContain('cloudSession')

    saveEvidence({
      pairedDevices: { before: pairedBefore, afterOpen: pairedAfterOpen, afterClose: pairedBefore },
      cloudTokens: {
        initial: 0,
        afterEnsureWorkspace: 1,
        afterClose: 0,
        afterReopen: 1,
        afterRestart: restartedRegistry.countCloudTokens()
      },
      release: {
        validatedAfterOpen: true,
        cloudTokenInvalidAfterClose: registry.validateToken(cloudToken) === null,
        pairedTokenAliveAfterClose: registry.validateToken(pairedToken) !== null,
        rowsAfterClose: afterCloseRows.length
      },
      restart: {
        rowsOnDisk: restartRows.length,
        cloudSessionKeysOnDisk: restartRows.filter((row) => row.cloudSession !== undefined).length,
        pairedTokenAlive: restartedRegistry.validateToken(pairedToken) !== null
      }
    })
  }, 240_000)
})
