// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebConnect from './WebConnect'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const cloudMock = vi.hoisted(() => ({ connectCloudProject: vi.fn() }))
const sessionMock = vi.hoisted(() => ({ adoptWebRuntimeClient: vi.fn() }))
const runtimeMock = vi.hoisted(() => ({ call: vi.fn(), close: vi.fn() }))

vi.mock('./web-cloud-connect', () => ({
  connectCloudProject: cloudMock.connectCloudProject,
  WEB_CLOUD_CONNECT_ERROR_CODE: {
    connectFailed: 'CONNECT_FAILED',
    mobileScopeRejected: 'MOBILE_SCOPE_REJECTED',
    noProjects: 'NO_PROJECTS',
    noOpenableProjects: 'NO_OPENABLE_PROJECTS',
    noAvailableProjects: 'NO_AVAILABLE_PROJECTS'
  }
}))

vi.mock('./preload-api/web-runtime-session', () => ({
  adoptWebRuntimeClient: sessionMock.adoptWebRuntimeClient
}))

vi.mock('./web-runtime-client', () => ({
  WebRuntimeClient: class {
    call = runtimeMock.call
    close = runtimeMock.close
  }
}))

const HOST_KEY_B64 = Buffer.alloc(32, 0x07).toString('base64')

const PAIRING_CODE = Buffer.from(
  JSON.stringify({
    v: 2,
    endpoint: 'wss://runtime.example/socket',
    deviceToken: 'device-token-1',
    publicKeyB64: HOST_KEY_B64,
    scope: 'runtime'
  })
).toString('base64url')

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function field(container: HTMLElement, id: string): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(`#${id}`)
  if (!input) {
    throw new Error(`missing input ${id}`)
  }
  return input
}

function submitCloudForm(container: HTMLElement): Promise<void> {
  const form = container.querySelector('form')
  if (!form) {
    throw new Error('missing cloud form')
  }
  return act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await Promise.resolve()
  })
}

