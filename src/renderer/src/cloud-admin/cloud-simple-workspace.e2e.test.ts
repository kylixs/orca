// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CloudRpcOutcome } from '../../../shared/cloud-platform-ipc'
import {
  browseCloudDirectory,
  cloudWorktreeSelector,
  previewCloudFile
} from '../../../shared/cloud-file-browser'
import { readField, readString } from '../../../shared/json-fields'
import { installFakeAppEnvironment } from '../../../../config/scripts/vitest-host-ports-setup'
import { Store } from '../../../main/persistence/loading-store/store'
import { closeTestStores, createSqliteTestStore } from '../../../main/persistence-test-harness'
import { OrcaRuntimeService } from '../../../main/runtime/orca-runtime'
import {
  CLOUD_HOST_METHODS,
  startCloudRuntimeAdmission,
  type CloudRuntimeAdmission
} from '../../../main/startup/cloud-runtime-admission'
import {
  makeSelfSignedTls,
  REPO_ROOT,
  startCloudRuntime,
  startPlatform,
  type CloudRuntime,
  type Platform
} from '../../../main/cloud-platform/cloud-session-e2e-harness'
import { installRealPtyController } from '../../../main/cloud-platform/cloud-terminal-e2e-fixture'
import type { CloudBridge } from '../cloud/use-cloud-session'
import { createCloudBrowserBridge } from '../cloud/cloud-browser-bridge'
import { cloudSimpleWorkspaceFileTab } from '../cloud/cloud-simple-workspace-tabs'
import { writeCloudWorkspaceFile } from '../cloud/cloud-workspace-file-io'
import type { WebCloudDeviceKeyStorage } from '../web/web-cloud-device-key'

/**
 * U46-8 (§6.2): the embedded simple workspace against the real stack — real
 * platform process, real enrolled TLS runtime, real PTY, real git repository.
 *
 * E1 handoff→embed open, E2 terminal echo, E3 file-tree browse, E4 edit/save,
 * E5 markdown preview read, E6 git changes/commit/diff, E7 viewer degradation.
 * Runner: node (see config/scripts/vitest-node-runtime-files.mjs); node-pty
 * emits no data under the bun worker.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'u46-8-assembly')
const PERMISSIONS = ['open', 'terminal', 'file:read', 'file:write']
const VIEWER_PERMISSIONS = ['open', 'file:read']
const ECHO_MARKER = 'ORCA_U46_8_PTY_ECHO_OK'
/** A real 1x1 PNG, so the image preview round-trips actual bytes (F-04, §6.2 E3). */
const PNG_ONE_PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

function saveEvidence(file: string, content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, file), JSON.stringify(content, null, 2))
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function initRepo(path: string, marker: string): void {
  mkdirSync(path, { recursive: true })
  git(path, 'init', '-q', '-b', 'main')
  git(path, 'config', 'user.email', 'e2e@example.com')
  git(path, 'config', 'user.name', 'e2e')
  writeFileSync(join(path, 'README.md'), `# ${marker}\n\n- one\n- two\n`)
  writeFileSync(join(path, marker), `${marker}\n`)
  // F-04 (§6.2 E3): real image and HTML fixtures for true-host preview reads.
  writeFileSync(join(path, 'logo.png'), PNG_ONE_PIXEL)
  writeFileSync(
    join(path, 'page.html'),
    `<!doctype html>\n<html><body><h1>${marker}-html</h1></body></html>\n`
  )
  git(path, 'add', '.')
  git(path, 'commit', '-qm', 'init')
}

class DeviceKeyStorage implements WebCloudDeviceKeyStorage {
  value: string | null = null

  read(): string | null {
    return this.value
  }

  write(value: string): void {
    this.value = value
  }
}

