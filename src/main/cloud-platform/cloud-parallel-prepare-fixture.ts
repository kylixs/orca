import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from 'vitest'
import type { CloudProjectRegistration } from '../../shared/cloud-platform-ipc'
import { CLOUD_PLATFORM_IPC } from '../../shared/cloud-platform-ipc'
import { readString } from '../../shared/json-fields'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { Store } from '../persistence/loading-store/store'
import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { ALL_RPC_METHODS } from '../runtime/rpc/methods'
import { MANAGED_WORKTREE_METHODS } from '../runtime/rpc/methods/worktree-create-managed'
import { PROJECT_PROVISION_METHODS } from '../runtime/rpc/methods/project-provision'
import {
  startCloudRuntimeAdmission,
  type CloudRuntimeAdmission
} from '../startup/cloud-runtime-admission'
import { registerCloudPlatformHandlers } from '../ipc/cloud-platform'
import { CloudSessionService } from './cloud-session-service'
import { createCloudProvisionAssignmentExecutor } from './cloud-provision-assignment'
import { setActiveCloudSession } from './cloud-runtime-session'
import {
  REPO_ROOT,
  makeSelfSignedTls,
  startCloudRuntime,
  startPlatform,
  type CloudRuntime,
  type Platform
} from './cloud-session-e2e-harness'
import { parseCloudProjectRegistration } from './cloud-provision-recovery-fixture'
import {
  startLocalGitDaemon,
  type LocalGitDaemon
} from './cloud-project-provisioning-fixture'

/** Real platform + enrolled host + TLS runtime for the M64 parallel-prepare suite. */

export const PARALLEL_EVIDENCE_DIR = join(
  REPO_ROOT,
  'cloud-platform',
  'evidence',
  'm64-parallel-prepare'
)

const PERMISSIONS = ['open', 'terminal', 'agent', 'file:read', 'file:write']

type IpcHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>

export type ParallelPrepareProject = {
  projectId: string
  key: string
  name: string
  root: string
  /** The README the host checkout must contain; null when the clone must fail. */
  readme: string | null
}

export type ParallelPrepareHarness = {
  projects: ParallelPrepareProject[]
  session: CloudSessionService
  registrationUserData: string
  /** Beats until each project's kick clone reports ready or failed (U37/U44). */
  beatUntilSettled: () => Promise<void>
  registerProjects: () => Promise<CloudProjectRegistration>
  saveEvidence: (file: string, content: unknown) => void
  stop: () => Promise<void>
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function makeBareRepo(base: string, name: string, readme: string): string {
  const work = join(base, `${name}-work`)
  mkdirSync(work, { recursive: true })
  git(work, 'init', '-q', '-b', 'main')
  git(work, 'config', 'user.email', 'e2e@example.com')
  git(work, 'config', 'user.name', 'e2e')
  writeFileSync(join(work, 'README.md'), readme)
  git(work, 'add', '.')
  git(work, 'commit', '-qm', 'init')
  const bare = join(base, `${name}.git`)
  git(base, 'init', '-q', '--bare', bare)
  git(work, 'remote', 'add', 'origin', bare)
  git(work, 'push', '-q', 'origin', 'main')
  return bare
}

function requireHandler(handlers: ReadonlyMap<string, IpcHandler>, channel: string): IpcHandler {
  const handler = handlers.get(channel)
  if (!handler) {
    throw new Error(`${channel} handler not registered`)
  }
  return handler
}

async function loginToken(platform: Platform, username: string, password: string): Promise<string> {
  const res = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, deviceName: 'm64-parallel' })
  })
  const token = readString(await res.json(), 'accessToken')
  if (!token) {
    throw new Error(`login ${username} failed`)
  }
  return token
}

