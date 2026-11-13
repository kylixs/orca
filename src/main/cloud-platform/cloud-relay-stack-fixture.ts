import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readField, readString } from '../../shared/json-fields'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { Store } from '../persistence/loading-store/store'
import { createSqliteTestStore } from '../persistence-test-harness'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { ALL_RPC_METHODS } from '../runtime/rpc/methods'
import { MANAGED_WORKTREE_METHODS } from '../runtime/rpc/methods/worktree-create-managed'
import {
  DEFAULT_INTERNAL_TOKEN,
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
import {
  installRealPtyController,
  startRelayProcess,
  type RelayProcess
} from './cloud-terminal-e2e-fixture'
import { startLatencyHop, type LatencyHop } from './cloud-latency-hop-fixture'
import { ensureCloudWorkspace } from './cloud-workspace-ensure'

/**
 * A relay-only stack: real platform process, real host enrolment, real TLS
 * runtime, real relay child process, and a delay-hop in front of the runtime.
 * No advertised direct address, so every session takes the slowest supported
 * line — which is what the latency budgets are about.
 */

export type RelayStack = {
  dir: string
  projectRoot: string
  platform: Platform
  cloud: CloudRuntime
  admission: CloudRuntimeAdmission
  relay: RelayProcess | null
  hop: LatencyHop
  client: CloudConnectClient
  projectId: string
  workspacePath: string
  route: 'direct' | 'relay'
}

export type RelayStackOptions = {
  name: string
  /** Directory created inside the project; the caller fills it. */
  contentDir?: string
  realPty?: boolean
  permissions?: string[]
  /**
   * Advertise a direct address (through the delay hop) instead of relying on the
   * relay. The host must stay reachable without the relay for this to work.
   */
  directOnly?: boolean
}

export async function startRelayStack(options: RelayStackOptions): Promise<RelayStack> {
  const { name } = options
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `orca-${name}-`)))
  installFakeAppEnvironment({ getPath: () => dir })
  const store = createSqliteTestStore(Store, { dataFile: join(dir, 'orca-data.json') })
  const projectRoot = join(dir, 'payment-service')
  mkdirSync(projectRoot, { recursive: true })
  git(projectRoot, 'init', '-q', '-b', 'main')
  git(projectRoot, 'config', 'user.email', 'e2e@example.com')
  git(projectRoot, 'config', 'user.name', 'e2e')
  writeFileSync(join(projectRoot, 'README.md'), 'hello\n')
  if (options.contentDir) {
    mkdirSync(join(projectRoot, options.contentDir), { recursive: true })
  }
  git(projectRoot, 'add', '.')
  git(projectRoot, 'commit', '-qm', 'init')
  store.addRepo({
    id: `repo-${name}`,
    path: projectRoot,
    displayName: 'payment-service',
    badgeColor: 'gray',
    addedAt: 1
  })
  store.updateSettings({ workspaceDir: join(dir, 'host-workspaces') })
  store.flushOrThrow()
  const service = new OrcaRuntimeService(store)
  if (options.realPty) {
    installRealPtyController(service)
  }

  const platform = await startPlatform()
  const adminToken = await loginAdmin(platform, `${name}-admin`)
  const hostToken = await takeHostToken(platform, adminToken)

  let runtimePort = 0
  const hop = await startLatencyHop(() => runtimePort)
  const hopAddr = `127.0.0.1:${Number(new URL(hop.url).port)}`
  const admission = startCloudRuntimeAdmission(
    {
      ORCA_CLOUD_API_URL: platform.url,
      ORCA_CLOUD_HOST_TOKEN: hostToken,
      ORCA_CLOUD_HOST_NAME: `dev-${name}`
    },
    {
      userDataPath: join(dir, 'host-data'),
      relayTarget: hopAddr,
      // Why: the direct address also goes through the hop, so the delay control
      // moves both routes and the host never advertises its real port.
      ...(options.directOnly ? { directAddrs: [hopAddr] } : {})
    }
  )
  if (!admission) {
    throw new Error('cloud admission not enabled')
  }
  await admission.ready

  const cloud = await startCloudRuntime({
    admission: admission.admission,
    connectionGate: admission.connectionGate,
    userDataPrefix: `orca-${name}-`,
    service,
    tls: makeSelfSignedTls(`dev-${name}`),
    methods: [...ALL_RPC_METHODS, ...MANAGED_WORKTREE_METHODS]
  })
  admission.bindRuntime(cloud.runtime)
  await admission.client!.refresh()
  runtimePort = Number(new URL(cloud.endpoint).port)

  // A relay would also be a valid fallback; direct-only stacks skip it so the
  // route assertion cannot pass by accident.
  const relay = options.directOnly ? null : await startRelayProcess(platform.url)
  if (relay) {
    await waitForRelayAnnounced(platform, relay)
  }

  const create = await fetch(`${platform.url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      key: `${name}-project`,
      name: `${name}-project`,
      hostId: admission.host()!.hostId,
      path: projectRoot
    })
  })
  expectStatus(create.status, 201, await create.clone().text())
  const projectId = readString(await create.json(), 'id') ?? ''
  const grant = await fetch(`${platform.url}/v1/projects/${projectId}/grants`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      subjectType: 'group',
      subjectId: 'team-payment',
      permissions: options.permissions ?? ['open', 'terminal', 'agent', 'file:read', 'file:write']
    })
  })
  expectStatus(grant.status, 200, await grant.clone().text())

  const client = new CloudConnectClient({ apiUrl: platform.url, tlsRejectUnauthorized: false })
  await client.login('zhangsan', 'Passw0rd!')
  const ensured = await ensureCloudWorkspace(client, projectId)
  if (!ensured.ok) {
    throw new Error(`workspace ensure failed: ${ensured.code} ${ensured.message ?? ''}`)
  }
  return {
    dir,
    projectRoot,
    platform,
    cloud,
    admission,
    relay,
    hop,
    client,
    projectId,
    workspacePath: ensured.workspacePath,
    route: ensured.route
  }
}

export async function stopRelayStack(stack: RelayStack | undefined): Promise<void> {
  stack?.client.close()
  stack?.admission.client?.stop()
  await stack?.cloud.runtime.stop()
  await stack?.relay?.stop()
  await stack?.hop.close()
  await stack?.platform.stop()
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

function expectStatus(actual: number, expected: number, body: string): void {
  if (actual !== expected) {
    throw new Error(`expected HTTP ${expected}, got ${actual}: ${body}`)
  }
}

async function loginAdmin(platform: Platform, deviceName: string): Promise<string> {
  const login = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName })
  })
  const token = readString(await login.json(), 'accessToken')
  if (token === null) {
    throw new Error('admin login failed')
  }
  return token
}

async function takeHostToken(platform: Platform, adminToken: string): Promise<string> {
  const res = await fetch(`${platform.url}/v1/hosts/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}` }
  })
  const token = readString(await res.json(), 'token')
  if (token === null) {
    throw new Error('host token missing')
  }
  return token
}

async function waitForRelayAnnounced(platform: Platform, relay: RelayProcess): Promise<void> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (/routes synced n=\d+/.test(relay.logs())) {
      const view = await fetch(`${platform.url}/v1/internal/relays`, {
        headers: { 'x-internal-token': DEFAULT_INTERNAL_TOKEN }
      })
      const nodes = readField(await view.json(), 'relays')
      if (
        Array.isArray(nodes) &&
        nodes.some(
          (node) => readField(node, 'port') === relay.port && readField(node, 'online') === true
        )
      ) {
        return
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`relay never registered: ${relay.logs()}`)
}
