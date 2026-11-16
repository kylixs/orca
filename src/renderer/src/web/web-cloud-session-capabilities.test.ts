import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLOUD_SESSION_TABS_RESTORE_CAPABILITY } from '../../../shared/cloud-workspace-info'
import { replaceRuntimeEnvironmentRevisions } from '../runtime/runtime-environment-revision'
import {
  clearWebCloudSessionCapabilities,
  getWebCloudSessionCapabilitiesRevision,
  recordWebCloudSessionCapabilities,
  resetWebCloudSessionCapabilities,
  shouldMirrorCloudSessionTabs,
  subscribeWebCloudSessionCapabilities
} from './web-cloud-session-capabilities'

afterEach(() => {
  resetWebCloudSessionCapabilities()
  replaceRuntimeEnvironmentRevisions([])
})

describe('shouldMirrorCloudSessionTabs', () => {
  it('lets the restore chain run when the host advertised the capability', () => {
    replaceRuntimeEnvironmentRevisions([{ id: 'cloud-a', createdAt: 5, pairingRevision: 10 }])
    recordWebCloudSessionCapabilities('cloud-a', [CLOUD_SESSION_TABS_RESTORE_CAPABILITY])

    expect(shouldMirrorCloudSessionTabs('cloud-a')).toBe(true)
  })

  it('keeps the cloud skip for an old host that advertises nothing', () => {
    replaceRuntimeEnvironmentRevisions([{ id: 'cloud-old', createdAt: 5, pairingRevision: 10 }])
    recordWebCloudSessionCapabilities('cloud-old', [])

    expect(shouldMirrorCloudSessionTabs('cloud-old')).toBe(false)
    expect(shouldMirrorCloudSessionTabs('never-probed')).toBe(false)
  })

  it('ignores a capability recorded for a replaced pairing', () => {
    replaceRuntimeEnvironmentRevisions([{ id: 'cloud-a', createdAt: 5, pairingRevision: 10 }])
    recordWebCloudSessionCapabilities('cloud-a', [CLOUD_SESSION_TABS_RESTORE_CAPABILITY])
    replaceRuntimeEnvironmentRevisions([{ id: 'cloud-a', createdAt: 5, pairingRevision: 20 }])

    expect(shouldMirrorCloudSessionTabs('cloud-a')).toBe(false)
  })

  it('notifies subscribers when capabilities land after the first read (D3)', () => {
    replaceRuntimeEnvironmentRevisions([{ id: 'cloud-a', createdAt: 5, pairingRevision: 10 }])
    // The mirror effect may evaluate before `workspace.info` answers: it must read "not restored".
    expect(shouldMirrorCloudSessionTabs('cloud-a')).toBe(false)
    const listener = vi.fn()
    const unsubscribe = subscribeWebCloudSessionCapabilities(listener)
    const before = getWebCloudSessionCapabilitiesRevision()
    try {
      recordWebCloudSessionCapabilities('cloud-a', [CLOUD_SESSION_TABS_RESTORE_CAPABILITY])

      expect(listener).toHaveBeenCalledTimes(1)
      expect(getWebCloudSessionCapabilitiesRevision()).toBeGreaterThan(before)
      // The revision is an effect dependency, so the mirror re-evaluates and now restores.
      expect(shouldMirrorCloudSessionTabs('cloud-a')).toBe(true)
    } finally {
      unsubscribe()
    }
  })

  it('fails closed while either side of the revision is unknown (D4)', () => {
    recordWebCloudSessionCapabilities(
      'cloud-unreadable',
      [CLOUD_SESSION_TABS_RESTORE_CAPABILITY],
      undefined
    )
    expect(shouldMirrorCloudSessionTabs('cloud-unreadable')).toBe(false)

    replaceRuntimeEnvironmentRevisions([{ id: 'cloud-b', createdAt: 5, pairingRevision: 10 }])
    recordWebCloudSessionCapabilities('cloud-b', [CLOUD_SESSION_TABS_RESTORE_CAPABILITY])
    replaceRuntimeEnvironmentRevisions([])
    expect(shouldMirrorCloudSessionTabs('cloud-b')).toBe(false)
  })

  it('clearing a record a failed bootstrap cannot vouch for disables the mirror (D4)', () => {
    replaceRuntimeEnvironmentRevisions([{ id: 'cloud-c', createdAt: 5, pairingRevision: 10 }])
    recordWebCloudSessionCapabilities('cloud-c', [CLOUD_SESSION_TABS_RESTORE_CAPABILITY])
    expect(shouldMirrorCloudSessionTabs('cloud-c')).toBe(true)

    clearWebCloudSessionCapabilities('cloud-c')

    expect(shouldMirrorCloudSessionTabs('cloud-c')).toBe(false)
  })
})
