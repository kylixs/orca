// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isActiveWebClientCloudSession, resetWebCloudSessionScope } from './web-cloud-session-scope'
import type { StoredWebRuntimeEnvironment } from './web-runtime-environment'

const ENVIRONMENT_STORAGE_KEY = 'orca.web.runtimeEnvironment.v1'

function storedEnvironment(overrides: Partial<StoredWebRuntimeEnvironment> = {}): string {
  return JSON.stringify({
    id: 'web-scope-test',
    name: 'Dev host',
    createdAt: 0,
    updatedAt: 0,
    lastUsedAt: null,
    runtimeId: null,
    preferredEndpointId: 'ws-web-scope-test',
    endpoints: [
      {
        id: 'ws-web-scope-test',
        kind: 'websocket',
        label: 'WebSocket',
        endpoint: 'wss://dev.example.com/',
        deviceToken: 'token',
        publicKeyB64: 'key'
      }
    ],
    ...overrides
  })
}

describe('isActiveWebClientCloudSession', () => {
  beforeEach(() => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    resetWebCloudSessionScope()
  })

  afterEach(() => {
    window.localStorage.clear()
    vi.unstubAllGlobals()
    resetWebCloudSessionScope()
  })

  it('true when the stored environment came from a consumed cloud ticket', () => {
    window.localStorage.setItem(
      ENVIRONMENT_STORAGE_KEY,
      storedEnvironment({ cloudLoginRequired: true, name: 'Demo (cloud session)' })
    )
    expect(isActiveWebClientCloudSession()).toBe(true)
  })

  it('false for a paired runtime environment', () => {
    window.localStorage.setItem(ENVIRONMENT_STORAGE_KEY, storedEnvironment())
    expect(isActiveWebClientCloudSession()).toBe(false)
  })

  it('false when no environment is stored', () => {
    expect(isActiveWebClientCloudSession()).toBe(false)
  })

  it('false outside the web client', () => {
    window.localStorage.setItem(
      ENVIRONMENT_STORAGE_KEY,
      storedEnvironment({ cloudLoginRequired: true })
    )
    vi.stubGlobal('__ORCA_WEB_CLIENT__', false)
    resetWebCloudSessionScope()
    expect(isActiveWebClientCloudSession()).toBe(false)
  })

  it('re-derives to false once the dead cloud session clears its record', () => {
    window.localStorage.setItem(
      ENVIRONMENT_STORAGE_KEY,
      storedEnvironment({ cloudLoginRequired: true })
    )
    expect(isActiveWebClientCloudSession()).toBe(true)
    // Session end: the spent ticket's record is wiped on the same page.
    window.localStorage.removeItem(ENVIRONMENT_STORAGE_KEY)
    expect(isActiveWebClientCloudSession()).toBe(false)
  })

  it('re-derives to false when the same page pairs a non-cloud runtime afterwards', () => {
    window.localStorage.setItem(
      ENVIRONMENT_STORAGE_KEY,
      storedEnvironment({ id: 'web-cloud-session', cloudLoginRequired: true })
    )
    expect(isActiveWebClientCloudSession()).toBe(true)
    // WebConnect pairing saves a fresh paired environment under a new id.
    window.localStorage.setItem(
      ENVIRONMENT_STORAGE_KEY,
      storedEnvironment({ id: 'web-paired-runtime', name: 'Dev host' })
    )
    expect(isActiveWebClientCloudSession()).toBe(false)
  })

  it('stays true while the same cloud environment is refreshed in place', () => {
    window.localStorage.setItem(
      ENVIRONMENT_STORAGE_KEY,
      storedEnvironment({ cloudLoginRequired: true })
    )
    expect(isActiveWebClientCloudSession()).toBe(true)
    // Status verification rewrites runtimeId/lastUsedAt but keeps the id.
    window.localStorage.setItem(
      ENVIRONMENT_STORAGE_KEY,
      storedEnvironment({ cloudLoginRequired: true, runtimeId: 'runtime-1', lastUsedAt: 1 })
    )
    expect(isActiveWebClientCloudSession()).toBe(true)
  })
})
