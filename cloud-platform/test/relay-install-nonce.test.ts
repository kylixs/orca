import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { createApp, type ApiHandle } from '../apps/api/src/server.ts'

/**
 * U183 R10a: the install nonce rides the existing relay announce as an optional
 * field, so old relays keep registering and old platforms simply ignore it.
 */

const TOKEN = 'nonce-internal-token'
const apps: ApiHandle[] = []

after(async () => {
  for (const app of apps) await app.close()
})

async function startPlatform(): Promise<string> {
  const app = createApp({ port: 0, ldapRequiredGroup: '', internalToken: TOKEN })
  const port = await app.listen()
  apps.push(app)
  return `http://127.0.0.1:${port}`
}

type RelayRecord = { id: string; installNonce: string }

async function announce(
  base: string,
  body: Record<string, unknown>
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}/v1/internal/relay-endpoint`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-token': TOKEN },
    body: JSON.stringify(body)
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

async function relays(base: string): Promise<RelayRecord[]> {
  const res = await fetch(`${base}/v1/internal/relays`, {
    headers: { 'x-internal-token': TOKEN }
  })
  assert.equal(res.status, 200)
  return ((await res.json()) as { relays: RelayRecord[] }).relays
}

describe('installNonce 线协议（U183 R10a）', () => {
  test('新中继上报 nonce：接受并可从内部查询回显', async () => {
    const base = await startPlatform()
    const res = await announce(base, {
      id: 'relay-new',
      port: 18443,
      installNonce: 'install-AbC_123-'
    })
    assert.equal(res.status, 200)
    const record = (await relays(base)).find((node) => node.id === 'relay-new')
    assert.equal(record?.installNonce, 'install-AbC_123-')
  })

  test('旧中继不带字段：照常登记，回显为空串', async () => {
    const base = await startPlatform()
    const res = await announce(base, { id: 'relay-old', port: 18444 })
    assert.equal(res.status, 200)
    const record = (await relays(base)).find((node) => node.id === 'relay-old')
    assert.ok(record)
    assert.equal(record.installNonce, '')
  })

  test('非法字符与非字符串：400 且错误码明确', async () => {
    const base = await startPlatform()
    for (const installNonce of ['has space', 'slash/path', 'semi;colon', 42]) {
      const res = await announce(base, { id: 'relay-bad', port: 18445, installNonce })
      assert.equal(res.status, 400, String(installNonce))
      const error = res.body.error as { code: string }
      assert.equal(error.code, 'RELAY_INSTALL_NONCE_INVALID')
    }
    assert.deepEqual(await relays(base), [], 'rejected announcements must not register')
  })

  test('超过 128 字符：400 RELAY_INSTALL_NONCE_INVALID', async () => {
    const base = await startPlatform()
    const res = await announce(base, {
      id: 'relay-long',
      port: 18446,
      installNonce: 'a'.repeat(129)
    })
    assert.equal(res.status, 400)
    assert.equal((res.body.error as { code: string }).code, 'RELAY_INSTALL_NONCE_INVALID')
  })

  test('恰好 128 字符：接受', async () => {
    const base = await startPlatform()
    const nonce = 'a'.repeat(128)
    const res = await announce(base, { id: 'relay-max', port: 18447, installNonce: nonce })
    assert.equal(res.status, 200)
    assert.equal((await relays(base)).find((node) => node.id === 'relay-max')?.installNonce, nonce)
  })
})