export async function startParallelPrepareHarness(
  ipcHandlers: ReadonlyMap<string, IpcHandler>,
  prepareConcurrency: number
): Promise<ParallelPrepareHarness> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-m64-parallel-')))
  const registrationUserData = mkdtempSync(join(tmpdir(), 'orca-m64-parallel-user-'))
  makeBareRepo(base, 'alpha-service', '# alpha-service\n')
  makeBareRepo(base, 'gamma-service', '# gamma-service\n')
  const daemon: LocalGitDaemon = await startLocalGitDaemon(base)

  const dataDir = mkdtempSync(join(tmpdir(), 'orca-m64-parallel-data-'))
  installFakeAppEnvironment({ getPath: () => dataDir })
  const store = createSqliteTestStore(Store, { dataFile: join(dataDir, 'orca-data.json') })
  store.updateSettings({ workspaceDir: join(base, 'host-workspaces') })
  store.flushOrThrow()
  const service = new OrcaRuntimeService(store)

  const platform: Platform = await startPlatform()
  const adminToken = await loginToken(platform, 'admin', 'Adm1n!')
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
      ORCA_CLOUD_HOST_NAME: 'dev-m64-parallel',
      ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1'
    },
    { userDataPath: mkdtempSync(join(tmpdir(), 'orca-m64-parallel-host-')) }
  )
  if (!started) {
    throw new Error('cloud admission not enabled')
  }
  const admission: CloudRuntimeAdmission = started
  await admission.ready

  const cloud: CloudRuntime = await startCloudRuntime({
    admission: admission.admission,
    connectionGate: admission.connectionGate,
    userDataPrefix: 'orca-m64-parallel-',
    service,
    tls: makeSelfSignedTls('dev-m64-parallel'),
    methods: [...ALL_RPC_METHODS, ...MANAGED_WORKTREE_METHODS, ...PROJECT_PROVISION_METHODS]
  })
  admission.bindRuntime(cloud.runtime)
  cloud.runtime.setCloudProvisionReporter((report) => admission.client!.reportProvisioned(report))
  // U37: the heartbeat assignment is what clones a repo-ful project before any ticket.
  admission.client!.onProvisionAssignment(
    createCloudProvisionAssignmentExecutor({
      provision: cloud.runtime.provisionCloudProject.bind(cloud.runtime),
      report: (report) => admission.client!.reportProvisioned(report),
      inMaintenance: () => admission.client!.snapshot().maintenance !== null
    })
  )
  await admission.client!.refresh()

  const adminFetch = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${platform.url}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${adminToken}`,
        ...init.headers
      }
    })

  const definitions = [
    {
      key: 'm64-alpha',
      name: 'Alpha Service',
      root: join(base, 'projects', 'alpha-service'),
      repoUrl: daemon.urlFor('alpha-service.git'),
      readme: '# alpha-service\n'
    },
    {
      key: 'm64-broken',
      name: 'Broken Service',
      root: join(base, 'projects', 'broken-service'),
      repoUrl: daemon.urlFor('missing-source.git'),
      readme: null
    },
    {
      key: 'm64-gamma',
      name: 'Gamma Service',
      root: join(base, 'projects', 'gamma-service'),
      repoUrl: daemon.urlFor('gamma-service.git'),
      readme: '# gamma-service\n'
    }
  ]
  const projects: ParallelPrepareProject[] = []
  for (const definition of definitions) {
    const created = await adminFetch('/v1/projects', {
      method: 'POST',
      body: JSON.stringify({
        key: definition.key,
        name: definition.name,
        hostId: admission.host()!.hostId,
        path: definition.root,
        repoUrl: definition.repoUrl,
        defaultBranch: 'main'
      })
    })
    expect(created.status, await created.clone().text()).toBe(201)
    const projectId = readString(await created.json(), 'id') ?? ''
    const granted = await adminFetch(`/v1/projects/${projectId}/grants`, {
      method: 'PUT',
      body: JSON.stringify({
        subjectType: 'group',
        subjectId: 'team-payment',
        permissions: PERMISSIONS
      })
    })
    expect(granted.status, await granted.clone().text()).toBe(200)
    projects.push({
      projectId,
      key: definition.key,
      name: definition.name,
      root: definition.root,
      readme: definition.readme
    })
  }
  // Why: hide the seeded payment project so this suite sees exactly three projects.
  const unseeded = await adminFetch('/v1/projects/proj_payment/grants', {
    method: 'PUT',
    body: JSON.stringify({ subjectType: 'group', subjectId: 'team-payment', permissions: [] })
  })
  expect(unseeded.status).toBe(200)

  const session = new CloudSessionService({ apiUrl: platform.url, tlsRejectUnauthorized: false })
  await session.login('zhangsan', 'Passw0rd!')
  setActiveCloudSession(session)
  const handlers = registerCloudPlatformHandlers(session, {
    broadcast: () => undefined,
    userDataPath: registrationUserData,
    prepareConcurrency
  })

  return {
    projects,
    session,
    registrationUserData,
    beatUntilSettled: async () => {
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline) {
        await admission.client!.refresh()
        await new Promise((resolve) => setTimeout(resolve, 50))
        await admission.client!.refresh()
        const statuses = await Promise.all(
          projects.map(async (project) => {
            const res = await adminFetch(`/v1/projects/${project.projectId}`)
            return readString(await res.json(), 'status')
          })
        )
        if (statuses.every((status) => status === 'ready' || status === 'failed')) {
          return
        }
      }
      throw new Error('projects never settled after the kick report')
    },
    registerProjects: async () =>
      parseCloudProjectRegistration(
        await requireHandler(ipcHandlers, CLOUD_PLATFORM_IPC.registerProjects)(null)
      ),
    saveEvidence: (file, content) => {
      mkdirSync(PARALLEL_EVIDENCE_DIR, { recursive: true })
      writeFileSync(join(PARALLEL_EVIDENCE_DIR, file), JSON.stringify(content, null, 2))
    },
    stop: async () => {
      handlers.dispose()
      setActiveCloudSession(null)
      admission.client?.stop()
      await cloud.runtime.stop()
      await platform.stop()
      await daemon.stop()
      await closeTestStores()
    }
  }
}
