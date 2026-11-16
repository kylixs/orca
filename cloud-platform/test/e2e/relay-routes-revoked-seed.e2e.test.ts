import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../../apps/api/src/server.ts'
import { Store, type Host, type RelayRoute } from '../../apps/api/src/store.ts'
import { serializeSnapshot } from '../../apps/api/src/store-persistence.ts'

/**
 * U140: the boot seed used to resurrect dev-001's relay route unconditionally,
 * including after that host was revoked and after a stale snapshot was restored.
 * The internal relay-routes view then advertised a revoked host at 127.0.0.1.
 */

const INTERNAL_TOKEN = 'u140-relay-routes-token'

function host(overrides: Partial<Host> = {}): Host {
  return {
    id: 'host_dev001',
    name: 'dev-001',
    fingerprint: 'sha256:u140',
    tlsFingerprint: null,
    e2eePublicKey: 'u140-e2ee',
    orcaVersion: '1.5.0',
    protocolVersion: 3,
    zone: 'intranet',
    directAddrs: ['127.0.0.1:16768'],
    relayRoute: 'dev-001',
    capabilities: ['pty'],
    projectsRoot: null,
    projectDirs: [],
    status: 'offline',
    maintenanceReason: null,
    lastHeartbeatAt: 1,
    credentialHash: null,
    revokedAt: null,
    ...overrides
  }
}

function route(target: string, hostId = 'host_dev001', routeKey = 'dev-001'): RelayRoute {
  return { routeKey, hostId, target, version: 1 }
}

async function withSnapshot<T>(
  seed: (store: Store) => void,
  run: (url: string) => Promise<T>
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'u140-relay-routes-'))
  const file = join(dir, 'store.json')
  const store = new Store()
  seed(store)
  writeFileSync(file, serializeSnapshot(store))

  const previous = process.env.ORCA_PLATFORM_STORE_FILE
  process.env.ORCA_PLATFORM_STORE_FILE = file
  const app = createApp({ port: 0, internalToken: INTERNAL_TOKEN })
  try {
    const url = `http://127.0.0.1:${await app.listen()}`
    return await run(url)
  } finally {
    await app.close()
    if (previous === undefined) delete process.env.ORCA_PLATFORM_STORE_FILE
    else process.env.ORCA_PLATFORM_STORE_FILE = previous
    rmSync(dir, { recursive: true, force: true })
  }
}

async function routesFromSnapshot(seed: (store: Store) => void): Promise<RelayRoute[]> {
  return withSnapshot(seed, async (url) => {
    const res = await fetch(`${url}/v1/internal/relay-routes`, {
      headers: { 'x-internal-token': INTERNAL_TOKEN }
    })
    assert.equal(res.status, 200)
    return ((await res.json()) as { routes: RelayRoute[] }).routes
  })
}

describe('U140 revoked hosts never keep a relay route', () => {
  test('a revoked snapshot host gets no seed route on boot', async () => {
    const routes = await routesFromSnapshot((store) => {
      store.hosts.set('host_dev001', host({ revokedAt: 1 }))
    })
    assert.deepEqual(
      routes.map((r) => r.routeKey),
      [],
      'the boot seed must not add a route for a revoked host'
    )
  })

  test('a stale route for a revoked host is swept on boot', async () => {
    const routes = await routesFromSnapshot((store) => {
      store.hosts.set('host_dev001', host({ revokedAt: 1 }))
      store.relayRoutes.set('dev-001', route('127.0.0.1:16768'))
    })
    assert.deepEqual(
      routes.map((r) => r.routeKey),
      [],
      'a historical snapshot route for a revoked host must be removed'
    )
  })

  test('a live host keeps its route and target', async () => {
    const routes = await routesFromSnapshot((store) => {
      store.hosts.set('host_dev001', host())
      store.relayRoutes.set('dev-001', route('100.103.213.12:41001'))
    })
    assert.deepEqual(routes, [route('100.103.213.12:41001')])
  })

  // U143: the sweep used to keep a route whose hostId is absent from store.hosts,
  // so an orphan route advertised a machine the platform no longer knows.
  test('boot keeps only the live host route across revoked and orphan entries', async () => {
    const routes = await routesFromSnapshot((store) => {
      store.hosts.set('host_dev001', host({ revokedAt: 1 }))
      store.hosts.set(
        'host_revoked_b',
        host({ id: 'host_revoked_b', name: 'revoked-b', relayRoute: 'revoked-b', revokedAt: 1 })
      )
      store.hosts.set(
        'host_live',
        host({
          id: 'host_live',
          name: 'live',
          relayRoute: 'live',
          directAddrs: ['10.0.0.9:41001'],
          status: 'online'
        })
      )
      store.relayRoutes.set('dev-001', route('127.0.0.1:16768'))
      store.relayRoutes.set('revoked-b', route('10.0.0.8:41001', 'host_revoked_b', 'revoked-b'))
      store.relayRoutes.set('live', route('10.0.0.9:41001', 'host_live', 'live'))
      store.relayRoutes.set('orphan', route('10.0.0.7:41001', 'host_missing', 'orphan'))
    })
    assert.deepEqual(routes, [route('10.0.0.9:41001', 'host_live', 'live')])
  })
})

