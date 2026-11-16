import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { registerHost, saveEvidence, spawnService, type Service } from './harness.ts'

const EVIDENCE = 'm65-project-archive'
const REPO_URL = 'https://git.example.com/pay/archive-demo.git'
const INTERNAL_TOKEN = 'internal-test-token'
let api: Service
let adminToken = ''
let devToken = ''
let otherToken = ''
let hostId = ''
let firstProjectId = ''
let adminTargetId = ''
let rebornProjectId = ''
let pathBlockerId = ''

async function login(username: string, password: string): Promise<string> {
  const res = await fetch(`${api.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, deviceName: 'm65-archive' })
  })
  const body = (await res.json()) as { accessToken?: string; error?: { code: string } }
  assert.equal(res.status, 200, `login ${username} failed: ${body.error?.code}`)
  return body.accessToken!
}

function auth(token: string): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${token}` }
}

async function request(
  method: string,
  path: string,
  token: string,
  body?: Record<string, unknown>
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${api.url}${path}`, {
    method,
    headers: auth(token),
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  return { status: res.status, body: await res.json() }
}

function createSelf(token: string, body: Record<string, unknown>) {
  return request('POST', '/v1/projects/self', token, body)
}

function archive(token: string, projectId: string) {
  return request('POST', `/v1/projects/${projectId}/archive`, token)
}

function restore(token: string, projectId: string) {
  return request('POST', `/v1/projects/${projectId}/restore`, token)
}

function errorCode(body: unknown): string | null {
  return (body as { error?: { code?: string } }).error?.code ?? null
}

function visibleIds(body: unknown): string[] {
  return ((body as { projects?: { id: string }[] }).projects ?? []).map((project) => project.id)
}

before(async () => {
  api = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api'
  )
  adminToken = await login('admin', 'Adm1n!')
  devToken = await login('zhangsan', 'Passw0rd!')
  otherToken = await login('lisi', 'Passw0rd!')
  hostId = (
    await registerHost({
      apiUrl: api.url,
      adminToken,
      name: 'dev-m65-archive',
      directAddr: '127.0.0.1:9',
      relayTarget: '127.0.0.1:9',
      projectsRoot: '/srv/projects'
    })
  ).hostId
  // U65/U67: self-service creation needs the host provision bit.
  const granted = await request('PUT', `/v1/hosts/${hostId}/grants`, adminToken, {
    subjectType: 'group',
    subjectId: 'developers',
    permissions: ['provision']
  })
  assert.equal(granted.status, 200, JSON.stringify(granted.body))
})

after(async () => {
  await api?.stop()
})

describe('G06 归档详情 opt-in 只读（admin-only）', () => {
  let archivedId = ''
  let liveId = ''
  let creatorArchivedId = ''
  let auditorId = ''

  before(async () => {
    const live = await request('POST', '/v1/projects', adminToken, {
      key: 'g06-live',
      name: 'G06 Live',
      hostId,
      path: '/srv/projects/g06-live',
      repoUrl: ''
    })
    assert.equal(live.status, 201, JSON.stringify(live.body))
    liveId = (live.body as { id: string }).id

    const archivable = await request('POST', '/v1/projects', adminToken, {
      key: 'g06-archived',
      name: 'G06 Archived',
      hostId,
      path: '/srv/projects/g06-archived',
      repoUrl: ''
    })
    assert.equal(archivable.status, 201, JSON.stringify(archivable.body))
    archivedId = (archivable.body as { id: string }).id
    assert.equal((await archive(adminToken, archivedId)).status, 200)

    // Creator is a developer: the creator role must not unlock archived reads.
    const creator = await createSelf(devToken, {
      name: 'G06 Creator',
      key: 'g06-creator',
      dir: 'g06-creator',
      repoUrl: ''
    })
    assert.equal(creator.status, 201, JSON.stringify(creator.body))
    creatorArchivedId = (creator.body as { id: string }).id
    assert.equal((await archive(devToken, creatorArchivedId)).status, 200)

    const users = await request('GET', '/v1/users', adminToken)
    auditorId = (
      (users.body as { users: { id: string; username: string }[] }).users.find(
        (user) => user.username === 'lisi'
      ) as { id: string }
    ).id
    const promoted = await request('PUT', `/v1/users/${auditorId}/roles`, adminToken, {
      role: 'auditor'
    })
    assert.equal(promoted.status, 200, JSON.stringify(promoted.body))
  })

  after(async () => {
    if (auditorId) {
      await request('PUT', `/v1/users/${auditorId}/roles`, adminToken, { role: 'developer' })
    }
  })

  test('admin + includeArchived=1 → 200 只读视图；无参数仍 404', async () => {
    const detail = await request(
      'GET',
      `/v1/projects/${archivedId}?includeArchived=1`,
      adminToken
    )
    assert.equal(detail.status, 200, JSON.stringify(detail.body))
    const view = detail.body as Record<string, unknown>
    assert.equal(view.id, archivedId)
    assert.equal(view.status, 'archived')
    assert.equal(view.path, '/srv/projects/g06-archived')
    // Same shape as a live read: no new fields for archived.
    const live = await request('GET', `/v1/projects/${liveId}`, adminToken)
    assert.equal(live.status, 200)
    assert.deepEqual(
      Object.keys(detail.body as object).sort(),
      Object.keys(live.body as object).sort()
    )

    const noParam = await request('GET', `/v1/projects/${archivedId}`, adminToken)
    assert.equal(noParam.status, 404)
    assert.equal(errorCode(noParam.body), 'PROJECT_NOT_FOUND')
  })

  test('非 admin（developer/auditor/创建者）带参数仍 404', async () => {
    const dev = await request('GET', `/v1/projects/${archivedId}?includeArchived=1`, devToken)
    assert.equal(dev.status, 404)
    assert.equal(errorCode(dev.body), 'PROJECT_NOT_FOUND')

    const auditor = await request(
      'GET',
      `/v1/projects/${archivedId}?includeArchived=1`,
      otherToken
    )
    assert.equal(auditor.status, 404)
    assert.equal(errorCode(auditor.body), 'PROJECT_NOT_FOUND')

    const creator = await request(
      'GET',
      `/v1/projects/${creatorArchivedId}?includeArchived=1`,
      devToken
    )
    assert.equal(creator.status, 404)
    assert.equal(errorCode(creator.body), 'PROJECT_NOT_FOUND')
  })

  test('非归档项目带参数与无参数一致 200；未知 id 仍 404', async () => {
    const withParam = await request('GET', `/v1/projects/${liveId}?includeArchived=1`, adminToken)
    const without = await request('GET', `/v1/projects/${liveId}`, adminToken)
    assert.equal(withParam.status, 200)
    assert.deepEqual(withParam.body, without.body)

    const unknown = await request(
      'GET',
      '/v1/projects/proj_does_not_exist?includeArchived=1',
      adminToken
    )
    assert.equal(unknown.status, 404)
  })

  test('写面仍拒绝：PUT / policy / grants 对归档项目 404', async () => {
    const put = await request('PUT', `/v1/projects/${archivedId}?includeArchived=1`, adminToken, {
      repoUrl: ''
    })
    assert.equal(put.status, 404)
    const policy = await request(
      'GET',
      `/v1/projects/${archivedId}/policy?includeArchived=1`,
      adminToken
    )
    assert.equal(policy.status, 404)
    const grants = await request(
      'GET',
      `/v1/projects/${archivedId}/grants?includeArchived=1`,
      adminToken
    )
    assert.equal(grants.status, 404)
  })
})

describe('M65 项目归档闭环（真实平台进程）', () => {
  test('创建者可归档自己的项目；非创建者 404；管理员可归档他人项目', async () => {
    const created = await createSelf(devToken, {
      name: 'Archive Demo',
      key: 'archive-demo',
      dir: 'archive-demo',
      repoUrl: REPO_URL
    })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    firstProjectId = (created.body as { id: string }).id
    assert.equal((created.body as { status: string }).status, 'provisioning')

    const other = await archive(otherToken, firstProjectId)
    assert.equal(other.status, 404)
    assert.equal(errorCode(other.body), 'PROJECT_NOT_FOUND')

    const archived = await archive(devToken, firstProjectId)
    assert.equal(archived.status, 200, JSON.stringify(archived.body))
    assert.equal((archived.body as { status: string }).status, 'archived')

    // Idempotent: archiving an already archived project stays 200.
    const again = await archive(devToken, firstProjectId)
    assert.equal(again.status, 200)
    assert.equal((again.body as { status: string }).status, 'archived')

    const target = await createSelf(devToken, {
      name: 'Admin Target',
      key: 'admin-target',
      dir: 'admin-target',
      repoUrl: REPO_URL
    })
    assert.equal(target.status, 201, JSON.stringify(target.body))
    adminTargetId = (target.body as { id: string }).id
    const adminArchive = await archive(adminToken, adminTargetId)
    assert.equal(adminArchive.status, 200)
    assert.equal((adminArchive.body as { status: string }).status, 'archived')

    saveEvidence(EVIDENCE, 'platform-archive-permissions.json', {
      creatorArchived: archived.body,
      nonCreator: other.body,
      adminArchived: adminArchive.body
    })
  })

  test('归档后创建者列表不含该项目、详情 404；管理员列表仍可见 archived', async () => {
    const devList = await request('GET', '/v1/projects', devToken)
    assert.equal(devList.status, 200)
    assert.equal(visibleIds(devList.body).includes(firstProjectId), false)

    const detail = await request('GET', `/v1/projects/${firstProjectId}`, devToken)
    assert.equal(detail.status, 404)
    assert.equal(errorCode(detail.body), 'PROJECT_NOT_FOUND')

    const adminDetail = await request('GET', `/v1/projects/${firstProjectId}`, adminToken)
    assert.equal(adminDetail.status, 404)

    const adminList = await request('GET', '/v1/projects', adminToken)
    assert.equal(visibleIds(adminList.body).includes(firstProjectId), false)
    const archivedList = await request('GET', '/v1/projects?includeArchived=1', adminToken)
    const archived = (
      archivedList.body as { projects: { id: string; status: string }[] }
    ).projects.find((project) => project.id === firstProjectId)
    assert.equal(archived?.status, 'archived')
    saveEvidence(EVIDENCE, 'platform-archive-visibility.json', {
      devList: visibleIds(devList.body),
      adminArchived: archived
    })
  })

  test('归档释放 key 与路径：同 key 再建 201（新 id），活跃 key 仍 409', async () => {
    const reborn = await createSelf(devToken, {
      name: 'Archive Demo Reborn',
      key: 'archive-demo',
      dir: 'archive-demo',
      repoUrl: REPO_URL
    })
    assert.equal(reborn.status, 201, JSON.stringify(reborn.body))
    rebornProjectId = (reborn.body as { id: string }).id
    assert.notEqual(rebornProjectId, firstProjectId)
    assert.equal((reborn.body as { path: string }).path, '/srv/projects/archive-demo')

    const duplicate = await createSelf(devToken, {
      name: 'Archive Demo Duplicate',
      key: 'archive-demo',
      dir: 'archive-demo',
      repoUrl: REPO_URL
    })
    assert.equal(duplicate.status, 409)
    assert.equal(errorCode(duplicate.body), 'PROJECT_KEY_TAKEN')
    saveEvidence(EVIDENCE, 'platform-key-release.json', {
      reborn: reborn.body,
      duplicate: duplicate.body
    })
  })

  test('restore 撞 key 409；释放后 restore 回到 provisioning 并清空错误', async () => {
    const keyConflict = await restore(adminToken, firstProjectId)
    assert.equal(keyConflict.status, 409)
    assert.equal(errorCode(keyConflict.body), 'PROJECT_KEY_TAKEN')

    const archivedReborn = await archive(devToken, rebornProjectId)
    assert.equal(archivedReborn.status, 200)
    const restored = await restore(adminToken, firstProjectId)
    assert.equal(restored.status, 200, JSON.stringify(restored.body))
    assert.equal((restored.body as { status: string }).status, 'provisioning')
    assert.equal('provisioningError' in (restored.body as object), false)

    // Path-only conflict: same directory under a different key.
    assert.equal((await archive(adminToken, firstProjectId)).status, 200)
    const blocker = await request('POST', '/v1/projects', adminToken, {
      key: 'path-blocker',
      name: 'Path Blocker',
      hostId,
      path: '/srv/projects/archive-demo',
      repoUrl: ''
    })
    assert.equal(blocker.status, 201, JSON.stringify(blocker.body))
    pathBlockerId = (blocker.body as { id: string }).id
    const pathConflict = await restore(adminToken, firstProjectId)
    assert.equal(pathConflict.status, 409)
    assert.equal(errorCode(pathConflict.body), 'PROJECT_PATH_TAKEN')

    assert.equal((await archive(adminToken, pathBlockerId)).status, 200)
    const finalRestore = await restore(adminToken, firstProjectId)
    assert.equal(finalRestore.status, 200)
    assert.equal((finalRestore.body as { status: string }).status, 'provisioning')
    saveEvidence(EVIDENCE, 'platform-restore.json', {
      keyConflict: keyConflict.body,
      pathConflict: pathConflict.body,
      finalRestore: finalRestore.body
    })
  })

  test('archive 写入项目撤销，主机因此关闭该项目的 Live 会话', async () => {
    const res = await fetch(`${api.url}/v1/internal/revocations`, {
      headers: { 'x-internal-token': INTERNAL_TOKEN }
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as { projects: { id: string; since: number }[] }
    const archivedIds = body.projects.map((entry) => entry.id)
    for (const projectId of [firstProjectId, adminTargetId, pathBlockerId]) {
      assert.ok(archivedIds.includes(projectId), `missing revocation for ${projectId}`)
    }
    saveEvidence(EVIDENCE, 'platform-revocations.json', { revocations: body.projects })
  })
})
