import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readString } from '../../shared/json-fields'
import { cloudWorktreeSelector, previewCloudFile } from '../../shared/cloud-file-browser'
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
 * U325: the file browser's two content guards over the real host stack.
 *
 * A text preview is bounded at 512KB and a NUL-containing file is reported as
 * binary with no bytes, so the pane never renders binary payload as text.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'u325-file-preview')
const PROJECT_KEY = 'file-preview-guards'
const PREVIEW_CAP_BYTES = 512 * 1024
const BIG_NAME = 'big-preview.txt'
const TAIL_MARKER = 'U325_TAIL_MARKER_MUST_NOT_ESCAPE'
const BINARY_NAME = 'payload.dat'
const BINARY_SECRET = 'U325_BINARY_SECRET_MUST_NOT_ESCAPE'

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
  // Over the cap by well over a byte, with a marker only the tail could carry.
  writeFileSync(join(path, BIG_NAME), `${'a'.repeat(PREVIEW_CAP_BYTES + 64 * 1024)}${TAIL_MARKER}`)
  writeFileSync(
    join(path, BINARY_NAME),
    Buffer.concat([Buffer.from(`${BINARY_SECRET}\n`), Buffer.from([0, 1, 2, 3])])
  )
  git(path, 'add', '.')
  git(path, 'commit', '-qm', 'init')
}

let platform: Platform
let admission: CloudRuntimeAdmission
let cloud: CloudRuntime
let projectId = ''
let adminToken = ''
let desktop: CloudConnectClient
let workspacePath = ''
const fullPermissions = ['open', 'terminal', 'file:read', 'file:write']

beforeAll(async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-u325-file-preview-')))
  const projectRoot = join(base, 'payment-service')
  initRepo(projectRoot)

  const dataDir = mkdtempSync(join(tmpdir(), 'orca-u325-file-preview-data-'))
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
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'u325-admin' })
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
      ORCA_CLOUD_HOST_NAME: 'dev-u325',
      ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1'
    },
    { userDataPath: mkdtempSync(join(tmpdir(), 'orca-u325-file-preview-host-')) }
  )
  if (!started) {
    throw new Error('cloud admission not enabled')
  }
  admission = started
  await admission.ready

  cloud = await startCloudRuntime({
    admission: admission.admission,
    connectionGate: admission.connectionGate,
    userDataPrefix: 'orca-u325-file-preview-',
    service,
    tls: makeSelfSignedTls('dev-u325'),
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
      permissions: fullPermissions
    })
  })
  expect(grant.status, await grant.clone().text()).toBe(200)

  desktop = new CloudConnectClient({ apiUrl: platform.url, tlsRejectUnauthorized: false })
  await desktop.login('zhangsan', 'Passw0rd!')
  const ensured = await ensureCloudWorkspace(desktop, projectId)
  if (!ensured.ok) {
    throw new Error(`workspace ensure failed: ${ensured.code} ${ensured.message ?? ''}`)
  }
  workspacePath = ensured.workspacePath
})

afterAll(async () => {
  desktop?.close()
  admission?.client?.stop()
  await cloud?.runtime.stop()
  await platform?.stop()
  await closeTestStores()
})

function rpc(method: string, params?: Record<string, unknown>) {
  return desktop.rpc(method, params)
}

describe('U325 文件预览上限与二进制拒绝（真实平台 + 真实 Runtime + 真实 worktree）', () => {
  it('U325-1 超过 512KB 的文本：预览被拒绝，编辑器读取截断且不越过上限', async () => {
    const preview = await previewCloudFile(desktop.rpc.bind(desktop), workspacePath, BIG_NAME)
    expect(preview.ok, JSON.stringify(preview)).toBe(false)
    if (!preview.ok) {
      // The host throws `file_too_large`; the RPC layer surfaces it as runtime_error.
      expect(preview.code).toBe('runtime_error')
      expect(preview.message).toBe('file_too_large')
      expect(JSON.stringify(preview)).not.toContain(TAIL_MARKER)
    }

    const read = await rpc('files.read', {
      worktree: cloudWorktreeSelector(workspacePath),
      relativePath: BIG_NAME
    })
    expect(read.ok, JSON.stringify(read)).toBe(true)
    if (read.ok) {
      const result = read.result as { content: string; truncated: boolean; byteLength: number }
      expect(result.truncated).toBe(true)
      expect(Buffer.byteLength(result.content, 'utf8')).toBe(PREVIEW_CAP_BYTES)
      expect(result.content).not.toContain(TAIL_MARKER)
      // The host reads at most cap+1 so it can report "there is more".
      expect(result.byteLength).toBe(PREVIEW_CAP_BYTES + 1)
    }

    saveEvidence('u325-1-size-cap.json', { preview, read })
  }, 60_000)

  it('U325-2 含 NUL 的二进制：只报类型，不返回也不预览内容', async () => {
    const preview = await previewCloudFile(desktop.rpc.bind(desktop), workspacePath, BINARY_NAME)
    expect(preview.ok, JSON.stringify(preview)).toBe(true)
    if (preview.ok) {
      expect(preview.preview.isBinary).toBe(true)
      expect(preview.preview.isImage).toBe(false)
      expect(preview.preview.content).toBe('')
      expect(JSON.stringify(preview)).not.toContain(BINARY_SECRET)
    }

    saveEvidence('u325-2-binary.json', { preview })
  }, 60_000)
})
