import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CLOUD_PLATFORM_IPC } from '../shared/cloud-platform-ipc'

const ipc = vi.hoisted(() => ({
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn()
}))

vi.mock('electron', () => ({ ipcRenderer: ipc }))

/**
 * The bridge must advertise exactly the channels main registers. Main registers
 * them only when ORCA_CLOUD_API_URL is set, so an ordinary desktop build must
 * see no `cloud` member at all.
 */
describe('cloud platform preload exposure', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('omits the bridge when the platform URL is not configured', async () => {
    const { cloudPlatformExposure } = await import('./cloud-platform-exposure')

    expect('cloud' in cloudPlatformExposure({})).toBe(false)
    expect('cloud' in cloudPlatformExposure({ ORCA_CLOUD_API_URL: '' })).toBe(false)
  })

  it('exposes the bridge when the platform URL is configured', async () => {
    const { cloudPlatformExposure } = await import('./cloud-platform-exposure')

    const cloud = cloudPlatformExposure({ ORCA_CLOUD_API_URL: 'https://cloud.example' }).cloud
    expect(cloud).toBeDefined()
    if (!cloud) {
      throw new Error('cloud bridge missing')
    }

    await cloud.openWorkspace('project-1')
    expect(ipc.invoke).toHaveBeenCalledWith(CLOUD_PLATFORM_IPC.openWorkspace, 'project-1')

    await cloud.login('zhangsan', 'Passw0rd!')
    expect(ipc.invoke).toHaveBeenCalledWith(CLOUD_PLATFORM_IPC.login, 'zhangsan', 'Passw0rd!')

    const unsubscribe = cloud.onConnectionChanged(() => undefined)
    expect(ipc.on).toHaveBeenCalledWith(CLOUD_PLATFORM_IPC.connectionChanged, expect.any(Function))
    unsubscribe()
    expect(ipc.removeListener).toHaveBeenCalledWith(
      CLOUD_PLATFORM_IPC.connectionChanged,
      ipc.on.mock.calls[0][1]
    )
  })
})