describe('U143 revoked hosts cannot re-register', () => {
  async function adminToken(url: string): Promise<string> {
    const res = await fetch(`${url}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'admin',
        password: 'Adm1n!',
        devicePubKey: Buffer.from('u143-admin-key').toString('base64'),
        deviceName: 'u143-admin'
      })
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as { accessToken: string }
    return body.accessToken
  }

  test('a revoked name is refused, stays offline, gains no route, and is audited', async () => {
    await withSnapshot(
      (store) => {
        store.hosts.set(
          'host_revoked',
          host({
            id: 'host_revoked',
            name: 'u143-revoked',
            relayRoute: 'u143-revoked',
            revokedAt: 1
          })
        )
      },
      async (url) => {
        const token = await adminToken(url)
        const mint = await fetch(`${url}/v1/hosts/tokens`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` }
        })
        assert.equal(mint.status, 201)
        const { token: hostToken } = (await mint.json()) as { token: string }

        const register = await fetch(`${url}/v1/hosts/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${hostToken}` },
          body: JSON.stringify({
            name: 'u143-revoked',
            fingerprint: 'sha256:u143-revoked',
            e2eePublicKeyB64: 'u143-e2ee',
            orcaVersion: '1.5.0',
            protocolVersion: 3,
            networkZone: 'intranet',
            directAddrs: ['10.0.0.7:41001'],
            relayRoute: 'u143-revoked',
            relayTarget: '10.0.0.7:41001',
            runtimeCapabilities: ['pty']
          })
        })
        assert.equal(register.status, 409)
        const registerBody = (await register.json()) as { error?: { code: string } }
        assert.equal(registerBody.error?.code, 'HOST_REVOKED')

        const routesRes = await fetch(`${url}/v1/internal/relay-routes`, {
          headers: { 'x-internal-token': INTERNAL_TOKEN }
        })
        const routes = ((await routesRes.json()) as { routes: RelayRoute[] }).routes
        assert.equal(
          routes.some((entry) => entry.hostId === 'host_revoked'),
          false,
          'a refused registration must not create a relay route'
        )

        const hostsRes = await fetch(`${url}/v1/hosts`, {
          headers: { authorization: `Bearer ${token}` }
        })
        const rows = (
          (await hostsRes.json()) as { hosts: { id: string; status: string; revokedAt: number }[] }
        ).hosts
        const row = rows.find((entry) => entry.id === 'host_revoked')
        assert.ok(row)
        assert.equal(row.status, 'offline')
        assert.equal(row.revokedAt, 1)

        const auditRes = await fetch(
          `${url}/v1/audit/events?eventType=host_register&result=denied&limit=50`,
          { headers: { authorization: `Bearer ${token}` } }
        )
        const audit = (await auditRes.json()) as {
          events: { targetId: string | null; result: string }[]
        }
        assert.ok(
          audit.events.some(
            (event) => event.targetId === 'host_revoked' && event.result === 'denied'
          ),
          'the refusal must land in the audit chain'
        )
      }
    )
  })
})
