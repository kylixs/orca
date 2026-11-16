import { afterEach, describe, expect, it } from 'vitest'
import { CLOUD_SESSION_TABS_RESTORE_CAPABILITY } from '../../../shared/cloud-workspace-info'
import { replaceRuntimeEnvironmentRevisions } from '../runtime/runtime-environment-revision'
import {
  recordWebCloudSessionCapabilities,
  resetWebCloudSessionCapabilities,
  shouldMirrorCloudSessionTabs
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
})
