import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, type ApiHandle } from '../src/server.ts'
import { Store } from '../src/store.ts'
import { serializeSnapshot } from '../src/snapshot-serialize.ts'

/**
 * U277: registration rejects a malformed direct address, but a hand-edited or
 * pre-U265 snapshot can still restore one. `stringDirectAddrs` only drops
 * non-strings, so `sessionPageUrlFor`'s guard is the last line of defence and
 * had no observer. A restored bad port must yield an empty string, not a 500
 * and not a URL a browser cannot dial.
 */

const ORIGIN = 'https://console.u277.example'
const INTERNAL_TOKEN = 'u277-token'
const MALFORMED_ADDR = '127.0.0.1:99999'
const VALID_ADDR = '127.0.0.1:17001'
// U280: `isDirectAddrForm` rejects these, `new URL` accepts them. Only the
// explicit pre-splice guard keeps them out of `sessionPageUrl`; `127.0.0.1:99999`
// cannot show that because the URL parser rejects it too. Port 0 is the one
// form-only port rejection `new URL` still accepts, so it observes the port check.
const GUARD_ONLY_REJECTED_ADDRS = ['console.example/evil', 'user@evil.example', '127.0.0.1:0']

const apps: ApiHandle[] = []
const tempDirs: string[] = []

type Json = Record<string, unknown>
type Entry = [string, Json]

/** Minimal restorable snapshot carrying one TLS host and one project on it. */
function snapshotWithDirectAddr(addr: string): string {
  const snapshot = JSON.parse(serializeSnapshot(new Store())) as {
    hosts: Entry[]
    projects: Entry[]
  }
  const hostId = 'host_u277'
  snapshot.hosts.push([
    hostId,
    {
      id: hostId,
      name: 'u277-host',
      fingerprint: 'sha256:u277host',
      // Present so the empty URL below can only come from the address branch.
      tlsFingerprint: 'sha256:u277tls',
      e2eePublicKey: 'u277',
      orcaVersion: '1.5.0',
      protocolVersion: 3,
      zone: 'intranet',
      directAddrs: [addr],
      relayRoute: null,
      capabilities: [],
      projectsRoot: null,
      projectDirs: [],
      status: 'online',
      maintenanceReason: null,
      lastHeartbeatAt: Date.now(),
      credentialHash: null,
      revokedAt: null
    }
  ])
  const projectId = 'proj_u277'
  snapshot.projects.push([
    projectId,
    {
      id: projectId,
      key: 'u277-project',
      name: 'u277-project',
      repoUrl: 'git@git.example.com:u277/project.git',
      hostId,
      path: '/srv/work/u277',
      defaultBranch: 'main',
      downloadPolicy: 'deny',
      status: 'ready',
      createdAt: Date.now()
    }
  ])
  return JSON.stringify(snapshot)
}

async function startWith(snapshot: string): Promise<{ base: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'orca-u277-'))
  tempDirs.push(dir)
  const file = join(dir, 'store.json')
  writeFileSync(file, snapshot)

  const previous = process.env.ORCA_PLATFORM_STORE_FILE
  process.env.ORCA_PLATFORM_STORE_FILE = file
  let app: ApiHandle
  try {
    app = createApp({
      port: 0,
      accessTtlMs: 60_000,
      refreshTtlMs: 60_000,
      internalToken: INTERNAL_TOKEN,
      cookieMode: 'auto',
      publicOrigin: ORIGIN
    })
  } finally {
    if (previous === undefined) delete process.env.ORCA_PLATFORM_STORE_FILE
    else process.env.ORCA_PLATFORM_STORE_FILE = previous
  }
  apps.push(app)
  const port = await app.listen()
  return { base: `http://127.0.0.1:${port}` }
}

