import { execFileSync } from 'node:child_process'
import { connect, createServer } from 'node:tls'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { errorCodeOf, readArray, readString } from '../../shared/json-fields'
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
import { upgradeCloudSocket } from './cloud-socket-handshake'
import { tlsCertificateFingerprint } from './cloud-host-tls'

/**
 * M109 (design §5.3): the platform publishes the TLS certificate a host serves,
 * so a client must refuse a host whose live certificate does not match — a
 * stand-in for a machine-in-the-middle. With self-signed hosts verification is
 * off and Node skips `checkServerIdentity`, so this comparison is the protection.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm109-host-tls-pinning')

function saveEvidence(file: string, content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, file), JSON.stringify(content, null, 2))
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

/** A TLS endpoint that terminates with its own certificate and forwards raw bytes. */
async function startMitmTlsProxy(input: {
  targetPort: number
  cert: string
  key: string
}): Promise<{ port: number; connections: () => number; close: () => Promise<void> }> {
  let count = 0
  const server = createServer({ cert: input.cert, key: input.key }, (caller) => {
    count += 1
    const upstream = connect({
      host: '127.0.0.1',
      port: input.targetPort,
      rejectUnauthorized: false
    })
    caller.pipe(upstream).pipe(caller)
    const drop = (): void => {
      caller.destroy()
      upstream.destroy()
    }
    caller.on('error', drop)
    upstream.on('error', drop)
    caller.on('close', () => upstream.destroy())
    upstream.on('close', () => caller.destroy())
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    port,
    connections: () => count,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
  }
}

type Stack = {
  platform: Platform
  cloud: CloudRuntime
  admission: CloudRuntimeAdmission
  client: CloudConnectClient
  projectId: string
  runtimePort: number
  hostFingerprint: string
}

let stack: Stack

beforeAll(async () => {
  const dir = realpathSync(mkdtempSync('/tmp/orca-m109-'))
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
    id: 'repo-m109',
    path: projectRoot,
    displayName: 'p',
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
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'm109-admin' })
  })
  const adminToken = readString(await adminLogin.json(), 'accessToken')
  if (adminToken === null) {
    throw new Error('admin login failed')
  }
  const hostTokenRes = await fetch(`${platform.url}/v1/hosts/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}` }
  })
  const hostToken = readString(await hostTokenRes.json(), 'token')
  if (hostToken === null) {
    throw new Error('host token missing')
  }

  // The same certificate the runtime will serve, announced to the platform by path.
  const tls = makeSelfSignedTls('dev-m109')
  const certPath = join(dir, 'host.crt')
  const keyPath = join(dir, 'host.key')
  writeFileSync(certPath, tls.cert)
  writeFileSync(keyPath, tls.key)
  const admission = startCloudRuntimeAdmission(
    {
      ORCA_CLOUD_API_URL: platform.url,
      ORCA_CLOUD_HOST_TOKEN: hostToken,
      ORCA_CLOUD_HOST_NAME: 'dev-m109',
      ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1',
      ORCA_CLOUD_TLS_CERT_PATH: certPath,
      ORCA_CLOUD_TLS_KEY_PATH: keyPath
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
    userDataPrefix: 'orca-m109-',
    service,
    tls,
    methods: [...ALL_RPC_METHODS, ...MANAGED_WORKTREE_METHODS]
  })
  admission.bindRuntime(cloud.runtime)
  await admission.client!.refresh()

  const create = await fetch(`${platform.url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      key: 'm109-tls-pinning',
      name: 'm109-tls-pinning',
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
      permissions: ['open', 'terminal', 'file:read']
    })
  })
  expect(grant.status).toBe(200)

  const client = new CloudConnectClient({ apiUrl: platform.url, tlsRejectUnauthorized: false })
  await client.login('zhangsan', 'Passw0rd!')
  stack = {
    platform,
    cloud,
    admission,
    client,
    projectId,
    runtimePort: Number(new URL(cloud.endpoint).port),
    hostFingerprint: tlsCertificateFingerprint(tls.cert)
  }
}, 180_000)

afterAll(async () => {
  stack?.client.close()
  stack?.admission.client?.stop()
  await stack?.cloud.runtime.stop()
  await stack?.platform.stop()
})

describe('客户端按平台发布的 TLS 指纹校验宿主证书（真实平台 + 真实 TLS Runtime + MITM）', () => {
  it('M109-1 真证书可连、换证书被拒、无指纹时不校验（旧平台兼容）', async () => {
    // The host published the certificate it is actually serving.
    const hostsBody: unknown = await (
      await fetch(`${stack.platform.url}/v1/hosts`, {
        headers: { authorization: `Bearer ${await adminToken()}` }
      })
    ).json()
    const published = (readArray(hostsBody, 'hosts') ?? []).map((host) =>
      readString(host, 'tlsFingerprint')
    )
    expect(published).toContain(stack.hostFingerprint)

    // Positive: the real endpoint, real ticket, pinning active — opens and works.
    const ensured = await ensureCloudWorkspace(stack.client, stack.projectId)
    expect(ensured.ok, JSON.stringify(ensured)).toBe(true)
    expect(ensured.ok ? ensured.route : '').toBe('direct')

    // Negative control: a TLS endpoint terminating with a different certificate.
    // A fresh ticket per attempt: the host marks a ticket's id used on first
    // upgrade, so replaying one would fail before the pin check could.
    const mitm = await makeDifferentCertMitm()
    try {
      const refusedTicket = await stack.client.prepareProjectLink(stack.projectId)
      const refused = await upgradeCloudSocket({
        endpoint: { url: `wss://127.0.0.1:${mitm.port}`, priority: 1 },
        ticket: refusedTicket.ticket,
        devicePubKeyB64: stack.client.devicePubKeyB64,
        deviceKeys: stack.client.deviceKeyPair(),
        tlsRejectUnauthorized: false,
        expectedTlsFingerprint: stack.hostFingerprint,
        onClose: () => undefined
      }).then(
        (socket) => {
          socket.close()
          return 'opened'
        },
        (error: unknown) => errorCodeOf(error) ?? 'unknown'
      )
      expect(refused).toBe('TLS_FINGERPRINT_MISMATCH')
      // The refusal happened at the client; the fake endpoint saw the attempt.
      expect(mitm.connections()).toBeGreaterThanOrEqual(1)

      // Compatibility: the same fake endpoint with no published fingerprint is not
      // refused, which is exactly what an older platform's client experienced.
      const legacyTicket = await stack.client.prepareProjectLink(stack.projectId)
      const legacy = await upgradeCloudSocket({
        endpoint: { url: `wss://127.0.0.1:${mitm.port}`, priority: 1 },
        ticket: legacyTicket.ticket,
        devicePubKeyB64: stack.client.devicePubKeyB64,
        deviceKeys: stack.client.deviceKeyPair(),
        tlsRejectUnauthorized: false,
        onClose: () => undefined
      }).then(
        (socket) => {
          socket.close()
          return 'opened'
        },
        (error: unknown) => errorCodeOf(error) ?? 'unknown'
      )
      expect(legacy).toBe('opened')
    } finally {
      await mitm.close()
    }

    saveEvidence('host-tls-pinning.json', {
      publishedFingerprint: stack.hostFingerprint,
      realEndpointRoute: ensured.ok ? ensured.route : null,
      mitmResult: 'TLS_FINGERPRINT_MISMATCH',
      legacyWithoutPin: 'opened',
      note: 'MITM terminated TLS with a different self-signed certificate and forwarded to the real runtime; the client refused before the E2EE hello.'
    })
  }, 120_000)
})

async function adminToken(): Promise<string> {
  const res = await fetch(`${stack.platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'm109-check' })
  })
  return readString(await res.json(), 'accessToken') ?? ''
}

function makeDifferentCertMitm(): ReturnType<typeof startMitmTlsProxy> {
  const dir = mkdtempSync('/tmp/orca-m109-mitm-')
  const keyPath = join(dir, 'mitm.key')
  const certPath = join(dir, 'mitm.crt')
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '1',
    '-subj',
    '/CN=not-the-host',
    '-addext',
    'subjectAltName=IP:127.0.0.1,DNS:localhost'
  ])
  return startMitmTlsProxy({
    targetPort: stack.runtimePort,
    cert: readFileSync(certPath, 'utf8'),
    key: readFileSync(keyPath, 'utf8')
  })
}