async function waitForTerminalLine(
  rpc: (method: string, params?: Record<string, unknown>) => Promise<CloudRpcOutcome>,
  handle: string,
  needle: string,
  timeoutMs = 30_000
): Promise<CloudRpcOutcome> {
  const started = Date.now()
  let last: CloudRpcOutcome | null = null
  while (Date.now() - started < timeoutMs) {
    last = await rpc('terminal.read', { terminal: handle, limit: 200 })
    if (last.ok) {
      const tail = readField(readField(last.result, 'terminal'), 'tail')
      if (Array.isArray(tail) && tail.some((line) => String(line).includes(needle))) {
        return last
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return {
    ok: false,
    code: 'ECHO_TIMEOUT',
    message: `the PTY never echoed '${needle}'; last=${JSON.stringify(last)}`
  }
}

let platform: Platform
let admission: CloudRuntimeAdmission
let cloud: CloudRuntime
let bridge: CloudBridge
let adminToken = ''
let userToken = ''
let projectId = ''
let viewerProjectId = ''
/** No grant at all: the no-`open` 403 control (F-04, §6.2 E6). */
let unsharedProjectId = ''
let root = ''
let viewerRoot = ''

async function createProject(
  key: string,
  path: string,
  permissions: readonly string[] | null = PERMISSIONS
): Promise<string> {
  const res = await fetch(`${platform.url}/v1/projects`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      key,
      name: key,
      hostId: admission.host()!.hostId,
      path
    })
  })
  expect(res.status, await res.clone().text()).toBe(201)
  const id = readString(await res.json(), 'id')
  if (id === null) {
    throw new Error(`project ${key} has no id`)
  }
  if (permissions === null) {
    return id
  }
  await fetch(`${platform.url}/v1/projects/${id}/grants`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      subjectType: 'group',
      subjectId: 'team-payment',
      permissions
    })
  })
  return id
}

beforeAll(async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-u46-8-')))
  root = join(base, 'u46-service')
  viewerRoot = join(base, 'u46-viewer')
  initRepo(root, 'u46-marker.txt')
  initRepo(viewerRoot, 'viewer-marker.txt')

  const dataDir = mkdtempSync(join(tmpdir(), 'orca-u46-8-data-'))
  installFakeAppEnvironment({ getPath: () => dataDir })
  const store = createSqliteTestStore(Store, {
    dataFile: join(dataDir, 'orca-data.json')
  })
  store.addRepo({
    id: 'repo-u46',
    path: root,
    displayName: 'u46-service',
    badgeColor: 'gray',
    addedAt: 1
  })
  store.addRepo({
    id: 'repo-u46-viewer',
    path: viewerRoot,
    displayName: 'u46-viewer',
    badgeColor: 'gray',
    addedAt: 1
  })
  store.updateSettings({ workspaceDir: join(base, 'host-workspaces') })
  store.flushOrThrow()
  const service = new OrcaRuntimeService(store)
  installRealPtyController(service)

  platform = await startPlatform()
  const admin = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'admin',
      password: 'Adm1n!',
      deviceName: 'u46-8-admin'
    })
  })
  adminToken = readString(await admin.json(), 'accessToken') ?? ''
  if (adminToken === '') {
    throw new Error('admin login failed')
  }
  const user = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'zhangsan',
      password: 'Passw0rd!',
      deviceName: 'u46-8-user'
    })
  })
  userToken = readString(await user.json(), 'accessToken') ?? ''
  if (userToken === '') {
    throw new Error('zhangsan login failed')
  }
  const tokenRes = await fetch(`${platform.url}/v1/hosts/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}` }
  })
  const hostToken = readString(await tokenRes.json(), 'token')
  if (hostToken === null) {
    throw new Error('host token missing')
  }

  const started = startCloudRuntimeAdmission(
    {
      ORCA_CLOUD_API_URL: platform.url,
      ORCA_CLOUD_HOST_TOKEN: hostToken,
      ORCA_CLOUD_HOST_NAME: 'dev-u46-8',
      ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1'
    },
    { userDataPath: mkdtempSync(join(tmpdir(), 'orca-u46-8-host-')) }
  )
  if (!started) {
    throw new Error('cloud admission not enabled')
  }
  admission = started
  await admission.ready
  cloud = await startCloudRuntime({
    admission: admission.admission,
    connectionGate: admission.connectionGate,
    userDataPrefix: 'orca-u46-8-',
    service,
    tls: makeSelfSignedTls('dev-u46-8'),
    methods: CLOUD_HOST_METHODS
  })
  admission.bindRuntime(cloud.runtime)
  cloud.runtime.setCloudHostAudit((event) => admission.client?.reportAudit(event))
  await admission.client!.refresh()

  projectId = await createProject('u46-service', root)
  viewerProjectId = await createProject('u46-viewer', viewerRoot, VIEWER_PERMISSIONS)
  mkdirSync(join(base, 'u46-unshared'), { recursive: true })
  unsharedProjectId = await createProject('u46-unshared', join(base, 'u46-unshared'), null)
  await new Promise((resolve) => setTimeout(resolve, 1200))

  vi.stubGlobal('window', {
    setTimeout,
    clearTimeout,
    location: { protocol: 'https:' }
  })
  vi.stubGlobal('WebSocket', WebSocket)
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

  bridge = createCloudBrowserBridge({
    apiUrl: platform.url,
    deviceName: 'u46-8-session',
    deviceKeyStore: new DeviceKeyStorage()
  })
}, 120_000)

