import { describe, expect, it } from 'vitest'
import { isCloudSessionRuntimeEnvironment } from './runtime-environments'

const cloudProject = {
  projectId: 'proj_1',
  projectKey: 'payment',
  hostId: 'host_1',
  registeredAt: 1
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
