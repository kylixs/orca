// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearWebHandoffFromAddressBar,
  enterWorkspaceViaWebHandoff,
  readWebCloudApiUrlFromLocation,
  readWebCloudHandoffEntry,
  useWebCloudHandoffEntry,
  webCloudHandoffFailureNotice
} from './web-cloud-handoff-entry'
import { WebCloudSessionError } from './web-cloud-error'
import type * as WebCloudSessionModule from './web-cloud-session'
import type * as WebCloudConnectModule from './web-cloud-connect'
import type * as WebCloudSessionStorageModule from './web-cloud-session-storage'
import { WEB_CLOUD_SESSION_STORAGE_KEY as SESSION_KEY } from './web-cloud-session-storage'
import { readStoredWebRuntimeEnvironment } from './web-runtime-environment'
import { WebCloudConnectError, WEB_CLOUD_CONNECT_ERROR_CODE } from './web-cloud-connect'

const redeemMock = vi.hoisted(() => ({ redeemWebHandoff: vi.fn() }))
const connectMock = vi.hoisted(() => ({ connectCloudProjectWithSession: vi.fn() }))
const adoptMock = vi.hoisted(() => ({ adoptWebRuntimeClient: vi.fn() }))
const deviceKeyMock = vi.hoisted(() => ({
  createLocalStorageWebCloudDeviceKey: vi.fn(),
  loadOrCreateWebCloudDeviceKey: vi.fn()
}))
const sessionStorageMock = vi.hoisted(() => ({
  createBrowserWebCloudSessionStorage: vi.fn()
}))

vi.mock('./web-cloud-session', async (importOriginal) => {
  const actual = await importOriginal<typeof WebCloudSessionModule>()
  return { ...actual, redeemWebHandoff: redeemMock.redeemWebHandoff }
})
vi.mock('./web-cloud-connect', async (importOriginal) => {
  const actual = await importOriginal<typeof WebCloudConnectModule>()
  return { ...actual, connectCloudProjectWithSession: connectMock.connectCloudProjectWithSession }
})
vi.mock('./preload-api/web-runtime-session', () => ({
  adoptWebRuntimeClient: adoptMock.adoptWebRuntimeClient
}))
vi.mock('./web-cloud-device-key', () => ({
  createLocalStorageWebCloudDeviceKey: deviceKeyMock.createLocalStorageWebCloudDeviceKey,
  loadOrCreateWebCloudDeviceKey: deviceKeyMock.loadOrCreateWebCloudDeviceKey
}))
vi.mock('./web-cloud-session-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof WebCloudSessionStorageModule>()
  return {
    ...actual,
    createBrowserWebCloudSessionStorage: sessionStorageMock.createBrowserWebCloudSessionStorage
  }
})

const ENTRY = {
  code: 'code-123',
  projectId: 'proj_1234abcd',
  apiUrl: 'https://cloud.example.com'
}

/** The storage seam is keyed by the module; this records what it wrote. */
class RecordingStorage {
  readonly values = new Map<string, string>()
  read = (): string | null => this.values.get(SESSION_KEY) ?? null
  write = (value: string): void => {
    this.values.set(SESSION_KEY, value)
  }
  remove = (): void => {
    this.values.delete(SESSION_KEY)
  }
}

function storages(): {
  device: { read: () => string | null; write: (value: string) => void }
  session: RecordingStorage
} {
  return {
    device: {
      read: () => null,
      write: () => undefined
    },
    session: new RecordingStorage()
  }
}

beforeEach(() => {
  redeemMock.redeemWebHandoff.mockReset()
  connectMock.connectCloudProjectWithSession.mockReset()
  adoptMock.adoptWebRuntimeClient.mockReset()
  deviceKeyMock.createLocalStorageWebCloudDeviceKey.mockReset()
  sessionStorageMock.createBrowserWebCloudSessionStorage.mockReset()
  deviceKeyMock.createLocalStorageWebCloudDeviceKey.mockReturnValue({
    publicKeyB64: 'device-public-key',
    secretKeyB64: 'device-secret-key'
  })
  deviceKeyMock.loadOrCreateWebCloudDeviceKey.mockReturnValue({
    publicKeyB64: 'device-public-key',
    secretKeyB64: 'device-secret-key'
  })
  sessionStorageMock.createBrowserWebCloudSessionStorage.mockReturnValue(new RecordingStorage())
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
})