afterAll(async () => {
  await bridge?.logout()
  admission?.client?.stop()
  await cloud?.runtime.stop()
  await platform?.stop()
  await closeTestStores()
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
  vi.unstubAllGlobals()
})

async function issueAdminHandoff(): Promise<{
  status: number
  url: string
  surface: string | null
  code: string
}> {
  const res = await fetch(`${platform.url}/v1/projects/${projectId}/web-handoff`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${userToken}`
    },
    body: JSON.stringify({ surface: 'admin' })
  })
  const body = await res.json()
  const url = readString(body, 'url') ?? ''
  const hash = new URL(url).hash
  return {
    status: res.status,
    url,
    surface: readString(body, 'surface'),
    code: hash.replace(/^#handoff=/, '').replace(/&project=.*$/, '')
  }
}

describe('U46-8 简易工作区真栈（真实平台 + TLS 宿主 + 真 PTY + 真 git）', () => {
  it('E1 surface=admin handoff 兑换后嵌入打开：URL 形态、审计 surface、workspace.info 分支', async () => {
    const issued = await issueAdminHandoff()
    expect(issued.status).toBe(201)
    const page = new URL(issued.url)
    expect(page.pathname).toBe('/cloud-admin.html')
    expect(page.searchParams.get('embed')).toBe('1')
    expect(page.searchParams.get('project')).toBe(projectId)
    expect(issued.surface).toBe('admin')

    const loginWithHandoff = bridge.loginWithHandoff
    if (!loginWithHandoff) {
      throw new Error('the browser bridge must expose loginWithHandoff')
    }
    const signedIn = await loginWithHandoff.call(bridge, issued.code)
    expect(signedIn.status, JSON.stringify(signedIn)).toBe('signed-in')
    const opened = await bridge.openWorkspace(projectId)
    expect(opened.ok, JSON.stringify(opened)).toBe(true)
    if (!opened.ok || !opened.workspacePath) {
      throw new Error('the embedded workspace must open with a checkout')
    }
    const info = await bridge.rpc('workspace.info', {}, projectId)
    expect(info.ok, JSON.stringify(info)).toBe(true)
    const workspace = readField(info.ok ? info.result : null, 'workspace')
    expect(readString(workspace, 'path')).toBe(opened.workspacePath)

    const audit = await fetch(
      `${platform.url}/v1/audit/events?eventType=web_handoff&targetId=${projectId}`,
      { headers: { authorization: `Bearer ${adminToken}` } }
    )
    const events = readField(await audit.json(), 'events')
    const list = Array.isArray(events) ? events : []
    const adminEvent = list.find(
      (event) => readString(readField(event, 'metadata'), 'surface') === 'admin'
    )
    expect(adminEvent, JSON.stringify(list)).toBeTruthy()

    // F-04 (§6.2 E6): a spent code replays as 410; an `open`-less project is a
    // 404 for a plain user (existence never leaks) and a 403 at admin mint.
    const replay = await fetch(`${platform.url}/v1/web/handoff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: issued.code })
    })
    expect(replay.status).toBe(410)
    const unshared = await fetch(`${platform.url}/v1/projects/${unsharedProjectId}/web-handoff`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${userToken}`
      },
      body: JSON.stringify({ surface: 'admin' })
    })
    expect(unshared.status).toBe(404)
    const unsharedAdmin = await fetch(
      `${platform.url}/v1/projects/${unsharedProjectId}/web-handoff`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${adminToken}`
        },
        body: JSON.stringify({ surface: 'admin' })
      }
    )
    expect(unsharedAdmin.status).toBe(403)

    saveEvidence('e1-handoff-embed-open.json', {
      issued: {
        status: issued.status,
        pathname: page.pathname,
        surface: issued.surface
      },
      opened,
      workspaceInfo: workspace,
      adminSurfaceAudited: Boolean(adminEvent),
      replayStatus: replay.status,
      unsharedHandoffStatus: unshared.status,
      unsharedAdminHandoffStatus: unsharedAdmin.status
    })
  }, 120_000)

  it('E2 终端标签：create、输入回显、viewport、关闭后连接回收', async () => {
    const opened = await bridge.openWorkspace(projectId)
    if (!opened.ok || !opened.workspacePath) {
      throw new Error(`open failed: ${JSON.stringify(opened)}`)
    }
    const rpc = (method: string, params?: Record<string, unknown>) =>
      bridge.rpc(method, params ?? {}, projectId)
    const created = await rpc('terminal.create', {
      worktree: cloudWorktreeSelector(opened.workspacePath),
      title: 'Terminal 1'
    })
    expect(created.ok, JSON.stringify(created)).toBe(true)
    const handle = readString(readField(created.ok ? created.result : null, 'terminal'), 'handle')
    if (handle === null) {
      throw new Error('terminal handle missing')
    }
    const sent = await rpc('terminal.send', {
      terminal: handle,
      text: `echo ${ECHO_MARKER}\n`
    })
    expect(sent.ok, JSON.stringify(sent)).toBe(true)
    const read = await waitForTerminalLine(rpc, handle, ECHO_MARKER)
    expect(read.ok, JSON.stringify(read)).toBe(true)
    const resized = await rpc('terminal.updateViewport', {
      terminal: handle,
      client: { id: 'u46-8', type: 'desktop' },
      viewport: { cols: 100, rows: 30 }
    })
    expect(resized.ok).toBe(true)
    const closed = await rpc('terminal.close', { terminal: handle })
    expect(closed.ok).toBe(true)

    // F-04 (§6.2 E7): a PTY still alive at overlay close must be recycled with
    // the project — the socket refuses every further terminal call.
    const orphan = await rpc('terminal.create', {
      worktree: cloudWorktreeSelector(opened.workspacePath),
      title: 'Terminal 2'
    })
    expect(orphan.ok, JSON.stringify(orphan)).toBe(true)
    const orphanHandle = readString(
      readField(orphan.ok ? orphan.result : null, 'terminal'),
      'handle'
    )
    expect(orphanHandle).toBeTruthy()
    await bridge.closeProject(projectId)
    const gone = await rpc('status.get')
    expect(gone).toEqual({ ok: false, code: 'NOT_CONNECTED' })
    const orphanRead = await rpc('terminal.read', {
      terminal: orphanHandle ?? '',
      limit: 10
    })
    expect(orphanRead).toEqual({ ok: false, code: 'NOT_CONNECTED' })
    const noNew = await rpc('terminal.create', {
      worktree: cloudWorktreeSelector(opened.workspacePath),
      title: 'Terminal 3'
    })
    expect(noNew).toEqual({ ok: false, code: 'NOT_CONNECTED' })

    saveEvidence('e2-terminal-echo.json', {
      created,
      echoRead: read,
      resized,
      closed,
      gone,
      orphanRecycled: { read: orphanRead, create: noNew }
    })
  }, 120_000)

  it('E3 文件树浏览与点开文件标签：readDir 根/子目录，files.read 供编辑器', async () => {
    const opened = await bridge.openWorkspace(projectId)
    if (!opened.ok || !opened.workspacePath) {
      throw new Error(`open failed: ${JSON.stringify(opened)}`)
    }
    const rpc = (method: string, params?: Record<string, unknown>) =>
      bridge.rpc(method, params ?? {}, projectId)
    const rootListing = await browseCloudDirectory(rpc, opened.workspacePath)
    expect(rootListing.ok, JSON.stringify(rootListing)).toBe(true)
    if (!rootListing.ok) {
      throw new Error('root listing failed')
    }
    const names = rootListing.entries.map((entry) => entry.name)
    expect(names).toEqual(expect.arrayContaining(['README.md', 'u46-marker.txt']))

    const read = await rpc('files.read', {
      worktree: cloudWorktreeSelector(opened.workspacePath),
      relativePath: 'README.md'
    })
    expect(read.ok, JSON.stringify(read)).toBe(true)
    expect(readString(read.ok ? read.result : null, 'content')).toContain('u46-marker')
    // The shell's file click builds this tab (unit suite proves the pane mounts).
    const tab = cloudSimpleWorkspaceFileTab('README.md')
    expect(tab).toMatchObject({ kind: 'editor', path: 'README.md' })

    saveEvidence('e3-file-tree-open.json', { rootListing, read, tab })
  }, 120_000)

  it('E4 编辑保存：files.write 后 files.read 逐字读回，再写入原文', async () => {
    const opened = await bridge.openWorkspace(projectId)
    if (!opened.ok || !opened.workspacePath) {
      throw new Error(`open failed: ${JSON.stringify(opened)}`)
    }
    const rpc = (method: string, params?: Record<string, unknown>) =>
      bridge.rpc(method, params ?? {}, projectId)
    const original = await rpc('files.read', {
      worktree: cloudWorktreeSelector(opened.workspacePath),
      relativePath: 'README.md'
    })
    const base = readString(original.ok ? original.result : null, 'content') ?? ''
    const edited = `${base}\nU46-8 edited line\n`
    // U48: the adapter names the host in the payload, so the real host accepts the save.
    const adapterWrite = await writeCloudWorkspaceFile(
      rpc,
      opened.workspacePath,
      'README.md',
      edited
    )
    expect(adapterWrite.ok, JSON.stringify(adapterWrite)).toBe(true)

    const reread = await rpc('files.read', {
      worktree: cloudWorktreeSelector(opened.workspacePath),
      relativePath: 'README.md'
    })
    expect(readString(reread.ok ? reread.result : null, 'content')).toBe(edited)

    const restored = await writeCloudWorkspaceFile(rpc, opened.workspacePath, 'README.md', base)
    expect(restored.ok, JSON.stringify(restored)).toBe(true)

    // F-04 (§6.2 E4): a write outside the workspace root is refused by the
    // cloud boundary (an absolute path can never be inside it) and audited.
    const denied = await rpc('files.write', {
      worktree: cloudWorktreeSelector(opened.workspacePath),
      relativePath: '/etc/orca-u46-8-escape.txt',
      content: 'escaped',
      expectedExecutionHostId: 'local'
    })
    expect(denied.ok, JSON.stringify(denied)).toBe(false)
    if (!denied.ok) {
      expect(denied.code).toBe('forbidden')
    }
    await admission.client!.refresh()
    const denialAudit = await fetch(
      `${platform.url}/v1/audit/events?eventType=host.path_denied&limit=100`,
      { headers: { authorization: `Bearer ${adminToken}` } }
    )
    const denialEvents = readField(await denialAudit.json(), 'events')
    const writeDenial = (Array.isArray(denialEvents) ? denialEvents : []).find(
      (event) => readString(readField(event, 'metadata'), 'method') === 'files.write'
    )
    expect(writeDenial, JSON.stringify(denialEvents)).toBeTruthy()

    saveEvidence('e4-edit-save.json', {
      adapterWrite,
      reread: edited,
      restored,
      writeDenied: denied,
      writeDenialAudited: Boolean(writeDenial)
    })
  }, 120_000)

  it('E5 预览数据：markdown 文本、真实图片 base64+mime、HTML 文本（§6.2 E3，F-04）', async () => {
    const opened = await bridge.openWorkspace(projectId)
    if (!opened.ok || !opened.workspacePath) {
      throw new Error(`open failed: ${JSON.stringify(opened)}`)
    }
    const rpc = (method: string, params?: Record<string, unknown>) =>
      bridge.rpc(method, params ?? {}, projectId)
    const preview = await previewCloudFile(rpc, opened.workspacePath, 'README.md')
    expect(preview.ok, JSON.stringify(preview)).toBe(true)
    if (preview.ok) {
      expect(preview.preview.isBinary).toBe(false)
      expect(preview.preview.content).toContain('# u46-marker.txt')
    }

    const image = await previewCloudFile(rpc, opened.workspacePath, 'logo.png')
    expect(image.ok, JSON.stringify(image)).toBe(true)
    if (image.ok) {
      expect(image.preview.isBinary).toBe(true)
      expect(image.preview.isImage).toBe(true)
      expect(image.preview.mimeType).toBe('image/png')
      expect(Buffer.from(image.preview.content, 'base64').equals(PNG_ONE_PIXEL)).toBe(true)
    }

    const html = await previewCloudFile(rpc, opened.workspacePath, 'page.html')
    expect(html.ok, JSON.stringify(html)).toBe(true)
    if (html.ok) {
      expect(html.preview.isBinary).toBe(false)
      expect(html.preview.content).toContain('u46-marker.txt-html')
    }

    saveEvidence('e5-markdown-preview.json', { preview, image, html })
  }, 120_000)

  it('E6 Git 变更、提交展开与 diff：status/history/commitCompare/diff 全部落在真仓库', async () => {
    const opened = await bridge.openWorkspace(projectId)
    if (!opened.ok || !opened.workspacePath) {
      throw new Error(`open failed: ${JSON.stringify(opened)}`)
    }
    const rpc = (method: string, params?: Record<string, unknown>) =>
      bridge.rpc(method, params ?? {}, projectId)
    const before = await rpc('files.read', {
      worktree: cloudWorktreeSelector(opened.workspacePath),
      relativePath: 'README.md'
    })
    const original = readString(before.ok ? before.result : null, 'content')
    await rpc('files.write', {
      worktree: cloudWorktreeSelector(opened.workspacePath),
      relativePath: 'README.md',
      content: `${original ?? ''}\ndiff me\n`,
      expectedExecutionHostId: 'local'
    })

    const status = await rpc('git.status', {
      worktree: cloudWorktreeSelector(opened.workspacePath)
    })
    expect(status.ok, JSON.stringify(status)).toBe(true)
    const entries = readField(status.ok ? status.result : null, 'entries')
    const changed = (Array.isArray(entries) ? entries : []).find(
      (entry) => readString(entry, 'path') === 'README.md'
    )
    expect(changed, JSON.stringify(entries)).toBeTruthy()

    const history = await rpc('git.history', {
      worktree: cloudWorktreeSelector(opened.workspacePath),
      limit: 10
    })
    expect(history.ok, JSON.stringify(history)).toBe(true)
    const items = readField(history.ok ? history.result : null, 'items')
    const first = Array.isArray(items) ? items[0] : null
    const commitId = readString(first, 'id')
    expect(commitId).toBeTruthy()
    if (commitId === null) {
      throw new Error('history has no commit')
    }
    const compare = await rpc('git.commitCompare', {
      worktree: cloudWorktreeSelector(opened.workspacePath),
      commitId
    })
    expect(compare.ok, JSON.stringify(compare)).toBe(true)
    const commitFiles = readField(compare.ok ? compare.result : null, 'entries')
    expect(Array.isArray(commitFiles)).toBe(true)

    const diff = await rpc('git.diff', {
      worktree: cloudWorktreeSelector(opened.workspacePath),
      filePath: 'README.md',
      staged: false,
      compareAgainstHead: true
    })
    expect(diff.ok, JSON.stringify(diff)).toBe(true)

    // F-05 (U50): the commit row's diff rides git.commitDiff on the real repo.
    const commitDiff = await rpc('git.commitDiff', {
      worktree: cloudWorktreeSelector(opened.workspacePath),
      filePath: 'README.md',
      commitOid: commitId
    })
    expect(commitDiff.ok, JSON.stringify(commitDiff)).toBe(true)
    expect(readField(commitDiff.ok ? commitDiff.result : null, 'kind')).toBe('text')
    expect(readString(commitDiff.ok ? commitDiff.result : null, 'modifiedContent')).toContain(
      'u46-marker'
    )

    await rpc('files.write', {
      worktree: cloudWorktreeSelector(opened.workspacePath),
      relativePath: 'README.md',
      content: original ?? '',
      expectedExecutionHostId: 'local'
    })
    saveEvidence('e6-git-diff.json', {
      status,
      history,
      compare,
      diff,
      commitDiff
    })
  }, 120_000)

  it('E7 权限降级（viewer 票据）：无 workspacePath、终端拒绝带审计、文件仍可读', async () => {
    const opened = await bridge.openProject(viewerProjectId)
    expect(opened.ok, JSON.stringify(opened)).toBe(true)
    if (!opened.ok) {
      throw new Error('viewer project_connect must succeed')
    }
    expect(opened.permissions ?? []).toEqual(expect.arrayContaining(['open', 'file:read']))
    expect(opened.permissions ?? []).not.toContain('terminal')
    expect(opened.workspacePath).toBeUndefined()

    const refused = await bridge.rpc(
      'terminal.create',
      { worktree: cloudWorktreeSelector(viewerRoot), title: 'u46-viewer' },
      viewerProjectId
    )
    expect(refused.ok).toBe(false)
    if (!refused.ok) {
      expect(refused.code).toBe('forbidden')
    }

    const listing = await bridge.rpc(
      'files.readDir',
      { worktree: cloudWorktreeSelector(viewerRoot), relativePath: '' },
      viewerProjectId
    )
    expect(listing.ok, JSON.stringify(listing)).toBe(true)

    await admission.client!.refresh()
    const audited = await fetch(`${platform.url}/v1/audit/events?eventType=host.method_denied`, {
      headers: { authorization: `Bearer ${adminToken}` }
    })
    const events = readField(await audited.json(), 'events')
    const matches = (Array.isArray(events) ? events : []).filter(
      (event) =>
        readString(readField(event, 'metadata'), 'method') === 'terminal.create' &&
        readString(readField(event, 'metadata'), 'denial') === 'PERMISSION_MISSING'
    )
    expect(matches.length, JSON.stringify(events)).toBeGreaterThan(0)

    await bridge.closeProject(viewerProjectId)
    saveEvidence('e7-viewer-degraded.json', {
      opened,
      refused,
      listing,
      auditMatches: matches
    })
  }, 120_000)
})
