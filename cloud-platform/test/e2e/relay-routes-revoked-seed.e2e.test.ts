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

async function routesFromSnapshot(seed: (store: Store) => void): Promise<RelayRoute[]> {
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
    const res = await fetch(`${url}/v1/internal/relay-routes`, {
      headers: { 'x-internal-token': INTERNAL_TOKEN }
    })
    assert.equal(res.status, 200)
    return ((await res.json()) as { routes: RelayRoute[] }).routes
  } finally {
    await app.close()
    if (previous === undefined) delete process.env.ORCA_PLATFORM_STORE_FILE
    else process.env.ORCA_PLATFORM_STORE_FILE = previous
    rmSync(dir, { recursive: true, force: true })
  }
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
})