describe('handoff 入口地址栏（FR-3.10 hash 用后即清）', () => {
  it('reads code, project and platform address out of the entry URL', () => {
    expect(
      readWebCloudHandoffEntry({
        hash: '#handoff=abc123&project=proj_1',
        search: '?api=https%3A%2F%2Fcloud.example.com'
      })
    ).toEqual({ code: 'abc123', projectId: 'proj_1', apiUrl: 'https://cloud.example.com' })
  })

  it('tolerates hash order and trailing platform slashes, rejects missing halves', () => {
    expect(
      readWebCloudHandoffEntry({
        hash: '#project=proj_1&handoff=abc',
        search: '?api=https://cloud.example.com/'
      })
    ).toEqual({ code: 'abc', projectId: 'proj_1', apiUrl: 'https://cloud.example.com' })
    expect(readWebCloudHandoffEntry({ hash: '#handoff=abc', search: '' })).toBeNull()
    expect(
      readWebCloudHandoffEntry({ hash: '', search: '?api=https://cloud.example.com' })
    ).toBeNull()
  })

  it('wipes the hash but keeps ?api= for the fallback form prefill', () => {
    window.history.replaceState(
      null,
      '',
      '/web-index.html?api=https://cloud.example.com#handoff=abc&project=proj_1'
    )
    clearWebHandoffFromAddressBar()
    expect(window.location.hash).toBe('')
    expect(window.location.search).toBe('?api=https://cloud.example.com')
  })

  it('reads ?api= even without a handoff code, for the sign-in form prefill', () => {
    expect(
      readWebCloudApiUrlFromLocation({ search: '?api=https%3A%2F%2Fcloud.example.com/' })
    ).toBe('https://cloud.example.com')
    expect(readWebCloudApiUrlFromLocation({ search: '?api=' })).toBeNull()
    expect(readWebCloudApiUrlFromLocation({ search: '' })).toBeNull()
  })
})

describe('handoff 失败提示（410/403/网络/无项目分别提示）', () => {
  it('maps the platform codes and the local fallback', () => {
    expect(
      webCloudHandoffFailureNotice(new WebCloudSessionError('HANDOFF_GONE', 'x', 410))
    ).toContain('expired or was already used')
    expect(
      webCloudHandoffFailureNotice(new WebCloudSessionError('PROJECT_FORBIDDEN', 'x', 403))
    ).toContain('no longer has access')
    expect(
      webCloudHandoffFailureNotice(new WebCloudSessionError('network_error', 'x', null))
    ).toContain('cannot be reached')
    expect(
      webCloudHandoffFailureNotice(
        new WebCloudConnectError(WEB_CLOUD_CONNECT_ERROR_CODE.noProjects, 'x')
      )
    ).toContain('not visible to your account')
    expect(webCloudHandoffFailureNotice(new Error('boom'))).toContain(
      'could not be opened automatically'
    )
  })
})

