import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLOUD_PLATFORM_IPC } from '../shared/cloud-platform-ipc'

const ipc = vi.hoisted(() => ({
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn()
}))

vi.mock('electron', () => ({ ipcRenderer: ipc }))

/**
 * Why re-import the flags module: afterEach's vi.resetModules() drops the
 * previous instance, so the stub must land in the same registry the exposure
 * module is loaded from.
 */
async function stubBuildFlags(
  input: { defaultUrl?: string | null; managed?: boolean } | null
): Promise<void> {
  const flags = await import('../shared/cloud-build-flags')
  flags.stubCloudBuildFlagsForTests(input)
}

afterEach(async () => {
  await stubBuildFlags(null)
  vi.resetModules()
})

/**
 * The bridge must advertise exactly the channels main registers. Main registers
 * them only for cloud builds — the runtime env address, or the build-injected
 * default platform address, or the managed-build switch — so an ordinary desktop
 * build must see no `cloud` member at all.
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

  it('exposes the bridge with no env when the build baked in a platform address', async () => {
    await stubBuildFlags({ defaultUrl: 'https://baked.example.com' })
    const { cloudPlatformExposure } = await import('./cloud-platform-exposure')

    expect('cloud' in cloudPlatformExposure({})).toBe(true)

    await stubBuildFlags({ managed: true })
    expect('cloud' in cloudPlatformExposure({})).toBe(true)
  })
})
