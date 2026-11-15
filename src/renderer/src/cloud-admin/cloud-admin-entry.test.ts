import { describe, expect, it } from 'vitest'
import type {
  CloudConnectionEvent,
  CloudOpenResult,
  CloudSessionState
} from '../../../shared/cloud-platform-ipc'
import { prepareCloudAdminEntry } from './cloud-admin-root'
import type { CloudBridge } from '../cloud/use-cloud-session'

/**
 * U59 P0: a second embed entry must spend its one-time code before the app
 * mounts. Mounting first lets the saved-session restore auto-open while the
 * exchange has nulled the in-memory session (NOT_SIGNED_IN).
 */

const SIGNED_IN: CloudSessionState = { status: 'signed-in', displayName: '张伟', projects: [] }

function bridgeWithHandoff(
  redeem: (code: string) => Promise<CloudSessionState>
): CloudBridge & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    login: async () => SIGNED_IN,
    loginWithHandoff: (code) => {
      calls.push(code)
      return redeem(code)
    },
    getLoginContext: async () => null,
    openWorkspace: async (): Promise<CloudOpenResult> => ({ ok: false, code: 'UNUSED' }),
    listProjects: async () => [],
    getState: async () => SIGNED_IN,
    logout: async () => ({ status: 'signed-out' }),
    openProject: async (): Promise<CloudOpenResult> => ({ ok: false, code: 'UNUSED' }),
    closeProject: async () => ({ ok: true }),
    rpc: async () => ({ ok: false, code: 'UNUSED' }),
    registerProjects: async () => ({ environments: [], failures: [], removedEnvironmentIds: [] }),
    retryPrepare: async () => ({ ok: false, code: 'UNUSED' }),
    createProject: async () => ({ ok: false, code: 'UNUSED' }),
    archiveProject: async () => ({ ok: false, code: 'UNUSED' }),
    listProvisionableHosts: async () => [],
    onConnectionChanged: (_listener: (event: CloudConnectionEvent) => void) => () => undefined
  }
}

describe('U59 P0 embed 二次打开', () => {
  it('兑换成功后才挂载，且挂载态不再携带 handoff code（跳过持久会话恢复）', async () => {
    let release: (state: CloudSessionState) => void = () => undefined
    const pending = new Promise<CloudSessionState>((resolve) => {
      release = resolve
    })
    const bridge = bridgeWithHandoff(() => pending)
    const mounted: unknown[] = []

    const mounting = prepareCloudAdminEntry(
      bridge,
      { projectId: 'p1', handoffCode: 'code-1' },
      (entry) => mounted.push(entry)
    )
    // The app must not mount while the exchange is in flight: that window is
    // exactly where the restore-driven auto-open used to read session=null.
    expect(mounted).toEqual([])
    expect(bridge.calls).toEqual(['code-1'])

    release(SIGNED_IN)
    await mounting
    expect(mounted).toEqual([{ projectId: 'p1', handoffCode: null }])
    expect(bridge.calls).toEqual(['code-1'])
  })

  it('兑换失败交还原 entry，由 app 渲染提示与登录表单', async () => {
    const bridge = bridgeWithHandoff(async () => {
      throw Object.assign(new Error('HANDOFF_GONE'), { code: 'HANDOFF_GONE' })
    })
    const mounted: unknown[] = []

    await prepareCloudAdminEntry(bridge, { projectId: 'p1', handoffCode: 'spent' }, (entry) =>
      mounted.push(entry)
    )
    expect(mounted).toEqual([{ projectId: 'p1', handoffCode: 'spent' }])
  })

  it('无一次性码（刷新/独立页）直接挂载，不发兑换', async () => {
    const bridge = bridgeWithHandoff(async () => SIGNED_IN)
    const mounted: unknown[] = []
    await prepareCloudAdminEntry(bridge, { projectId: 'p1', handoffCode: null }, (entry) =>
      mounted.push(entry)
    )
    expect(mounted).toEqual([{ projectId: 'p1', handoffCode: null }])
    expect(bridge.calls).toEqual([])
  })
})
