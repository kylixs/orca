import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { parseJsonText } from '../../shared/json-fields'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { Store } from '../persistence/loading-store/store'
import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import {
  attachRuntimeToCloudAdmission,
  type AttachableCloudAdmission
} from '../startup/cloud-runtime-attach'
import { createCloudAgentClient, type CloudAgentClient } from './cloud-agent-client'
import { PROVISIONING_README, git, makeBareRepository } from './cloud-project-provisioning-fixture'

/**
 * U37-B: the host executes the heartbeat's `provisionAssignments` outside any
 * ticket. Real agent client, real runtime server, real git clone — only the
 * platform's HTTP responses are scripted, since the platform half is U37-A.
 */

type IpcHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>
const ipcHandlers = vi.hoisted(() => new Map<string, IpcHandler>())

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => ipcHandlers.set(channel, handler),
    removeHandler: (channel: string) => ipcHandlers.delete(channel)
  },
  BrowserWindow: { getAllWindows: () => [] },
  app: { isPackaged: false }
}))

const PROJECT_ID = 'proj_u37kick01'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

/** Scripted control plane: one JWKS endpoint and a heartbeat whose response we shape per beat. */
function startFakePlatform(): {
  assignments: unknown
  bodies: Record<string, unknown>[]
  fetchImpl: typeof fetch
} {
  // One mutable object: the fetch closure and the test must see the same beat state.
  const platform: {
    assignments: unknown
    bodies: Record<string, unknown>[]
    fetchImpl: typeof fetch
  } = { assignments: undefined, bodies: [], fetchImpl: () => Promise.reject(new Error('unwired')) }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub answers only the two endpoints this client calls, with real Response objects.
  platform.fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url)
    if (target.endsWith('/v1/jwks')) {
      return jsonResponse({ keys: [] })
    }
    const body = parseJsonText(typeof init?.body === 'string' ? init.body : '')
    platform.bodies.push((body ?? {}) as Record<string, unknown>)
    return jsonResponse({
      policyVersion: 1,
      policies: {},
      revoked: { users: [], projects: [], devices: [], jtis: [] },
      ...(platform.assignments === undefined ? {} : { provisionAssignments: platform.assignments })
    })
  }) as typeof fetch
  return platform
}

function kickClient(fetchImpl: typeof fetch, hostId: string): CloudAgentClient {
  return createCloudAgentClient({
    apiUrl: 'https://platform.test',
    internalToken: 'unused',
    hostId,
    hostName: 'dev-u37-kick',
    fetchImpl,
    heartbeat: { hostId, credential: 'credential' }
  })
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`condition not reached: ${what}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

let base = ''
let bareRepo = ''
let checkoutPath = ''
let client: CloudAgentClient | null = null
let runtimeRpc: OrcaRuntimeRpcServer | null = null
let platform: ReturnType<typeof startFakePlatform>

beforeAll(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-u37-kick-')))
  bareRepo = makeBareRepository(base)
  checkoutPath = join(base, 'checkout', 'payment-service')

  installFakeAppEnvironment()
  const store = createSqliteTestStore(Store, {
    dataFile: join(mkdtempSync(join(tmpdir(), 'orca-u37-kick-data-')), 'orca-data.json')
  })
  store.updateSettings({ workspaceDir: join(base, 'host-workspaces') })
  store.flushOrThrow()

  // Production attach target: the RPC server is what `attachCloudRuntime` receives.
  runtimeRpc = new OrcaRuntimeRpcServer({
    runtime: new OrcaRuntimeService(store),
    userDataPath: mkdtempSync(join(tmpdir(), 'orca-u37-kick-runtime-')),
    enableWebSocket: true,
    wsPort: 0
  })
  await runtimeRpc.start()

  platform = startFakePlatform()
  client = kickClient(platform.fetchImpl, 'host_u37_kick')
  const admission: AttachableCloudAdmission = {
    bindRuntime: () => undefined,
    client,
    ready: Promise.resolve()
  }
  attachRuntimeToCloudAdmission(runtimeRpc, admission)
}, 60_000)

afterAll(async () => {
  client?.stop()
  await runtimeRpc?.stop()
  await closeTestStores()
})

describe('U37 宿主执行器（真实 client + 真实 Runtime Server + 真实 git）', () => {
  it('① 有指派：票据外真实 clone，下一拍心跳携带 ok 回报', async () => {
    if (!client) {
      throw new Error('client missing')
    }
    platform.assignments = [
      { projectId: PROJECT_ID, path: checkoutPath, repoUrl: bareRepo, defaultBranch: 'main' }
    ]
    await client.refresh()
    await waitFor(() => existsSync(join(checkoutPath, 'README.md')), 'clone to land')
    expect(readFileSync(join(checkoutPath, 'README.md'), 'utf8')).toBe(PROVISIONING_README)
    expect(realpathSync(git(checkoutPath, 'rev-parse', '--show-toplevel').trim())).toBe(
      realpathSync(checkoutPath)
    )
    expect(git(checkoutPath, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main')

    // 下一拍：回报上行，指派随平台翻转 ready 而消失。
    platform.bodies.length = 0
    platform.assignments = undefined
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await client.refresh()
      if (Array.isArray((platform.bodies.at(-1) ?? {}).provisioned)) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const beat = platform.bodies.at(-1) ?? {}
    expect(beat.provisioned).toEqual([{ projectId: PROJECT_ID, ok: true }])
  }, 60_000)

  it('⑤ 旧平台（响应无该字段）：零行为——无派发、无克隆、无回报', async () => {
    if (!client) {
      throw new Error('client missing')
    }
    // 排空 ① 可能遗留的队列，再证明无字段的一拍什么都不带。
    await client.refresh()
    await client.refresh()
    const seen: string[] = []
    const off = client.onProvisionAssignment((assignment) => seen.push(assignment.projectId))
    platform.bodies.length = 0
    platform.assignments = undefined
    try {
      await client.refresh()
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(seen).toEqual([])
      expect(platform.bodies.at(-1)?.provisioned).toBeUndefined()
    } finally {
      off()
    }
  })

  it('⑥ 监听器抛错被吸收：refresh 正常完成，其余监听器照常收到指派', async () => {
    const isolated = kickClient(platform.fetchImpl, 'host_u37_listener')
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const seen: string[] = []
    const offBad = isolated.onProvisionAssignment(() => {
      throw new Error('listener boom')
    })
    const offGood = isolated.onProvisionAssignment((assignment) => seen.push(assignment.projectId))
    try {
      platform.assignments = [
        {
          projectId: 'proj_listener',
          path: '/srv/orca-projects/listener',
          repoUrl: 'https://git.example.com/pay/listener.git',
          defaultBranch: 'main'
        }
      ]
      await expect(isolated.refresh()).resolves.toBeUndefined()
      expect(seen).toEqual(['proj_listener'])
      // 心跳循环未被破坏：下一拍照常上行。
      platform.assignments = undefined
      await isolated.refresh()
      expect(isolated.snapshot().lastError).toBeNull()
    } finally {
      offBad()
      offGood()
      consoleWarn.mockRestore()
      isolated.stop()
    }
  })
})