describe('enterWorkspaceViaWebHandoff（换发→打开项目→落存储）', () => {
  it('exchanges, persists the session and reports the opened workspace', async () => {
    const session = {
      apiUrl: ENTRY.apiUrl,
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      deviceId: 'device-1',
      user: { displayName: '张三' }
    }
    redeemMock.redeemWebHandoff.mockResolvedValue(session)
    connectMock.connectCloudProjectWithSession.mockResolvedValue({
      projectName: 'Payment Service',
      runtimeId: 'runtime-1',
      client: { close: vi.fn() },
      environment: { id: 'web-env-1', name: 'Payment Service (cloud session)' }
    })
    const stores = storages()

    const result = await enterWorkspaceViaWebHandoff({
      entry: ENTRY,
      deviceKeyStore: stores.device,
      sessionStorage: stores.session
    })

    expect(result).toEqual({
      status: 'entered',
      projectName: 'Payment Service',
      runtimeId: 'runtime-1'
    })
    expect(redeemMock.redeemWebHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        apiUrl: ENTRY.apiUrl,
        code: ENTRY.code,
        devicePublicKeyB64: 'device-public-key',
        deviceName: 'Orca Web'
      })
    )
    // The connect tail opens the named project with the exchanged session.
    expect(connectMock.connectCloudProjectWithSession).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({ deviceId: 'device-1' }),
        projectId: ENTRY.projectId,
        deviceSecretKeyB64: 'device-secret-key'
      })
    )
    // The App is handed the live socket, and the saved session record is there.
    expect(adoptMock.adoptWebRuntimeClient).toHaveBeenCalledTimes(1)
    expect(JSON.parse(stores.session.values.get(SESSION_KEY) ?? '{}')).toMatchObject({
      apiUrl: ENTRY.apiUrl,
      deviceId: 'device-1',
      displayName: '张三'
    })
  })

  it('reuses the persisted device id so one browser stays one device row', async () => {
    const session = {
      apiUrl: ENTRY.apiUrl,
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      deviceId: 'device-9',
      user: { displayName: '张三' }
    }
    redeemMock.redeemWebHandoff.mockResolvedValue(session)
    connectMock.connectCloudProjectWithSession.mockResolvedValue({
      projectName: 'P',
      runtimeId: 'runtime-2',
      client: { close: vi.fn() },
      environment: { id: 'web-env-2', name: 'P (cloud session)' }
    })
    const stores = storages()
    stores.session.values.set(
      SESSION_KEY,
      JSON.stringify({
        version: 1,
        apiUrl: ENTRY.apiUrl,
        accessToken: 'old',
        refreshToken: 'old',
        deviceId: 'device-9',
        displayName: '张三',
        savedAtMs: 1
      })
    )

    await enterWorkspaceViaWebHandoff({
      entry: ENTRY,
      deviceKeyStore: stores.device,
      sessionStorage: stores.session
    })

    expect(redeemMock.redeemWebHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 'device-9' })
    )
  })

  it('falls back to the sign-in form on a spent code, without touching the session record', async () => {
    redeemMock.redeemWebHandoff.mockRejectedValue(
      new WebCloudSessionError('HANDOFF_GONE', '交接码无效或已使用。', 410)
    )
    const stores = storages()

    const result = await enterWorkspaceViaWebHandoff({
      entry: ENTRY,
      deviceKeyStore: stores.device,
      sessionStorage: stores.session
    })

    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.notice).toContain('expired or was already used')
      expect(result.apiUrl).toBe(ENTRY.apiUrl)
    }
    expect(connectMock.connectCloudProjectWithSession).not.toHaveBeenCalled()
    expect(adoptMock.adoptWebRuntimeClient).not.toHaveBeenCalled()
    expect(stores.session.values.has(SESSION_KEY)).toBe(false)
  })

  it('prefills nothing when the entry URL carried no platform address', async () => {
    const result = await enterWorkspaceViaWebHandoff({
      entry: { code: 'c', projectId: 'proj_1', apiUrl: '' },
      deviceKeyStore: storages().device,
      sessionStorage: new RecordingStorage()
    })
    expect(result).toEqual({
      status: 'failed',
      notice: webCloudHandoffFailureNotice(null),
      apiUrl: ''
    })
    expect(redeemMock.redeemWebHandoff).not.toHaveBeenCalled()
  })
})

