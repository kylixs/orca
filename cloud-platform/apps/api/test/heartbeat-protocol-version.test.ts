import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp, type ApiHandle } from '../src/server.ts'

/**
 * U272 H44: a non-numeric `protocolVersion` used to reach `Number(...)`, become
 * NaN, and persist as null. The register/beat lifecycle below pins both the
 * refusal and the fact that it cannot strand an already-live host.
 */

const ORIGIN = 'https://console.u272.example'
const INTERNAL_TOKEN = 'u272-token'
const apps: ApiHandle[] = []

async function start(): Promise<{ app: ApiHandle; base: string }> {
  const app = createApp({
    port: 0,
    accessTtlMs: 60_000,
    refreshTtlMs: 60_000,
    internalToken: INTERNAL_TOKEN,
    cookieMode: 'auto',
    publicOrigin: ORIGIN
  })
  apps.push(app)
  const port = await app.listen()
  return { app, base: `http://127.0.0.1:${port}` }
}

type Json = Record<string, unknown>

function errorCode(body: Json): unknown {
  const error = body.error
  return error !== null && typeof error === 'object' ? (error as Json).code : undefined
}

async function loginAs(base: string, device: string): Promise<string> {
  const res = await fetch(`${base}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: device })
  })
  assert.equal(res.status, 200, 'admin must log in')
  return String(((await res.json()) as Json).accessToken ?? '')
}

async function mintHostToken(base: string, token: string): Promise<string> {
  const res = await fetch(`${base}/v1/hosts/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }
  })
  assert.equal(res.status, 201, 'an admin may mint a host registration token')
  return String(((await res.json()) as Json).token ?? '')
}

function registerHost(base: string, token: string, body: Json): Promise<Response> {
  return fetch(`${base}/v1/hosts/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  })
}

function postHeartbeat(
  base: string,
  hostId: string,
  credential: string,
  body: Json
): Promise<Response> {
  return fetch(`${base}/v1/hosts/${hostId}/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
    body: JSON.stringify(body)
  })
}

async function hostsById(base: string, token: string): Promise<Record<string, Json>> {
  const res = await fetch(`${base}/v1/hosts`, { headers: { authorization: `Bearer ${token}` } })
  assert.equal(res.status, 200)
  const body = (await res.json()) as { hosts?: Json[] }
  return Object.fromEntries((body.hosts ?? []).map((host) => [String(host.id), host]))
}

after(async () => {
  await Promise.all(apps.map((app) => app.close()))
})

describe('U272 心跳/注册 protocolVersion 校验', () => {
  test('非数值拒绝且不落库，随后合法心跳仍在线', async () => {
    const { app, base } = await start()
    const admin = await loginAs(base, 'u272-admin')
    const name = 'u272-heartbeat-host'

    const firstToken = await mintHostToken(base, admin)
    const first = await registerHost(base, firstToken, { name, protocolVersion: 3 })
    assert.equal(first.status, 201, await first.clone().text())
    const { hostId, credential } = (await first.json()) as {
      hostId: string
      credential: string
    }
    assert.equal(app.store.hosts.get(hostId)?.protocolVersion, 3)

    const beaten = await postHeartbeat(base, hostId, credential, { status: 'online' })
    assert.equal(beaten.status, 200, await beaten.clone().text())
    assert.equal((await hostsById(base, admin))[hostId]?.online, true)

    // A re-registration carrying junk must 400 and leave both the stored
    // version and the single-use token untouched.
    const badToken = await mintHostToken(base, admin)
    const bad = await registerHost(base, badToken, {
      name,
      protocolVersion: 'not-a-number'
    })
    const badPayload = (await bad.json()) as Json
    assert.equal(bad.status, 400, JSON.stringify(badPayload))
    assert.equal(errorCode(badPayload), 'HOST_PROTOCOL_VERSION_INVALID')
    assert.equal(app.store.hosts.get(hostId)?.protocolVersion, 3, 'the old value survives')
    assert.equal(app.store.hostTokens.at(-1)?.usedAt, null, 'the refusal spends no token')

    // The same token still works once the version is legal (numeric string).
    const retried = await registerHost(base, badToken, { name, protocolVersion: '4' })
    assert.equal(retried.status, 201, await retried.clone().text())
    const rotated = (await retried.json()) as { credential: string }
    assert.equal(app.store.hosts.get(hostId)?.protocolVersion, 4)

    // The rotate above is the only reason the old credential is gone; the host
    // itself is not offline, and a legal beat restores/extends liveness.
    const recovered = await postHeartbeat(base, hostId, rotated.credential, { status: 'online' })
    assert.equal(recovered.status, 200, await recovered.clone().text())
    assert.equal((await hostsById(base, admin))[hostId]?.online, true)
  })

  test('null 与缺省容忍并回落到默认 3', async () => {
    const { app, base } = await start()
    const admin = await loginAs(base, 'u272-defaults-admin')
    const name = 'u272-defaults-host'

    const token = await mintHostToken(base, admin)
    const registered = await registerHost(base, token, { name, protocolVersion: 3 })
    assert.equal(registered.status, 201)
    const { hostId } = (await registered.json()) as { hostId: string }

    for (const [index, protocolVersion] of [null, undefined].entries()) {
      const nextToken = await mintHostToken(base, admin)
      const body: Json = { name }
      if (protocolVersion !== undefined) body.protocolVersion = protocolVersion
      const res = await registerHost(base, nextToken, body)
      assert.equal(res.status, 201, `case ${index}: ${await res.clone().text()}`)
      assert.equal(app.store.hosts.get(hostId)?.protocolVersion, 3, `case ${index} defaults to 3`)
    }
  })

  test('非整数与布尔值拒绝，不改成静默值', async () => {
    const { base } = await start()
    const admin = await loginAs(base, 'u272-types-admin')

    for (const protocolVersion of [1.5, true, '', '3x', '1e999', -1, Number.MAX_SAFE_INTEGER + 2]) {
      const token = await mintHostToken(base, admin)
      const res = await registerHost(base, token, {
        name: `u272-type-${String(protocolVersion)}`,
        protocolVersion
      })
      const payload = (await res.json()) as Json
      assert.equal(res.status, 400, `${String(protocolVersion)}: ${JSON.stringify(payload)}`)
      assert.equal(errorCode(payload), 'HOST_PROTOCOL_VERSION_INVALID')
    }
  })
})
