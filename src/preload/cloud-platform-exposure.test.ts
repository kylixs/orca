import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLOUD_PLATFORM_IPC } from '../shared/cloud-platform-ipc'

const ipc = vi.hoisted(() => ({
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn()
}))

vi.mock('electron', () => ({ ipcRenderer: ipc }))

/**
 * Every build exposes the bridge (W11): the native shell keeps a permanent
 * sign-in button, so even a dev build with no platform address carries the
 * `cloud` member — main answers `PLATFORM_ADDRESS_REQUIRED` when it has no
 * address instead of the bridge being absent.
 */
describe('cloud platform preload exposure', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(async () => {
    vi.resetModules()
  })

  it('exposes the bridge unconditionally, on the channels main registers', async () => {
    const { cloudPlatformExposure } = await import('./cloud-platform-exposure')

    const cloud = cloudPlatformExposure().cloud
    expect(cloud).toBeDefined()
    if (!cloud) {
      throw new Error('cloud bridge missing')
    }

    await cloud.login('zhangsan', 'Passw0rd!', 'https://cloud.example')
    expect(ipc.invoke).toHaveBeenCalledWith(
      CLOUD_PLATFORM_IPC.login,
      'zhangsan',
      'Passw0rd!',
      'https://cloud.example'
    )

    await cloud.getLoginContext()
    expect(ipc.invoke).toHaveBeenCalledWith(CLOUD_PLATFORM_IPC.loginContext)

    const unsubscribe = cloud.onConnectionChanged(() => undefined)
    expect(ipc.on).toHaveBeenCalledWith(CLOUD_PLATFORM_IPC.connectionChanged, expect.any(Function))
    unsubscribe()
    expect(ipc.removeListener).toHaveBeenCalledWith(
      CLOUD_PLATFORM_IPC.connectionChanged,
      ipc.on.mock.calls[0][1]
    )
  })
})
