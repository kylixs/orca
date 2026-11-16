import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { readField, readNumber, readString } from '../../shared/json-fields'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { Store } from '../persistence/loading-store/store'
import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import {
  REPO_ROOT,
  connectCloudSession,
  makeSelfSignedTls,
  openPlatformSession,
  startCloudRuntime,
  startPlatform,
  type CloudConnection,
  type CloudRuntime,
  type Platform
} from './cloud-session-e2e-harness'
import { startCloudRuntimeAdmission } from '../startup/cloud-runtime-admission'
import { installCloudAccessGuard } from '../startup/cloud-runtime-attach'

/**
 * U66 phase 2 (OQ-6): the host hard-blocks the real data-fetch path — a
 * `files.readChunk` run that rebuilds an entire multi-chunk file is refused for
 * a session without the ticket's `download` bit or under a deny policy, and the
 * refusal lands as `file_download denied` (host-attested) on the platform
 * chain. U70: single windows above 64KB are refused the same way; the first
 * prefix window and out-of-order windows stay open (declared residual ①③).
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'u66-phase2-host')
const PROJECT_KEY = 'u66-download-enforce'

function saveEvidence(file: string, content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, file), JSON.stringify(content, null, 2))
}

function initRepo(path: string): void {
  mkdirSync(path, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: path })
  execFileSync('git', ['config', 'user.email', 'e2e@example.com'], { cwd: path })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: path })
  writeFileSync(join(path, 'README.md'), 'hello\n')
  execFileSync('git', ['add', '.'], { cwd: path })
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: path })
}

let platform: Platform
let adminToken = ''
let admission: ReturnType<typeof startCloudRuntimeAdmission>
let cloud: CloudRuntime
let service: OrcaRuntimeService
let base = ''
let projectRoot = ''
let projectId = ''

/** 4 windows of 1024 bytes: the last one completes the file. */
const BIG_SIZE = 4096
const WINDOW = 1024

async function readChunk(
  session: Extract<CloudConnection, { status: 'authenticated' }>,
  relativePath: string,
  offset: number,
  length = WINDOW
) {
  return session.rpc('files.readChunk', {
    worktree: `path:${projectRoot}`,
    relativePath,
    offset,
    length
  })
}

async function connectSession(
  deviceName: string
): Promise<Extract<CloudConnection, { status: 'authenticated' }>> {
  const session = await openPlatformSession(platform, { projectKey: PROJECT_KEY, deviceName })
  const connection = await connectCloudSession(
    cloud.endpoint,
    cloud.serverPublicKeyB64,
    session,
    5000,
    { tlsRejectUnauthorized: false }
  )
  if (connection.status !== 'authenticated') {
    throw new Error(`expected an authenticated session, got close ${connection.close.code}`)
  }
  return connection
}

async function auditEvents(query: string): Promise<unknown[]> {
  const res = await fetch(`${platform.url}/v1/audit/events?${query}`, {
    headers: { authorization: `Bearer ${adminToken}` }
  })
  expect(res.status).toBe(200)
  return (await res.json()).events ?? []
}

async function grant(permissions: string[]): Promise<void> {
  const res = await fetch(`${platform.url}/v1/projects/${projectId}/grants`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ subjectType: 'group', subjectId: 'team-payment', permissions })
  })
  expect(res.status).toBe(200)
}