describe('enterWorkspaceViaWebHandoff 超时（平台挂起回落登录表单，不在进入屏无限等待）', () => {
  const lateSession = {
    apiUrl: ENTRY.apiUrl,
    accessToken: 'access-late',
    refreshToken: 'refresh-late',
    deviceId: 'device-late',
    user: { displayName: '张三' }
  }

  it('gives up on a hung platform and falls back to the sign-in form', async () => {
    let resolveRedeem!: (value: unknown) => void
    redeemMock.redeemWebHandoff.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRedeem = resolve
        })
    )
    const stores = storages()

    const result = await enterWorkspaceViaWebHandoff({
      entry: ENTRY,
      deviceKeyStore: stores.device,
      sessionStorage: stores.session,
      timeoutMs: 10
    })

    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.notice).toContain('cannot be reached')
      expect(result.apiUrl).toBe(ENTRY.apiUrl)
    }

    // A late exchange lands behind the fallback form and works on nothing.
    resolveRedeem(lateSession)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(connectMock.connectCloudProjectWithSession).not.toHaveBeenCalled()
    expect(adoptMock.adoptWebRuntimeClient).not.toHaveBeenCalled()
    expect(stores.session.values.has(SESSION_KEY)).toBe(false)
  })

  it('closes a workspace socket that opens after the deadline', async () => {
    redeemMock.redeemWebHandoff.mockResolvedValue(lateSession)
    let resolveConnect!: (value: unknown) => void
    connectMock.connectCloudProjectWithSession.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveConnect = resolve
        })
    )
    const client = { close: vi.fn() }
    const stores = storages()

    const result = await enterWorkspaceViaWebHandoff({
      entry: ENTRY,
      deviceKeyStore: stores.device,
      sessionStorage: stores.session,
      timeoutMs: 10
    })
    expect(result.status).toBe('failed')

    resolveConnect({
      projectName: 'Payment Service',
      runtimeId: 'runtime-late',
      client,
      environment: { id: 'web-env-late', name: 'Payment Service (cloud session)' }
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(client.close).toHaveBeenCalledTimes(1)
    expect(adoptMock.adoptWebRuntimeClient).not.toHaveBeenCalled()
    // The workspace that lost the race never reaches the App's preload layer.
    expect(readStoredWebRuntimeEnvironment()).toBeNull()
  })
})

describe('useWebCloudHandoffEntry（启动一次，失败回落表单）', () => {
  it('moves idle → entering → failed and never calls onEntered', async () => {
    redeemMock.redeemWebHandoff.mockRejectedValue(
      new WebCloudSessionError('HANDOFF_GONE', 'gone', 410)
    )
    const onEntered = vi.fn()
    const { result } = renderHook(() => useWebCloudHandoffEntry(onEntered))
    expect(result.current.state.status).toBe('idle')

    act(() => {
      result.current.begin(ENTRY)
    })
    expect(result.current.state.status).toBe('entering')
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.state).toEqual({
      status: 'failed',
      notice: expect.stringContaining('expired or was already used'),
      apiUrl: ENTRY.apiUrl
    })
    expect(onEntered).not.toHaveBeenCalled()
    // The browser wiring was used for both stores.
    expect(deviceKeyMock.createLocalStorageWebCloudDeviceKey).toHaveBeenCalledTimes(1)
    expect(sessionStorageMock.createBrowserWebCloudSessionStorage).toHaveBeenCalledTimes(1)
  })

  it('signals onEntered when the workspace opened', async () => {
    redeemMock.redeemWebHandoff.mockResolvedValue({
      apiUrl: ENTRY.apiUrl,
      accessToken: 'a',
      refreshToken: 'r',
      deviceId: 'd',
      user: { displayName: 'x' }
    })
    connectMock.connectCloudProjectWithSession.mockResolvedValue({
      projectName: 'P',
      runtimeId: 'runtime-3',
      client: { close: vi.fn() },
      environment: { id: 'web-env-3', name: 'P (cloud session)' }
    })
    const onEntered = vi.fn()
    const { result } = renderHook(() => useWebCloudHandoffEntry(onEntered))

    act(() => {
      result.current.begin(ENTRY)
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.state.status).toBe('entering')
    expect(onEntered).toHaveBeenCalledTimes(1)
  })
})
