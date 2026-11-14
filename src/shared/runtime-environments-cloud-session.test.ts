import { describe, expect, it } from 'vitest'
import {
  isCloudSessionRuntimeEnvironment,
  isCloudSessionRuntimeEnvironmentId
} from './runtime-environments'

const cloudProject = {
  projectId: 'proj_1',
  projectKey: 'payment',
  hostId: 'host_1',
  registeredAt: 1
}

const cloudRow = {
  id: 'env-cloud',
  name: 'Payment',
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: null,
  runtimeId: null,
  preferredEndpointId: 'ep-1',
  endpoints: [{ id: 'ep-1', kind: 'websocket', label: 'Primary', endpoint: 'wss://host' } as const],
  cloudProject
}
const nativeRow = {
  id: 'env-native',
  name: 'Native',
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: null,
  runtimeId: null,
  preferredEndpointId: 'ep-1',
  endpoints: [{ id: 'ep-1', kind: 'websocket', label: 'Primary', endpoint: 'wss://host' } as const]
}

describe('isCloudSessionRuntimeEnvironment', () => {
  it('answers true for a platform-registered cloud project row', () => {
    expect(isCloudSessionRuntimeEnvironment({ cloudProject })).toBe(true)
  })

  it('answers true for a web row saved from a spent cloud ticket', () => {
    expect(isCloudSessionRuntimeEnvironment({ cloudLoginRequired: true })).toBe(true)
  })

  it('answers false for a paired native host row', () => {
    expect(isCloudSessionRuntimeEnvironment({})).toBe(false)
    expect(isCloudSessionRuntimeEnvironment({ cloudLoginRequired: false })).toBe(false)
  })
})

describe('isCloudSessionRuntimeEnvironmentId', () => {
  it('judges the named row only', () => {
    expect(isCloudSessionRuntimeEnvironmentId([nativeRow, cloudRow], 'env-cloud')).toBe(true)
    expect(isCloudSessionRuntimeEnvironmentId([nativeRow, cloudRow], 'env-native')).toBe(false)
  })

  it('answers false while the catalog has not landed', () => {
    expect(isCloudSessionRuntimeEnvironmentId(undefined, 'env-cloud')).toBe(false)
    expect(isCloudSessionRuntimeEnvironmentId([nativeRow], 'env-cloud')).toBe(false)
    expect(isCloudSessionRuntimeEnvironmentId([cloudRow], undefined)).toBe(false)
  })
})