beforeAll(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-u66-dl-')))
  projectRoot = join(base, 'payment-service')
  initRepo(projectRoot)
  writeFileSync(join(projectRoot, 'big.bin'), Buffer.alloc(BIG_SIZE, 7))
  writeFileSync(join(projectRoot, 'small.bin'), Buffer.alloc(512, 3))
  writeFileSync(join(projectRoot, 'mid.bin'), Buffer.alloc(128 * 1024, 5))

  const dataDir = mkdtempSync(join(tmpdir(), 'orca-u66-dl-data-'))
  installFakeAppEnvironment({ getPath: () => dataDir })
  const store = createSqliteTestStore(Store, { dataFile: join(dataDir, 'orca-data.json') })
  store.addRepo({
    id: 'repo-project',
    path: projectRoot,
    displayName: 'payment-service',
    badgeColor: 'gray',
    addedAt: 1
  })
  store.flushOrThrow()
  service = new OrcaRuntimeService(store)
  service.setNotifier({
    worktreesChanged: vi.fn(),
    reposChanged: vi.fn(),
    activateWorktree: vi.fn(),
    createTerminal: vi.fn(),
    splitTerminal: vi.fn(),
    renameTerminal: vi.fn(),
    focusTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    sleepWorktree: vi.fn(),
    terminalFitOverrideChanged: vi.fn(),
    terminalDriverChanged: vi.fn()
  })

  platform = await startPlatform()
  const login = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'u66-dl-admin' })
  })
  adminToken = readString(await login.json(), 'accessToken') ?? ''
  expect(adminToken).not.toBe('')

  const tokenRes = await fetch(`${platform.url}/v1/hosts/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}` }
  })
  const hostToken = readString(await tokenRes.json(), 'token')
  expect(hostToken).not.toBeNull()

  admission = startCloudRuntimeAdmission(
    {
      ORCA_CLOUD_API_URL: platform.url,
      ORCA_CLOUD_HOST_TOKEN: hostToken ?? '',
      ORCA_CLOUD_HOST_NAME: 'dev-u66-dl',
      ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1'
    },
    { userDataPath: mkdtempSync(join(tmpdir(), 'orca-u66-dl-host-')) }
  )
  expect(admission).not.toBeNull()
  await admission!.ready

  cloud = await startCloudRuntime({
    admission: admission!.admission,
    connectionGate: admission!.connectionGate,
    userDataPrefix: 'orca-u66-dl-rt-',
    service,
    tls: makeSelfSignedTls('dev-u66-dl')
  })
  admission!.bindRuntime(cloud.runtime)
  // The production guard installer: the download-read enforcement reads the same
  // policy snapshot the L1 export refusals read.
  installCloudAccessGuard(cloud.runtime, admission!.client!)
  cloud.runtime.setCloudHostAudit?.((event) => admission!.client!.reportAudit(event))
  cloud.runtime.setCloudFileEventAudit?.(admission!.client!.fileEvents.audit)
  await admission!.client!.refresh()

  const create = await fetch(`${platform.url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      key: PROJECT_KEY,
      name: PROJECT_KEY,
      hostId: admission!.host()!.hostId,
      path: projectRoot
    })
  })
  expect(create.status).toBe(201)
  projectId = readString(await create.json(), 'id') ?? ''
  await grant(['open', 'file:read'])
}, 120_000)

afterAll(async () => {
  admission?.client?.stop()
  await cloud?.runtime.stop()
  await platform?.stop()
  await closeTestStores()
})

describe('U66 二期：readChunk 重建整文件的宿主硬拦（真实平台 + 真实宿主）', () => {
  it('U66-D1 无 download 位：完成窗口拒绝，单窗口与未完成窗口放行，拒绝落链 host-attested', async () => {
    const session = await connectSession('u66-dl-perm')
    try {
      // The declared residual gap: whole file inside one window.
      expect((await readChunk(session, 'small.bin', 0)).ok).toBe(true)
      // Rebuild prefix windows pass; the completing window is refused.
      expect((await readChunk(session, 'big.bin', 0)).ok).toBe(true)
      expect((await readChunk(session, 'big.bin', 1024)).ok).toBe(true)
      expect((await readChunk(session, 'big.bin', 2048)).ok).toBe(true)
      const completing = await readChunk(session, 'big.bin', 3072)
      expect(completing.ok).toBe(false)
      if (!completing.ok) {
        expect(completing.code).toBe('forbidden')
        expect(completing.message).toContain("'download'")
      }
      // The mid-file window after a refusal still serves (a prefix is not the file).
      expect((await readChunk(session, 'big.bin', 2048)).ok).toBe(true)

      await admission!.client!.refresh()
      await admission!.client!.refresh()

      const denials = (await auditEvents('eventType=file_download&result=denied&limit=50')).filter(
        (event) => readString(readField(event, 'metadata'), 'method') === 'files.readChunk'
      )
      expect(denials).toHaveLength(1)
      const denial = denials[0]
      expect(readString(readField(denial, 'metadata'), 'denial')).toBe('PERMISSION_MISSING')
      expect(readString(readField(denial, 'metadata'), 'captureConfidence')).toBe('host-attested')
      expect(readString(readField(denial, 'metadata'), 'fileName')).toBe('big.bin')
      expect(readNumber(readField(denial, 'metadata'), 'sizeBytes')).toBe(BIG_SIZE)
      expect(readString(denial, 'actor')).toBe('zhangsan')

      saveEvidence('u66-D1-permission-denied.json', { completing, denial })
    } finally {
      session.ws.close()
    }
  }, 60_000)

  it('U70-D 无 download 位：单窗 64KB 放行，64KB+1 拒绝并落 host-attested denied', async () => {
    const session = await connectSession('u70-window-cap')
    try {
      const atCap = await readChunk(session, 'mid.bin', 0, 64 * 1024)
      expect(atCap.ok, JSON.stringify(atCap)).toBe(true)
      const oversized = await readChunk(session, 'mid.bin', 0, 64 * 1024 + 1)
      expect(oversized.ok).toBe(false)
      if (!oversized.ok) {
        expect(oversized.code).toBe('forbidden')
        expect(oversized.message).toContain('64 KB')
        expect(oversized.message).toContain("'download'")
      }

      await admission!.client!.refresh()
      await admission!.client!.refresh()

      const denials = (await auditEvents('eventType=file_download&result=denied&limit=200')).filter(
        (event) =>
          readString(readField(event, 'metadata'), 'method') === 'files.readChunk' &&
          readString(readField(event, 'metadata'), 'fileName') === 'mid.bin'
      )
      expect(denials).toHaveLength(1)
      const denial = denials[0]
      expect(readString(readField(denial, 'metadata'), 'denial')).toBe('PERMISSION_MISSING')
      expect(readString(readField(denial, 'metadata'), 'captureConfidence')).toBe('host-attested')
      expect(readNumber(readField(denial, 'metadata'), 'sizeBytes')).toBe(128 * 1024)

      saveEvidence('u70-window-cap-denied.json', { oversized, denial })
    } finally {
      session.ws.close()
    }
  }, 60_000)

  it('U66-D2 票据带 download 但策略 deny：同一硬拦，理由为 DOWNLOAD_DISABLED', async () => {
    await grant(['open', 'file:read', 'download'])
    const session = await connectSession('u66-dl-policy')
    try {
      expect((await readChunk(session, 'big.bin', 0)).ok).toBe(true)
      expect((await readChunk(session, 'big.bin', 1024)).ok).toBe(true)
      expect((await readChunk(session, 'big.bin', 2048)).ok).toBe(true)
      const completing = await readChunk(session, 'big.bin', 3072)
      expect(completing.ok).toBe(false)
      if (!completing.ok) {
        expect(completing.message).toContain('disabled for this project by platform policy')
      }

      await admission!.client!.refresh()
      await admission!.client!.refresh()

      const denials = (await auditEvents('eventType=file_download&result=denied&limit=50')).filter(
        (event) =>
          readString(readField(event, 'metadata'), 'method') === 'files.readChunk' &&
          readString(readField(event, 'metadata'), 'denial') === 'DOWNLOAD_DISABLED'
      )
      expect(denials).toHaveLength(1)
      const denial = denials[0]
      expect(readString(readField(denial, 'metadata'), 'policy')).toBe('deny')
      expect(readString(readField(denial, 'metadata'), 'captureConfidence')).toBe('host-attested')

      saveEvidence('u66-D2-policy-denied.json', { completing, denial })
    } finally {
      session.ws.close()
    }
  }, 60_000)

  it('U66-D3 策略 allow 时同一重建完整放行，不产生拒绝事件', async () => {
    const policyRes = await fetch(`${platform.url}/v1/projects/${projectId}/policy`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ downloadPolicy: 'allow' })
    })
    expect(policyRes.status).toBe(200)
    // The host reads policy from its heartbeat snapshot: beat the new pack down
    // before the session connects.
    await admission!.client!.refresh()
    const session = await connectSession('u66-dl-allow')
    try {
      const denialsBefore = (
        await auditEvents('eventType=file_download&result=denied&limit=200')
      ).filter((event) => readString(readField(event, 'metadata'), 'method') === 'files.readChunk')
      for (const offset of [0, 1024, 2048, 3072]) {
        const reply = await readChunk(session, 'big.bin', offset)
        expect(reply.ok, JSON.stringify(reply)).toBe(true)
        if (reply.ok) {
          expect(readField(reply.result, 'eof')).toBe(offset + WINDOW >= BIG_SIZE)
        }
      }
      // U70: sessions that may download keep the original 512KB window limit.
      const wide = await readChunk(session, 'mid.bin', 0, 64 * 1024 + 1)
      expect(wide.ok, JSON.stringify(wide)).toBe(true)
      await admission!.client!.refresh()
      const denialsAfter = (
        await auditEvents('eventType=file_download&result=denied&limit=200')
      ).filter((event) => readString(readField(event, 'metadata'), 'method') === 'files.readChunk')
      expect(denialsAfter).toHaveLength(denialsBefore.length)
    } finally {
      session.ws.close()
    }
  }, 60_000)
})
