import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import {
  installBrowserGlobals,
  writeStoredCloudRuntimeEnvironment,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

/**
 * A cloud session's host refuses every `ui.*`/`settings.*` call, so the paired-host
 * dials the boot chain and preference writers would otherwise make are doomed RPC.
 */

function installRecordingCloudClient(): { runtimeCalls: { method: string; params: unknown }[] } {
  const runtimeCalls: { method: string; params: unknown }[] = []
  vi.doMock('./web-runtime-client', () => ({
    WebRuntimeClient: class {
      call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
        runtimeCalls.push({ method, params })
        return Promise.reject(new Error('cloud hosts refuse ui.*/settings.*'))
      }

      close(): void {}
    }
  }))
  return { runtimeCalls }
}

function installResolvingPairedClient(): { runtimeCalls: { method: string; params: unknown }[] } {
  const runtimeCalls: { method: string; params: unknown }[] = []
  vi.doMock('./web-runtime-client', () => ({
    WebRuntimeClient: class {
      call(method: string): Promise<RuntimeRpcResponse<unknown>> {
        runtimeCalls.push({ method, params: undefined })
        return Promise.resolve({
          id: method,
          ok: true,
          result: { ui: { rightSidebarOpen: true }, settings: { compactWorktreeCards: true } },
          _meta: { runtimeId: 'runtime-1' }
        })
      }

      close(): void {}
    }
  }))
  return { runtimeCalls }
}

describe('web ui/preferences preload API in cloud sessions', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
  })

  it('answers ui.get from the local store without dialing a cloud host', async () => {
    const { runtimeCalls } = installRecordingCloudClient()
    const globals = installBrowserGlobals('Linux')
    writeStoredCloudRuntimeEnvironment(globals.storage)
    globals.storage.setItem('orca.web.ui.v1', JSON.stringify({ rightSidebarOpen: true }))
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const ui = await globals.window.api.ui.get()

    expect(ui.rightSidebarOpen).toBe(true)
    expect(runtimeCalls).toEqual([])
  })

  it('persists ui.set and resolves setWithAck locally without dialing a cloud host', async () => {
    const { runtimeCalls } = installRecordingCloudClient()
    const globals = installBrowserGlobals('Linux')
    writeStoredCloudRuntimeEnvironment(globals.storage)
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    await globals.window.api.ui.set({ rightSidebarOpen: true })
    await expect(
      globals.window.api.ui.setWithAck!({ hideDefaultBranchWorkspace: true })
    ).resolves.toBeUndefined()

    expect(JSON.parse(globals.storage.getItem('orca.web.ui.v1') ?? '{}')).toMatchObject({
      rightSidebarOpen: true,
      hideDefaultBranchWorkspace: true
    })
    expect(runtimeCalls).toEqual([])
  })

  it('returns the optimistic interaction count from recordFeatureInteraction without dialing a cloud host', async () => {
    const { runtimeCalls } = installRecordingCloudClient()
    const globals = installBrowserGlobals('Linux')
    writeStoredCloudRuntimeEnvironment(globals.storage)
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const ui = await globals.window.api.ui.recordFeatureInteraction('tasks')

    expect(ui.featureInteractions?.tasks).toMatchObject({ interactionCount: 1 })
    expect(runtimeCalls).toEqual([])
  })

  it('answers settings.get from the local store without dialing a cloud host', async () => {
    const { runtimeCalls } = installRecordingCloudClient()
    const globals = installBrowserGlobals('Linux')
    writeStoredCloudRuntimeEnvironment(globals.storage)
    globals.storage.setItem(
      'orca.web.settings.v1',
      JSON.stringify({ rightSidebarOpenByDefault: true })
    )
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const settings = await globals.window.api.settings.get()

    expect(settings.rightSidebarOpenByDefault).toBe(true)
    // A cloud session has no host-owned visibility default, so the global default stands.
    expect(settings).not.toHaveProperty('worktreeVisibilityDefaults')
    expect(runtimeCalls).toEqual([])
  })

  it('persists settings.set locally without dialing a cloud host', async () => {
    const { runtimeCalls } = installRecordingCloudClient()
    const globals = installBrowserGlobals('Linux')
    writeStoredCloudRuntimeEnvironment(globals.storage)
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    await globals.window.api.settings.set({ compactWorktreeCards: true })

    expect(JSON.parse(globals.storage.getItem('orca.web.settings.v1') ?? '{}')).toMatchObject({
      compactWorktreeCards: true
    })
    expect(runtimeCalls).toEqual([])
  })

  it('applies bot-author overrides locally without dialing a cloud host', async () => {
    const { runtimeCalls } = installRecordingCloudClient()
    const globals = installBrowserGlobals('Linux')
    writeStoredCloudRuntimeEnvironment(globals.storage)
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const settings = await globals.window.api.settings.updatePRBotAuthorOverride({
      author: 'gretelflux',
      isBot: true
    })

    expect(settings.prBotAuthorOverrides).toEqual(['gretelflux'])
    expect(JSON.parse(globals.storage.getItem('orca.web.settings.v1') ?? '{}')).toMatchObject({
      prBotAuthorOverrides: ['gretelflux']
    })
    expect(runtimeCalls).toEqual([])
  })

  it('still dials the paired host for ui and settings reads outside cloud sessions', async () => {
    const { runtimeCalls } = installResolvingPairedClient()
    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const ui = await globals.window.api.ui.get()
    const settings = await globals.window.api.settings.get()

    expect(ui.rightSidebarOpen).toBe(true)
    expect(settings.compactWorktreeCards).toBe(true)
    expect(runtimeCalls).toEqual([
      { method: 'ui.get', params: undefined },
      { method: 'settings.get', params: undefined }
    ])
  })
})
