import { describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-file-system', () => ({
  File: class {},
  Paths: { cache: '' }
}))
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => null }))

import { fileActionCapabilitiesFor, fileActionsFeatureEnabled } from './file-action-capabilities'

describe('file action capabilities', () => {
  it('needs sharing on iOS for both Save and Open', () => {
    expect(
      fileActionCapabilitiesFor({
        platform: 'ios',
        sharing: true,
        intentLauncher: false,
        saf: false,
        contentUri: false
      })
    ).toEqual({ saveToPhone: true, openWith: true })
    expect(
      fileActionCapabilitiesFor({
        platform: 'ios',
        sharing: false,
        intentLauncher: false,
        saf: false,
        contentUri: false
      })
    ).toEqual({ saveToPhone: false, openWith: false })
  })

  it('lets SAF carry Save on Android when sharing is missing, but requires the intent pair for Open', () => {
    expect(
      fileActionCapabilitiesFor({
        platform: 'android',
        sharing: false,
        intentLauncher: true,
        saf: true,
        contentUri: true
      })
    ).toEqual({ saveToPhone: true, openWith: true })

    expect(
      fileActionCapabilitiesFor({
        platform: 'android',
        sharing: false,
        intentLauncher: true,
        saf: false,
        contentUri: false
      })
    ).toEqual({ saveToPhone: false, openWith: false })

    expect(
      fileActionCapabilitiesFor({
        platform: 'android',
        sharing: true,
        intentLauncher: false,
        saf: false,
        contentUri: false
      })
    ).toEqual({ saveToPhone: true, openWith: false })
  })

  it('reports nothing on web', () => {
    expect(
      fileActionCapabilitiesFor({
        platform: 'web',
        sharing: true,
        intentLauncher: true,
        saf: true,
        contentUri: true
      })
    ).toEqual({ saveToPhone: false, openWith: false })
  })

  it('can be rolled back without a new binary', () => {
    process.env.EXPO_PUBLIC_FILE_ACTIONS = 'off'
    expect(fileActionsFeatureEnabled()).toBe(false)
    delete process.env.EXPO_PUBLIC_FILE_ACTIONS
    expect(fileActionsFeatureEnabled()).toBe(true)
  })
})