describe('WebConnect cloud login', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null
  let onConnected: ReturnType<typeof vi.fn<() => void>>

  const render = (
    initialPairingInput: string | null = null,
    initialCloudApiUrl: string | null = null
  ): void => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root?.render(
        <WebConnect
          initialPairingInput={initialPairingInput}
          initialCloudApiUrl={initialCloudApiUrl}
          onConnected={onConnected}
        />
      )
    })
  }

  beforeEach(() => {
    window.localStorage.clear()
    cloudMock.connectCloudProject.mockReset()
    sessionMock.adoptWebRuntimeClient.mockReset()
    runtimeMock.call.mockReset()
    runtimeMock.close.mockReset()
    onConnected = vi.fn<() => void>()
  })

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
    }
    container?.remove()
    root = null
    container = null
    window.localStorage.clear()
  })

  it('signs in with the platform credentials and reaches onConnected', async () => {
    const client = { close: vi.fn() }
    const environment = {
      id: 'web-cloud-1',
      name: 'Payments (cloud session)',
      createdAt: 1,
      updatedAt: 1,
      lastUsedAt: 2,
      runtimeId: 'runtime-42',
      cloudLoginRequired: true,
      preferredEndpointId: 'ws-web-cloud-1',
      endpoints: [
        {
          id: 'ws-web-cloud-1',
          kind: 'websocket',
          label: 'WebSocket',
          endpoint: 'wss://runtime.example/socket',
          deviceToken: 'device-token-1',
          publicKeyB64: HOST_KEY_B64
        }
      ]
    }
    cloudMock.connectCloudProject.mockResolvedValue({
      offer: {
        v: 2,
        endpoint: 'wss://runtime.example/socket',
        deviceToken: 'device-token-1',
        publicKeyB64: HOST_KEY_B64,
        scope: 'runtime',
        cloud: { credential: 'ticket-1', devicePublicKeyB64: HOST_KEY_B64 }
      },
      environmentName: 'Payments',
      projectName: 'Payments',
      runtimeId: 'runtime-42',
      deviceSecretKeyB64: Buffer.alloc(32, 0x01).toString('base64'),
      client,
      environment
    })

    render()
    if (!container) {
      throw new Error('missing container')
    }
    setInputValue(field(container, 'web-cloud-api-url'), 'https://cloud.example.com')
    setInputValue(field(container, 'web-cloud-username'), 'zhangsan')
    setInputValue(field(container, 'web-cloud-password'), 'Passw0rd!')
    setInputValue(field(container, 'web-cloud-device-name'), 'm49-browser')

    await submitCloudForm(container)

    expect(cloudMock.connectCloudProject).toHaveBeenCalledWith(
      expect.objectContaining({
        apiUrl: 'https://cloud.example.com',
        username: 'zhangsan',
        password: 'Passw0rd!',
        deviceName: 'm49-browser'
      })
    )
    expect(sessionMock.adoptWebRuntimeClient).toHaveBeenCalledWith(client, environment)
    expect(onConnected).toHaveBeenCalledTimes(1)
    expect(sessionMock.adoptWebRuntimeClient.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(onConnected).mock.invocationCallOrder[0]
    )

    const stored: unknown = JSON.parse(
      window.localStorage.getItem('orca.web.runtimeEnvironment.v1') ?? 'null'
    )
    expect(stored).toMatchObject({
      id: 'web-cloud-1',
      name: 'Payments (cloud session)',
      runtimeId: 'runtime-42',
      cloudLoginRequired: true
    })
    // The ticket is a one-time credential and never enters the stored record.
    expect(JSON.stringify(stored)).not.toContain('ticket-1')
    expect(JSON.stringify(stored)).not.toContain('deviceSecretKeyB64')
  })

  it('pre-fills the platform address from the entry URL ?api=', () => {
    render(null, 'https://cloud.example.com')

    if (!container) {
      throw new Error('missing container')
    }
    expect(field(container, 'web-cloud-api-url').value).toBe('https://cloud.example.com')
  })

  it('shows an explicit empty state when no visible project can be opened', async () => {
    cloudMock.connectCloudProject.mockRejectedValue(
      Object.assign(new Error('no open permission'), { code: 'NO_OPENABLE_PROJECTS' })
    )

    render(null, 'https://cloud.example.com')
    if (!container) {
      throw new Error('missing container')
    }
    setInputValue(field(container, 'web-cloud-username'), 'admin')
    setInputValue(field(container, 'web-cloud-password'), 'Adm1n!')

    await submitCloudForm(container)

    expect(onConnected).not.toHaveBeenCalled()
    expect(container.textContent).toContain('none can be opened')
    expect(container.textContent).not.toContain('PROJECT_FORBIDDEN')
  })

  it('shows an explicit empty state when every project host is offline or revoked', async () => {
    cloudMock.connectCloudProject.mockRejectedValue(
      Object.assign(new Error('hosts offline'), { code: 'NO_AVAILABLE_PROJECTS' })
    )

    render(null, 'https://cloud.example.com')
    if (!container) {
      throw new Error('missing container')
    }
    setInputValue(field(container, 'web-cloud-username'), 'admin')
    setInputValue(field(container, 'web-cloud-password'), 'Adm1n!')

    await submitCloudForm(container)

    expect(onConnected).not.toHaveBeenCalled()
    expect(container.textContent).toContain('offline or has been revoked')
  })

  it('renders the platform error code and message', async () => {
    cloudMock.connectCloudProject.mockRejectedValue(
      Object.assign(new Error('bad password'), { code: 'INVALID_CREDENTIALS' })
    )

    render()
    if (!container) {
      throw new Error('missing container')
    }
    setInputValue(field(container, 'web-cloud-api-url'), 'https://cloud.example.com')
    setInputValue(field(container, 'web-cloud-username'), 'zhangsan')
    setInputValue(field(container, 'web-cloud-password'), 'wrong')

    await submitCloudForm(container)

    expect(onConnected).not.toHaveBeenCalled()
    expect(container.textContent).toContain('INVALID_CREDENTIALS')
    expect(container.textContent).toContain('bad password')
  })

  it('still connects through the pairing-code path', async () => {
    runtimeMock.call.mockResolvedValue({
      id: 'status-1',
      ok: true,
      result: { deviceScope: 'runtime' },
      _meta: { runtimeId: 'runtime-9' }
    })

    render()
    if (!container) {
      throw new Error('missing container')
    }
    const pairingTab = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Pairing code')
    )
    act(() => {
      pairingTab?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    })

    setInputValue(field(container, 'web-runtime-name'), 'Office Server')
    setInputValue(field(container, 'web-runtime-pairing-code'), PAIRING_CODE)
    const connectButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Connect')
    )
    await act(async () => {
      connectButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(runtimeMock.call).toHaveBeenCalledWith('status.get', undefined, {
      timeoutMs: 15_000
    })
    expect(onConnected).toHaveBeenCalledTimes(1)
    const stored: unknown = JSON.parse(
      window.localStorage.getItem('orca.web.runtimeEnvironment.v1') ?? 'null'
    )
    expect(stored).toMatchObject({
      name: 'Office Server',
      runtimeId: 'runtime-9'
    })
    expect(JSON.stringify(stored)).not.toContain('cloudLoginRequired')
  })
})
