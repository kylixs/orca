import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { registerHost, saveEvidence, spawnService, type Service } from './harness.ts'

const EVIDENCE = 'w120-fix-u25'
let api: Service
let adminToken = ''
let devToken = ''
let hostId = ''
let projectId = ''

async function login(username: string, password: string): Promise<string> {
  const res = await fetch(`${api.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, deviceName: 'w120-branch-validation' })
  })
  const body = (await res.json()) as { accessToken?: string; error?: { code: string } }
  assert.equal(res.status, 200, `login ${username} failed: ${body.error?.code}`)
  return body.accessToken!
}

function auth(token: string): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${token}` }
}

async function createProject(
  token: string,
  body: Record<string, unknown>
): Promise<{
  status: number
  body: unknown
}> {
  const res = await fetch(`${api.url}/v1/projects`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify(body)
  })
  return { status: res.status, body: await res.json() }
}

async function createSelfService(
  token: string,
  body: Record<string, unknown>
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${api.url}/v1/projects/self`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify(body)
  })
  return { status: res.status, body: await res.json() }
}

function errorCode(body: unknown): string | null {
  return (body as { error?: { code?: string } }).error?.code ?? null
}

const ILLEGAL_BRANCHES = [
  'bad..branch',
  '.bad',
  'bad.',
  'has space',
  '-flag',
  '/leading',
  'trailing/',
  'double//slash',
  'a@{b',
  'caret^name',
  'tilde~name',
  'star*name',
  'quest?name',
  'colon:name',
  'bracket[name',
  'back\\slash',
  '@'
]

before(async () => {
  api = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api'
  )
  adminToken = await login('admin', 'Adm1n!')
  devToken = await login('zhangsan', 'Passw0rd!')
  const host = await registerHost({
    apiUrl: api.url,
    adminToken,
    name: 'dev-w120-branch',
    directAddr: '127.0.0.1:9',
    relayTarget: '127.0.0.1:9',
    projectsRoot: '/srv/projects'
  })
  hostId = host.hostId
  // U65/U67: self-service creation needs the host provision bit.
  const granted = await fetch(`${api.url}/v1/hosts/${hostId}/grants`, {
    method: 'PUT',
    headers: auth(adminToken),
    body: JSON.stringify({
      subjectType: 'group',
      subjectId: 'developers',
      permissions: ['provision']
    })
  })
  assert.equal(granted.status, 200, await granted.text())
  const created = await createProject(adminToken, {
    key: 'w120-branch-fix',
    name: 'Branch Validation',
    hostId,
    path: '/srv/work/branch-fix',
    defaultBranch: 'main'
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  projectId = (created.body as { id: string }).id
})

after(async () => {
  await api?.stop()
})

describe('W120 U25 平台登记分支名校验与宿主 git-ref 规则一致（真实平台进程）', () => {
  test('管理员创建：非法分支名一律 400 BRANCH_INVALID，不再 201', async () => {
    const rejections: Record<string, string | null> = {}
    for (const [index, branch] of ILLEGAL_BRANCHES.entries()) {
      const result = await createProject(adminToken, {
        key: `w120-branch-bad-${index}`,
        name: `Bad Branch ${index}`,
        hostId,
        path: `/srv/work/branch-bad-${index}`,
        defaultBranch: branch
      })
      assert.equal(result.status, 400, `branch ${JSON.stringify(branch)} should be rejected`)
      assert.equal(errorCode(result.body), 'BRANCH_INVALID', `branch ${JSON.stringify(branch)}`)
      rejections[branch] = errorCode(result.body)
    }
    saveEvidence(EVIDENCE, 'platform-admin-create-branch-invalid.json', { rejections })
  })

  test('管理员创建：合法分支名 201 且原样保存', async () => {
    const created: Record<string, string> = {}
    for (const [index, branch] of ['main', 'feature/x', 'v1.0', 'release/1.0'].entries()) {
      const result = await createProject(adminToken, {
        key: `w120-branch-ok-${index}`,
        name: `Good Branch ${index}`,
        hostId,
        path: `/srv/work/branch-ok-${index}`,
        defaultBranch: branch
      })
      assert.equal(result.status, 201, JSON.stringify(result.body))
      assert.equal((result.body as { defaultBranch: string }).defaultBranch, branch)
      created[branch] = 'created'
    }
    // 未提供 defaultBranch 仍回落 main。
    const omitted = await createProject(adminToken, {
      key: 'w120-branch-omitted',
      name: 'Omitted Branch',
      hostId,
      path: '/srv/work/branch-omitted'
    })
    assert.equal(omitted.status, 201, JSON.stringify(omitted.body))
    assert.equal((omitted.body as { defaultBranch: string }).defaultBranch, 'main')
    saveEvidence(EVIDENCE, 'platform-admin-create-branch-valid.json', { created, omitted: 'main' })
  })

  test('自助创建：非法分支名 400 BRANCH_INVALID', async () => {
    const rejections: Record<string, string | null> = {}
    for (const branch of ['bad..branch', '.bad', 'bad.', 'has space']) {
      const result = await createSelfService(devToken, {
        name: 'Self Service Bad Branch',
        dir: 'self-branch-bad',
        repoUrl: 'https://git.example.com/pay/self-branch-bad.git',
        defaultBranch: branch
      })
      assert.equal(result.status, 400, `branch ${JSON.stringify(branch)} should be rejected`)
      assert.equal(errorCode(result.body), 'BRANCH_INVALID', `branch ${JSON.stringify(branch)}`)
      rejections[branch] = errorCode(result.body)
    }
    saveEvidence(EVIDENCE, 'platform-self-service-branch-invalid.json', { rejections })
  })

  test('自助创建：合法分支名 201', async () => {
    for (const [index, branch] of ['main', 'feature/x', 'v1.0'].entries()) {
      const result = await createSelfService(devToken, {
        name: `Self Service Branch ${index}`,
        dir: `self-branch-ok-${index}`,
        repoUrl: 'https://git.example.com/pay/self-branch-ok.git',
        defaultBranch: branch,
        hostId
      })
      assert.equal(result.status, 201, JSON.stringify(result.body))
      assert.equal((result.body as { defaultBranch: string }).defaultBranch, branch)
    }
  })

  test('项目更新（PUT）：非法分支名 400，合法分支名 200', async () => {
    for (const branch of ['bad..branch', '.bad', 'bad.', 'has space', 'double//slash']) {
      const res = await fetch(`${api.url}/v1/projects/${projectId}`, {
        method: 'PUT',
        headers: auth(adminToken),
        body: JSON.stringify({ defaultBranch: branch })
      })
      const body = (await res.json()) as { error?: { code?: string } }
      assert.equal(res.status, 400, `branch ${JSON.stringify(branch)} should be rejected`)
      assert.equal(body.error?.code, 'BRANCH_INVALID', `branch ${JSON.stringify(branch)}`)
    }
    const ok = await fetch(`${api.url}/v1/projects/${projectId}`, {
      method: 'PUT',
      headers: auth(adminToken),
      body: JSON.stringify({ defaultBranch: 'release/1.0' })
    })
    const okBody = (await ok.json()) as { defaultBranch: string }
    assert.equal(ok.status, 200, JSON.stringify(okBody))
    assert.equal(okBody.defaultBranch, 'release/1.0')
    saveEvidence(EVIDENCE, 'platform-update-branch.json', { updatedTo: 'release/1.0' })
  })
})
