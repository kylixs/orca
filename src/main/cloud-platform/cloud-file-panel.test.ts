import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readString } from '../../shared/json-fields'
import {
  browseCloudDirectory,
  previewCloudFile,
  type CloudFileEntry
} from '../../shared/cloud-file-browser'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { Store } from '../persistence/loading-store/store'
import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { ALL_RPC_METHODS } from '../runtime/rpc/methods'
import { MANAGED_WORKTREE_METHODS } from '../runtime/rpc/methods/worktree-create-managed'
import {
  REPO_ROOT,
  makeSelfSignedTls,
  openPlatformSession,
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
import { readTicketClaims } from './cloud-connect-response'
import { ensureCloudWorkspace } from './cloud-workspace-ensure'

/**
 * T206 file pane, end to end: the panel's own browse/preview functions, the real
 * desktop connect client, a real platform ticket, a real TLS runtime, and a real
 * git worktree. What the pane shows is exactly what the host answered.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm42-file-panel')
const PROJECT_KEY = 'file-panel-project'

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
  writeFileSync(join(path, 'README.md'), '# payment service\n')
  mkdirSync(join(path, 'src'), { recursive: true })
  writeFileSync(join(path, 'src', 'app.ts'), 'export const app = 1\n')
  writeFileSync(join(path, 'logo.bin'), Buffer.from([0, 1, 2, 3]))
  git(path, 'add', '.')
  git(path, 'commit', '-qm', 'init')
}

let platform: Platform
let admission: CloudRuntimeAdmission
let cloud: CloudRuntime
let projectRoot = ''
let otherRepoPath = ''
let projectId = ''
let adminToken = ''
let desktop: CloudConnectClient
let workspacePath = ''
const fullPermissions = ['open', 'terminal', 'file:read', 'file:write']

beforeAll(async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-cloud-file-panel-')))
  projectRoot = join(base, 'payment-service')
  otherRepoPath = join(base, 'other-team')
  initRepo(projectRoot)
  initRepo(otherRepoPath)
  writeFileSync(join(otherRepoPath, 'secret.txt'), 'other team only\n')

  const dataDir = mkdtempSync(join(tmpdir(), 'orca-cloud-file-panel-data-'))
  installFakeAppEnvironment({ getPath: () => dataDir })
  const store = createSqliteTestStore(Store, { dataFile: join(dataDir, 'orca-data.json') })
  store.addRepo({
    id: 'repo-project',
    path: projectRoot,
    displayName: 'payment-service',
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
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'panel-admin' })
  })
  adminToken = readString(await admin.json(), 'accessToken') ?? ''
  if (adminToken === '') {
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
      ORCA_CLOUD_HOST_NAME: 'dev-panel',
      ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1'
    },
    { userDataPath: mkdtempSync(join(tmpdir(), 'orca-cloud-file-panel-host-')) }
  )
  if (!started) {
    throw new Error('cloud admission not enabled')
  }
  admission = started
  await admission.ready

  cloud = await startCloudRuntime({
    admission: admission.admission,
    connectionGate: admission.connectionGate,
    userDataPrefix: 'orca-cloud-file-panel-',
    service,
    tls: makeSelfSignedTls('dev-panel'),
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
  await grant(fullPermissions)

  desktop = await newDesktop()
  const ensured = await ensureCloudWorkspace(desktop, projectId)
  if (!ensured.ok) {
    throw new Error(`workspace ensure failed: ${ensured.code} ${ensured.message ?? ''}`)
  }
  workspacePath = ensured.workspacePath
})

async function grant(permissions: string[]): Promise<void> {
  const res = await fetch(`${platform.url}/v1/projects/${projectId}/grants`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ subjectType: 'group', subjectId: 'team-payment', permissions })
  })
  expect(res.status, await res.clone().text()).toBe(200)
}

async function newDesktop(): Promise<CloudConnectClient> {
  const client = new CloudConnectClient({
    apiUrl: platform.url,
    tlsRejectUnauthorized: false
  })
  await client.login('zhangsan', 'Passw0rd!')
  return client
}

afterAll(async () => {
  desktop?.close()
  admission?.client?.stop()
  await cloud?.runtime.stop()
  await platform?.stop()
  await closeTestStores()
})

function names(entries: CloudFileEntry[]): string[] {
  return entries.map((entry) => `${entry.kind}:${entry.name}`)
}

describe('云端文件面板（真实平台 + 真实 Runtime + 真实 worktree）', () => {
  it('M42-1 列工作区根目录并预览文件，内容来自主机真实读取', async () => {
    const root = await browseCloudDirectory(desktop.rpc.bind(desktop), workspacePath)
    expect(root.ok, JSON.stringify(root)).toBe(true)
    if (!root.ok) {
      throw new Error(root.code)
    }
    // Directories first; the worktree contains the repo files checked out for this user.
    expect(names(root.entries)).toEqual(['directory:src', 'file:logo.bin', 'file:README.md'])

    const src = await browseCloudDirectory(desktop.rpc.bind(desktop), workspacePath, 'src')
    expect(src.ok && names(src.entries)).toEqual(['file:app.ts'])

    const preview = await previewCloudFile(desktop.rpc.bind(desktop), workspacePath, 'README.md')
    expect(preview.ok, JSON.stringify(preview)).toBe(true)
    if (preview.ok) {
      expect(preview.preview.content).toBe('# payment service\n')
      expect(preview.preview.isBinary).toBe(false)
    }

    saveEvidence('m42-1-browse-preview.json', { root, src, preview })
  }, 60000)

  it('M42-2 越出项目根的相对路径被主机拒绝，面板显示原因', async () => {
    const escape = await browseCloudDirectory(
      desktop.rpc.bind(desktop),
      workspacePath,
      '../../../../other-team'
    )
    expect(escape.ok).toBe(false)
    if (!escape.ok) {
      expect(escape.code).toBe('forbidden')
      expect(escape.message).toContain('outside the project')
    }

    const secret = await previewCloudFile(
      desktop.rpc.bind(desktop),
      workspacePath,
      '../../../../other-team/secret.txt'
    )
    expect(secret.ok).toBe(false)

    saveEvidence('m42-2-outside-project.json', { escape, secret })
  }, 60000)

  it('M42-3 票据权限是上限：收回 file:read 后新票据不再带它，读取被拒', async () => {
    // Read the permissions from the ticket the platform actually signs, not from
    // the UI's own bookkeeping.
    const beforeTicket = await openPlatformSession(platform, {
      projectKey: PROJECT_KEY,
      deviceName: 'panel-before'
    })
    expect(readTicketClaims(beforeTicket.credential).permissions).toContain('file:read')

    await grant(['open', 'terminal', 'file:write'])
    const afterTicket = await openPlatformSession(platform, {
      projectKey: PROJECT_KEY,
      deviceName: 'panel-after'
    })
    const claims = readTicketClaims(afterTicket.credential)
    expect(claims.permissions).not.toContain('file:read')

    const after = await newDesktop()
    await after.openProject(projectId)

    const refused = await browseCloudDirectory(after.rpc.bind(after), workspacePath)
    expect(refused.ok).toBe(false)
    if (!refused.ok) {
      expect(refused.code).toBe('forbidden')
      expect(refused.message).toContain("'file:read'")
    }

    saveEvidence('m42-3-permission-drop.json', {
      before: readTicketClaims(beforeTicket.credential).permissions,
      after: claims.permissions,
      refused
    })
    after.close()
    await grant(fullPermissions)
  }, 60000)
})