async function loginAsAdmin(base: string): Promise<string> {
  const res = await fetch(`${base}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'u277-admin' })
  })
  assert.equal(res.status, 200, 'admin must log in from the restored snapshot')
  return String(((await res.json()) as Json).accessToken ?? '')
}

async function listedHost(base: string, token: string): Promise<Json> {
  const res = await fetch(`${base}/v1/hosts`, {
    headers: { authorization: `Bearer ${token}` }
  })
  assert.equal(res.status, 200, `GET /v1/hosts must not 500: ${await res.clone().text()}`)
  const body = (await res.json()) as { hosts: Json[] }
  const host = body.hosts.find((entry) => entry.id === 'host_u277')
  assert.ok(host, 'the restored host is listed')
  return host as Json
}

async function listedProject(base: string, token: string): Promise<Json> {
  const res = await fetch(`${base}/v1/projects`, {
    headers: { authorization: `Bearer ${token}` }
  })
  assert.equal(res.status, 200, `GET /v1/projects must not 500: ${await res.clone().text()}`)
  const body = (await res.json()) as { projects: Json[] }
  const project = body.projects.find((entry) => entry.key === 'u277-project')
  assert.ok(project, 'the restored project is listed')
  return project as Json
}

after(async () => {
  await Promise.all(apps.map((app) => app.close()))
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

describe('U277 快照恢复的畸形直连地址', () => {
  test('恢复 127.0.0.1:99999 的快照：列表 200 且 sessionPageUrl 为空串', async () => {
    const { base } = await startWith(snapshotWithDirectAddr(MALFORMED_ADDR))
    const token = await loginAsAdmin(base)

    const host = await listedHost(base, token)
    // The string survived restore — the assertion below therefore observes the
    // URL guard, not string filtering.
    assert.deepEqual(host.directAddrs, [MALFORMED_ADDR])
    assert.equal(host.tlsFingerprint, 'sha256:u277tls', 'TLS is not the reason the URL is empty')

    const project = await listedProject(base, token)
    assert.equal(project.sessionPageUrl, '', 'a bad port yields no session page URL')
    assert.equal(typeof project.sessionPageUrl, 'string', 'empty string, never null')
    assert.equal(project.sessionPageUrl === null, false)
    // Guard the exact failure mode: the malformed splice must not leak through.
    assert.equal(String(project.sessionPageUrl).includes('99999'), false)
  })

  for (const addr of GUARD_ONLY_REJECTED_ADDRS) {
    test(`U280：恢复 ${addr} 的快照：列表 200 且 sessionPageUrl 为空串`, async () => {
      const { base } = await startWith(snapshotWithDirectAddr(addr))
      const token = await loginAsAdmin(base)

      const host = await listedHost(base, token)
      // Both lists must answer 200 and the address must survive restore, so the
      // empty URL below comes from the pre-splice guard, not string filtering.
      assert.deepEqual(host.directAddrs, [addr])
      assert.equal(host.tlsFingerprint, 'sha256:u277tls')

      const project = await listedProject(base, token)
      assert.equal(typeof project.sessionPageUrl, 'string', 'empty string, never null')
      assert.equal(project.sessionPageUrl, '', `${addr} yields no session page URL`)
    })
  }

  test('对照：恢复 127.0.0.1:17001 的快照：sessionPageUrl 非空且可解析', async () => {
    const { base } = await startWith(snapshotWithDirectAddr(VALID_ADDR))
    const token = await loginAsAdmin(base)

    const host = await listedHost(base, token)
    assert.deepEqual(host.directAddrs, [VALID_ADDR])
    assert.equal(host.tlsFingerprint, 'sha256:u277tls')

    const project = await listedProject(base, token)
    const raw = project.sessionPageUrl
    assert.equal(typeof raw, 'string')
    assert.notEqual(raw, '', 'a dialable address still produces a session page URL')
    const page = new URL(String(raw))
    assert.equal(page.host, VALID_ADDR)
    assert.equal(page.pathname, '/cloud-admin.html')
    assert.equal(page.searchParams.get('api'), base, 'the platform origin rides along')
  })
})
