import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { login, spawnService, type Service } from './harness.ts'

/**
 * U147: the admin host list must show the version a host actually runs.
 *
 * A registration may carry `orcaVersion`, but already-registered hosts are never
 * re-registered, so the heartbeat is the only path that can heal a placeholder.
 * A beat without the field must keep the known value, and a revoked host's beat
 * must not refresh it.
 */

const EVIDENCE = 'u147-host-version-heartbeat'
const HOST_NAME = 'u147-versioned-host'

type HostRow = { id: string; orcaVersion: string }

let api: Service
let adminToken = ''
let hostId = ''
let credential = ''

async function register(version?: string): Promise<{ hostId: string; credential: string }> {
  const tokenRes = await fetch(`${api.url}/v1/hosts/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}` }
  })
  const { token } = (await tokenRes.json()) as { token: string }
  const res = await fetch(`${api.url}/v1/hosts/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      name: HOST_NAME,
      fingerprint: `host:${HOST_NAME}`,
      e2eePublicKeyB64: '',
      ...(version ? { orcaVersion: version } : {}),
      protocolVersion: 3,
      networkZone: 'intranet',
      directAddrs: ['127.0.0.1:16770'],
      relayTarget: '127.0.0.1:16770',
      relayRoute: HOST_NAME,
      runtimeCapabilities: ['pty', 'files']
    })
  })
  if (!res.ok) {
    throw new Error(await res.text())
  }
  return (await res.json()) as { hostId: string; credential: string }
}

async function heartbeat(version?: string): Promise<void> {
  const res = await fetch(`${api.url}/v1/hosts/${hostId}/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
    body: JSON.stringify({ status: 'online', ...(version ? { orcaVersion: version } : {}) })
  })
  assert.equal(res.status, 200, await res.text())
}

async function hostRow(): Promise<HostRow> {
  const res = await fetch(`${api.url}/v1/hosts`, {
    headers: { authorization: `Bearer ${adminToken}` }
  })
  assert.equal(res.status, 200)
  const { hosts } = (await res.json()) as { hosts: HostRow[] }
  const row = hosts.find((entry) => entry.id === hostId)
  assert.ok(row, 'registered host is listed')
  return row
}

before(async () => {
  api = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    EVIDENCE
  )
  adminToken = await login(api.url, 'admin', 'Adm1n!')
  const registered = await register('1.2.3-register')
  hostId = registered.hostId
  credential = registered.credential
})

after(async () => {
  await api?.stop()
})

test('注册带版本时列表有值', async () => {
  assert.equal((await hostRow()).orcaVersion, '1.2.3-register')
})

test('心跳带版本时更新', async () => {
  await heartbeat('1.3.0-beat')
  assert.equal((await hostRow()).orcaVersion, '1.3.0-beat')
})

test('心跳不带版本时不清空', async () => {
  await heartbeat()
  assert.equal((await hostRow()).orcaVersion, '1.3.0-beat')
})

test('吊销后的宿主心跳不再更新版本', async () => {
  const revoke = await fetch(`${api.url}/v1/hosts/${hostId}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${adminToken}` }
  })
  assert.equal(revoke.status, 200)
  await heartbeat('9.9.9-revoked')
  assert.equal((await hostRow()).orcaVersion, '1.3.0-beat')
})
