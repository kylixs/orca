import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp, type ApiHandle } from '../src/server.ts'

/**
 * U273 G8b: a whole-row grant PUT is set-valued. Repeated permission bits must
 * be stored once, and re-submitting one subject must replace its row instead of
 * appending a duplicate; two subject types sharing an id stay separate rows.
 */

const ORIGIN = 'https://console.u273.example'
const INTERNAL_TOKEN = 'u273-token'
const PROJECT_ID = 'proj_payment'
const HOST_ID = 'host_dev001'
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

async function loginAs(base: string, device: string): Promise<string> {
  const res = await fetch(`${base}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: device })
  })
  assert.equal(res.status, 200, 'admin must log in')
  return String(((await res.json()) as Json).accessToken ?? '')
}

async function putGrants(base: string, token: string, path: string, body: Json): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  })
}

async function getGrants(base: string, token: string, path: string): Promise<Json[]> {
  const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } })
  assert.equal(res.status, 200)
  return ((await res.json()) as { grants?: Json[] }).grants ?? []
}

function rowsFor(app: ApiHandle, subjectType: string, subjectId: string): number {
  return app.store.grants.filter(
    (grant) =>
      grant.projectId === PROJECT_ID &&
      grant.subjectType === subjectType &&
      grant.subjectId === subjectId
  ).length
}

after(async () => {
  await Promise.all(apps.map((app) => app.close()))
})

describe('U273 项目授权重复权限位与重复 subject', () => {
  test('重复权限位落库去重且回显唯一集合', async () => {
    const { app, base } = await start()
    const token = await loginAs(base, 'u273-bits-admin')
    const dev = app.store.usersByName.get('zhangsan')
    assert.ok(dev)

    const res = await putGrants(base, token, `/v1/projects/${PROJECT_ID}/grants`, {
      subjectType: 'user',
      subjectId: dev.username,
      permissions: ['open', 'open', 'terminal']
    })
    assert.equal(res.status, 200, await res.clone().text())

    const grants = await getGrants(base, token, `/v1/projects/${PROJECT_ID}/grants`)
    const row = grants.find((grant) => grant.subjectId === dev.id)
    assert.ok(row)
    assert.deepEqual(row.permissions, ['open', 'terminal'])
    assert.equal(rowsFor(app, 'user', dev.id), 1)
  })

  test('同一 subject 提交两次只保留一行', async () => {
    const { app, base } = await start()
    const token = await loginAs(base, 'u273-repeat-admin')
    const dev = app.store.usersByName.get('zhangsan')
    assert.ok(dev)

    for (const permissions of [
      ['open', 'terminal'],
      ['open', 'terminal']
    ]) {
      const res = await putGrants(base, token, `/v1/projects/${PROJECT_ID}/grants`, {
        subjectType: 'user',
        subjectId: dev.username,
        permissions
      })
      assert.equal(res.status, 200, await res.clone().text())
    }

    assert.equal(rowsFor(app, 'user', dev.id), 1, 'the second PUT replaces, never appends')
    const grants = await getGrants(base, token, `/v1/projects/${PROJECT_ID}/grants`)
    assert.equal(grants.filter((grant) => grant.subjectId === dev.id).length, 1)
  })

  test('不同 subjectType 的同名 id 不合并', async () => {
    const { app, base } = await start()
    const token = await loginAs(base, 'u273-subject-type-admin')
    const dev = app.store.usersByName.get('zhangsan')
    const admin = app.store.usersByName.get('admin')
    assert.ok(dev)
    assert.ok(admin)

    // Make the user's own id a known group name so both subject types resolve
    // to the same string; the write path must still key rows by subjectType.
    admin.groups.push(dev.id)

    const groupRes = await putGrants(base, token, `/v1/projects/${PROJECT_ID}/grants`, {
      subjectType: 'group',
      subjectId: dev.id,
      permissions: ['agent']
    })
    assert.equal(groupRes.status, 200, await groupRes.clone().text())

    const userRes = await putGrants(base, token, `/v1/projects/${PROJECT_ID}/grants`, {
      subjectType: 'user',
      subjectId: dev.id,
      permissions: ['open']
    })
    assert.equal(userRes.status, 200, await userRes.clone().text())

    assert.equal(rowsFor(app, 'group', dev.id), 1)
    assert.equal(rowsFor(app, 'user', dev.id), 1)
    const grants = await getGrants(base, token, `/v1/projects/${PROJECT_ID}/grants`)
    const sameId = grants.filter((grant) => grant.subjectId === dev.id)
    assert.equal(sameId.length, 2)
    assert.deepEqual(sameId.map((grant) => grant.subjectType).sort(), ['group', 'user'])
  })
})

describe('U273 主机授权重复权限位', () => {
  test('重复位去重且只落一行', async () => {
    const { app, base } = await start()
    const token = await loginAs(base, 'u273-host-bits-admin')
    const dev = app.store.usersByName.get('zhangsan')
    assert.ok(dev)

    const res = await putGrants(base, token, `/v1/hosts/${HOST_ID}/grants`, {
      subjectType: 'user',
      subjectId: dev.username,
      permissions: ['view', 'view', 'maintain']
    })
    assert.equal(res.status, 200, await res.clone().text())

    const hostRows = app.store.hostGrants.filter(
      (grant) => grant.hostId === HOST_ID && grant.subjectId === dev.id
    )
    assert.equal(hostRows.length, 1)
    assert.deepEqual(hostRows[0]?.permissions, ['view', 'maintain'])

    const grants = await getGrants(base, token, `/v1/hosts/${HOST_ID}/grants`)
    const row = grants.find((grant) => grant.subjectId === dev.id)
    assert.ok(row)
    assert.deepEqual(row.permissions, ['view', 'maintain'])
  })
})
