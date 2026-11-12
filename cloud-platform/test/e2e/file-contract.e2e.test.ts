import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { CloudClient } from '../../apps/client/src/cloud-client.ts'
import {
  makeTempWorkspace,
  makeTlsCerts,
  registerHost,
  saveEvidence,
  spawnService,
  type Service
} from './harness.ts'

/**
 * File addressing must match real Orca, which names files as
 * `{ worktree, relativePath }` — a path relative to a selected worktree.
 * A simulator that accepted a project-absolute `path` would let a client pass
 * review and then fail against the real runtime, so these cases pin the real
 * shape and the rejection of everything else.
 */

const EVIDENCE = 'm29-file-contract'
let api: Service
let runtime: Service
let adminToken = ''
let workspace: { root: string; projectRoot: string }

type Opened = {
  connect: { workspace: { projectRoot: string; workspaceRoot: string } }
}

before(async () => {
  workspace = makeTempWorkspace()
  const tls = makeTlsCerts()
  api = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api'
  )
  runtime = await spawnService(
    'apps/runtime/src/runtime-sim.ts',
    {
      PORT: '0',
      API_URL: api.url,
      HOST_ID: 'host_dev001',
      HOST_NAME: 'dev-001',
      SANDBOX_ROOT: workspace.root,
      TLS_KEY: tls.key,
      TLS_CERT: tls.cert
    },
    /\[runtime-sim\] dev-001 listening on :(\d+)/,
    'runtime'
  )
  const adminLogin = await fetch(`${api.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'file-admin' })
  })
  adminToken = ((await adminLogin.json()) as { accessToken: string }).accessToken
  // The seeded project already points at host_dev001; register the real bound port.
  await registerHost({
    apiUrl: api.url,
    adminToken,
    name: 'dev-001',
    directAddr: `127.0.0.1:${runtime.port}`,
    relayTarget: `127.0.0.1:${runtime.port}`
  })
  await new Promise((r) => setTimeout(r, 1500))
})

after(async () => {
  await runtime?.stop()
  await api?.stop()
})

async function openProject(client: CloudClient): Promise<Opened> {
  await client.login('zhangsan', 'Passw0rd!')
  const projects = await client.listProjects()
  return (await client.openProject(projects[0].id)) as unknown as Opened
}

function readFile(opened: Opened, relativePath: string, root: 'project' | 'workspace' = 'project') {
  return {
    worktree:
      root === 'project'
        ? opened.connect.workspace.projectRoot
        : opened.connect.workspace.workspaceRoot,
    relativePath
  }
}

describe('文件寻址：对齐真实 Orca 的 worktree + relativePath 契约', () => {
  test('M29-1 用 worktree + relativePath 读项目文件与个人工作区文件', async () => {
    const client = new CloudClient(api.url)
    const opened = await openProject(client)

    const projectRead = await client.rpc('files.read', readFile(opened, 'README.md', 'project'))
    assert.equal(projectRead.ok, true)
    assert.match(String((projectRead as { result: { content: string } }).result.content), /payment/i)

    const workspaceRead = await client.rpc(
      'files.read',
      readFile(opened, 'notes/hello.ts', 'workspace')
    )
    // The file need not exist yet; the write below proves the same addressing writes it.
    assert.equal(workspaceRead.ok === false, true)

    const write = await client.rpc('files.write', {
      ...readFile(opened, 'notes/hello.ts', 'workspace'),
      content: 'export const hello = 1\n'
    })
    assert.equal(write.ok, true)

    const after = await client.rpc('files.read', readFile(opened, 'notes/hello.ts', 'workspace'))
    assert.equal(after.ok, true)
    assert.equal(
      (after as { result: { content: string } }).result.content,
      'export const hello = 1\n'
    )

    saveEvidence(EVIDENCE, 'm29-1-relative-path.json', { projectRead, write })
    client.close()
  })

  test('M29-2 旧的绝对 path 形状被明确拒绝，而不是被悄悄接受', async () => {
    const client = new CloudClient(api.url)
    const opened = await openProject(client)
    const legacy = await client.rpc('files.read', {
      path: `${opened.connect.workspace.projectRoot}/README.md`
    })
    assert.equal(legacy.ok, false)
    assert.equal((legacy as { code: string }).code, 'MISSING_RELATIVE_PATH')

    const missing = await client.rpc('files.read', {
      worktree: opened.connect.workspace.projectRoot
    })
    assert.equal(missing.ok, false)
    assert.equal((missing as { code: string }).code, 'MISSING_RELATIVE_PATH')

    saveEvidence(EVIDENCE, 'm29-2-legacy-shape.json', { legacy, missing })
    client.close()
  })

  test('M29-3 绝对 relativePath、.. 穿越、未知 worktree 一律拒绝', async () => {
    const client = new CloudClient(api.url)
    const opened = await openProject(client)

    const absolute = await client.rpc('files.read', {
      worktree: opened.connect.workspace.projectRoot,
      relativePath: '/etc/passwd'
    })
    assert.equal(absolute.ok, false)
    assert.equal((absolute as { code: string }).code, 'PATH_OUTSIDE_ROOT')

    const traversal = await client.rpc(
      'files.read',
      readFile(opened, '../../etc/passwd', 'project')
    )
    assert.equal(traversal.ok, false)
    assert.equal((traversal as { code: string }).code, 'PATH_OUTSIDE_ROOT')

    const unknownWorktree = await client.rpc('files.read', {
      worktree: '/srv/work/payment-service/.orca-worktrees/zhangsan2',
      relativePath: 'README.md'
    })
    assert.equal(unknownWorktree.ok, false)
    assert.equal((unknownWorktree as { code: string }).code, 'WORKTREE_NOT_FOUND')

    saveEvidence(EVIDENCE, 'm29-3-boundaries.json', { absolute, traversal, unknownWorktree })
    client.close()
  })

  test('M29-4 写边界是本人工作区：以项目根为 worktree 写被拒，读允许', async () => {
    const client = new CloudClient(api.url)
    const opened = await openProject(client)

    const writeToProject = await client.rpc('files.write', {
      ...readFile(opened, 'main-only.ts', 'project'),
      content: 'x'
    })
    assert.equal(writeToProject.ok, false)
    assert.equal((writeToProject as { code: string }).code, 'PATH_OUTSIDE_ROOT')

    const readFromProject = await client.rpc(
      'files.read',
      readFile(opened, 'README.md', 'project')
    )
    assert.equal(readFromProject.ok, true)

    saveEvidence(EVIDENCE, 'm29-4-write-boundary.json', { writeToProject, readFromProject })
    client.close()
  })

  test('M29-5 符号链接指向工作区外时写入仍被 realpath 边界拒绝', async () => {
    const { existsSync, mkdirSync, symlinkSync } = await import('node:fs')
    const { join } = await import('node:path')
    const client = new CloudClient(api.url)
    const opened = await openProject(client)
    // The credential path is logical; the host maps it under the sandbox root.
    const workspaceRoot = join(workspace.projectRoot, '.orca-worktrees', 'zhangsan')
    mkdirSync(workspaceRoot, { recursive: true })
    const outside = join(workspace.root, 'outside-target')
    mkdirSync(outside, { recursive: true })
    const link = join(workspaceRoot, 'escape')
    if (existsSync(link)) (await import('node:fs')).rmSync(link, { recursive: true, force: true })
    symlinkSync(outside, link, 'dir')

    const escaped = await client.rpc('files.write', {
      ...readFile(opened, 'escape/pwned.ts', 'workspace'),
      content: 'escaped'
    })
    assert.equal(escaped.ok, false)
    assert.equal((escaped as { code: string }).code, 'PATH_OUTSIDE_ROOT')
    assert.equal(existsSync(join(outside, 'pwned.ts')), false)

    saveEvidence(EVIDENCE, 'm29-5-symlink.json', { escaped })
    client.close()
  })
})

describe('托管工作区分支名：路径形状非法一律拒绝', () => {
  test('M29-6 分支名含 .. / 以 . 开头 / 纯符号被拒，正常分支可创建且幂等', async () => {
    const client = new CloudClient(api.url)
    const opened = await openProject(client)
    const attempt = (branchName: string, idempotencyKey: string) =>
      client.rpc('worktree.createManaged', {
        projectId: 'proj_payment',
        branchName,
        workspaceRoot: opened.connect.workspace.workspaceRoot,
        nestWorkspaces: false,
        idempotencyKey
      })

    for (const bad of ['..', '../../etc', '.hidden', '///', '']) {
      const rejected = await attempt(bad, `bad-${bad}`)
      assert.equal(rejected.ok, false, `branch ${JSON.stringify(bad)} must be rejected`)
      assert.equal((rejected as { code: string }).code, 'BAD_REQUEST')
    }

    const first = await attempt('feature/m29', 'm29-key')
    assert.equal(first.ok, true)
    const firstPath = (first as { result: { path: string } }).result.path
    assert.ok(firstPath.endsWith('/feature-m29'), `sanitized path, got ${firstPath}`)

    const replay = await attempt('feature/m29', 'm29-key')
    assert.equal(replay.ok, true)
    assert.equal((replay as { result: { path: string } }).result.path, firstPath)

    saveEvidence(EVIDENCE, 'm29-6-branch-names.json', { first, replay })
    client.close()
  })
})
