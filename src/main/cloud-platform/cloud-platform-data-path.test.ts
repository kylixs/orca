import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readString } from '../../shared/json-fields'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { Store } from '../persistence/loading-store/store'
import { createSqliteTestStore } from '../persistence-test-harness'
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
import { startRecordingProxy, type RecordingProxy } from './cloud-tcp-proxy-fixture'

/**
 * M85 (G-12 / AC-05, AC-24): the platform is a control plane only. This test puts
 * a recording hop in front of every byte the client and host send it, pushes a
 * large file through a real direct session (real TLS, real E2EE, real runtime),
 * and asserts the payload never crossed that hop. A control marker sent to the
 * platform on purpose proves the recording would have seen it if it had.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm85-platform-data-path')
const MARKER = 'M85_SESSION_PAYLOAD_7f3a9c_'
const PAYLOAD = MARKER.repeat(2048)
const CONTROL_MARKER = 'M85_CONTROL_SEEN_ON_PLATFORM_51d2'

function saveEvidence(file: string, content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, file), JSON.stringify(content, null, 2))
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

type Stack = {
  platform: Platform
  proxy: RecordingProxy
  cloud: CloudRuntime
  admission: CloudRuntimeAdmission
  client: CloudConnectClient
  projectId: string
  adminToken: string
  workspacePath: string
}

let stack: Stack

beforeAll(async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-m85-')))
  installFakeAppEnvironment({ getPath: () => dir })
  const store = createSqliteTestStore(Store, { dataFile: join(dir, 'orca-data.json') })
  const projectRoot = join(dir, 'payment-service')
  mkdirSync(projectRoot, { recursive: true })
  git(projectRoot, 'init', '-q', '-b', 'main')
  git(projectRoot, 'config', 'user.email', 'e2e@example.com')
  git(projectRoot, 'config', 'user.name', 'e2e')
  writeFileSync(join(projectRoot, 'README.md'), 'hello\n')
  git(projectRoot, 'add', '.')
  git(projectRoot, 'commit', '-qm', 'init')
  store.addRepo({
    id: 'repo-m85',
    path: projectRoot,
    displayName: 'payment-service',
    badgeColor: 'gray',
    addedAt: 1
  })
  store.updateSettings({ workspaceDir: join(dir, 'host-workspaces') })
  store.flushOrThrow()
  const service = new OrcaRuntimeService(store)

  const platform = await startPlatform()
  const adminLogin = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'm85-admin' })
  })
  const adminToken = readString(await adminLogin.json(), 'accessToken')
  if (adminToken === null) {
    throw new Error('admin login failed')
  }
  const proxy = await startRecordingProxy(Number(new URL(platform.url).port))

  const hostTokenRes = await fetch(`${platform.url}/v1/hosts/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}` }
  })
  const hostToken = readString(await hostTokenRes.json(), 'token')
  if (hostToken === null) {
    throw new Error('host token missing')
  }

  // Both the host's control traffic and the client's go through the recording hop.
  const admission = startCloudRuntimeAdmission(
    {
      ORCA_CLOUD_API_URL: proxy.url,
      ORCA_CLOUD_HOST_TOKEN: hostToken,
      ORCA_CLOUD_HOST_NAME: 'dev-m85',
      ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1'
    },
    { userDataPath: join(dir, 'host-data') }
  )
  if (!admission) {
    throw new Error('cloud admission not enabled')
  }
  await admission.ready

  const cloud = await startCloudRuntime({
    admission: admission.admission,
    connectionGate: admission.connectionGate,
    userDataPrefix: 'orca-m85-',
    service,
    tls: makeSelfSignedTls('dev-m85'),
    methods: [...ALL_RPC_METHODS, ...MANAGED_WORKTREE_METHODS]
  })
  admission.bindRuntime(cloud.runtime)
  await admission.client!.refresh()

  const create = await fetch(`${platform.url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      key: 'm85-data-path',
      name: 'm85-data-path',
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

  const client = new CloudConnectClient({ apiUrl: proxy.url, tlsRejectUnauthorized: false })
  await client.login('zhangsan', 'Passw0rd!')
  const ensured = await ensureCloudWorkspace(client, projectId)
  if (!ensured.ok) {
    throw new Error(`workspace ensure failed: ${ensured.code} ${ensured.message ?? ''}`)
  }
  stack = {
    platform,
    proxy,
    cloud,
    admission,
    client,
    projectId,
    adminToken,
    workspacePath: ensured.workspacePath
  }
}, 180_000)

afterAll(async () => {
  stack?.client.close()
  stack?.admission.client?.stop()
  await stack?.cloud.runtime.stop()
  await stack?.proxy.close()
  await stack?.platform.stop()
})

describe('平台只在控制面（真实平台 + 记录代理 + 真实 TLS Runtime + E2EE）', () => {
  it('M85-1 会话大负载不经过平台；同路径对照标记能被记录', async () => {
    const before = stack.proxy.totalBytes()
    const write = await stack.client.rpc('files.write', {
      worktree: `path:${stack.workspacePath}`,
      relativePath: 'large-payload.txt',
      content: PAYLOAD,
      expectedExecutionHostId: 'local'
    })
    expect(write.ok, JSON.stringify(write)).toBe(true)
    const read = await stack.client.rpc('files.read', {
      worktree: `path:${stack.workspacePath}`,
      relativePath: 'large-payload.txt'
    })
    if (!read.ok) {
      throw new Error(`read failed: ${read.code} ${read.message ?? ''}`)
    }
    // The reply carried the payload back over the session, not over the platform.
    expect(JSON.stringify(read.result)).toContain(MARKER)
    expect(readFileSync(join(stack.workspacePath, 'large-payload.txt'), 'utf8')).toBe(PAYLOAD)
    const duringPayload = stack.proxy.totalBytes() - before

    const platformBytes = stack.proxy.captured()
    expect(platformBytes.includes(Buffer.from(MARKER))).toBe(false)

    // Control: the same recording does see a marker sent to the platform.
    const control = await fetch(`${stack.proxy.url}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'lisi',
        password: 'Passw0rd!',
        deviceName: CONTROL_MARKER,
        devicePubKey: Buffer.from('m85-control-device').toString('base64')
      })
    })
    expect(control.status, await control.clone().text()).toBe(200)
    expect(stack.proxy.captured().includes(Buffer.from(CONTROL_MARKER))).toBe(true)

    // The platform's own audit log holds no payload either.
    const audit = await fetch(`${stack.platform.url}/v1/audit/events?limit=200`, {
      headers: { authorization: `Bearer ${stack.adminToken}` }
    })
    expect(audit.status).toBe(200)
    const auditBody = await audit.text()
    expect(auditBody.includes(MARKER)).toBe(false)

    saveEvidence('platform-not-in-data-path.json', {
      payloadBytes: Buffer.byteLength(PAYLOAD),
      platformBytesDuringPayload: duringPayload,
      platformBytesCaptured: stack.proxy.totalBytes(),
      payloadMarkerInPlatformBytes: false,
      controlMarkerInPlatformBytes: true,
      payloadMarkerInAudit: false,
      readBackMatchesDisk: true
    })
  }, 60_000)
})
