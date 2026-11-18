import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp, type ApiHandle } from '../src/server.ts'

/**
 * U263: `isDirectAddrForm` fed `https://<addr>/cloud-admin.html`, so a `@` or
 * percent-encoded separator could move the session page onto another origin.
 * Host and port forms that a browser can actually dial must still pass.
 */

const ORIGIN = 'https://console.u263.example'
const INTERNAL_TOKEN = 'u263-token'
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

/** Reserved/separator characters: any of these would change the spliced URL. */
const REFUSED = [
  '10.0.0.5@evil.example',
  '10.0.0.5%2F..',
  '10.0.0.5\\evil',
  'evil.example/path',
  'evil.example?probe=1',
  'evil.example#fragment'
]

const ACCEPTED = ['10.0.0.5', '10.0.0.5:9000', '[::1]', '[::1]:443']

after(async () => {
  await Promise.all(apps.map((app) => app.close()))
})

describe('U263 directAddrs 拒绝 URL 保留字符', () => {
  test('register 拒绝保留字符：400 HOST_DIRECTADDRS_INVALID 且令牌不消耗', async () => {
    const { app, base } = await start()
    const admin = await loginAs(base, 'u263-register-admin')

    for (const [index, addr] of REFUSED.entries()) {
      const token = await mintHostToken(base, admin)
      const name = `u263-refused-${index}`
      const res = await registerHost(base, token, {
        name,
        protocolVersion: 3,
        directAddrs: [addr]
      })
      const payload = (await res.json()) as Json
      assert.equal(res.status, 400, `directAddrs=${JSON.stringify(addr)}: ${JSON.stringify(payload)}`)
      assert.equal(errorCode(payload), 'HOST_DIRECTADDRS_INVALID')
      assert.equal(app.store.hostsByName.has(name), false, 'the bad address is not persisted')
      assert.equal(app.store.hostTokens.at(-1)?.usedAt, null, 'the refusal spends no token')
    }
  })

  test('register 仍接受 IPv4/IPv6/端口形式', async () => {
    const { app, base } = await start()
    const admin = await loginAs(base, 'u263-accept-admin')
    const token = await mintHostToken(base, admin)

    const res = await registerHost(base, token, {
      name: 'u263-accepted',
      protocolVersion: 3,
      directAddrs: ACCEPTED
    })
    assert.equal(res.status, 201, await res.clone().text())
    const host = app.store.hostsByName.get('u263-accepted')
    assert.ok(host)
    assert.deepEqual(host.directAddrs, ACCEPTED)
  })

  test('裸 IPv6 无方括号仍拒绝：无法拼进 URL host', async () => {
    const { app, base } = await start()
    const admin = await loginAs(base, 'u263-bare-v6-admin')
    const token = await mintHostToken(base, admin)

    assert.throws(() => new URL('https://::1/cloud-admin.html'), 'bare IPv6 is not a URL host')
    const res = await registerHost(base, token, {
      name: 'u263-bare-v6',
      protocolVersion: 3,
      directAddrs: ['::1']
    })
    const payload = (await res.json()) as Json
    assert.equal(res.status, 400, JSON.stringify(payload))
    assert.equal(errorCode(payload), 'HOST_DIRECTADDRS_INVALID')
    assert.equal(app.store.hostsByName.has('u263-bare-v6'), false)
  })

  test('heartbeat 拒绝保留字符且不覆盖已存地址', async () => {
    const { app, base } = await start()
    const admin = await loginAs(base, 'u263-heartbeat-admin')
    const token = await mintHostToken(base, admin)

    const registered = await registerHost(base, token, {
      name: 'u263-heartbeat',
      protocolVersion: 3,
      directAddrs: ['10.0.0.5:9000']
    })
    assert.equal(registered.status, 201, await registered.clone().text())
    const { hostId, credential } = (await registered.json()) as {
      hostId: string
      credential: string
    }

    for (const addr of REFUSED) {
      const res = await postHeartbeat(base, hostId, credential, { directAddrs: [addr] })
      const payload = (await res.json()) as Json
      assert.equal(res.status, 400, `directAddrs=${JSON.stringify(addr)}: ${JSON.stringify(payload)}`)
      assert.equal(errorCode(payload), 'HOST_DIRECTADDRS_INVALID')
      assert.deepEqual(app.store.hosts.get(hostId)?.directAddrs, ['10.0.0.5:9000'])
    }

    const accepted = await postHeartbeat(base, hostId, credential, {
      directAddrs: ACCEPTED
    })
    assert.equal(accepted.status, 200, await accepted.clone().text())
    assert.deepEqual(app.store.hosts.get(hostId)?.directAddrs, ACCEPTED)
  })
})
