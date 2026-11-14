import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PAIRING_OFFER_VERSION } from '../../shared/pairing'
import { listEnvironments } from '../../shared/runtime-environment-store'
import type { PublicKnownRuntimeEnvironment } from '../../shared/runtime-environments'
import { replacedRuntimeEnvironmentIds } from '../../renderer/src/store/slices/runtime-environment-peer-replacement'
import { publicRuntimeEnvironmentWithHostKey } from '../ipc/runtime-environment-host-key'
import type { CloudProjectLink } from './cloud-pairing-offer'
import { registerCloudRuntimeEnvironment } from './cloud-runtime-environment'

/**
 * W9A-5: the renderer retires an environment whose pairing revision moved and
 * cannot be proven to still name the same machine, and the retirement purges the
 * project's rows. These are the catalog reads the register→reopen chain produces,
 * classified exactly as `setRuntimeEnvironments` classifies them.
 */

const link = (hostKey: string): CloudProjectLink => ({
  offer: {
    v: PAIRING_OFFER_VERSION,
    endpoint: 'wss://host.example/runtime',
    deviceToken: 'placeholder-device-token',
    publicKeyB64: Buffer.alloc(32, hostKey.charCodeAt(0)).toString('base64'),
    scope: 'runtime'
  },
  cloudUpgrade: { credential: 'ticket', devicePubKey: 'device-key' },
  route: 'direct',
  workspaceRoot: '/srv/work',
  projectRoot: '/srv/payment-service',
  expiresIn: 60
})

function registration(link: CloudProjectLink, workspacePath?: string) {
  return {
    projectId: 'project-1',
    projectKey: 'checkout-svc',
    projectName: 'Checkout Service',
    hostId: 'host-1',
    link,
    ...(workspacePath ? { workspacePath } : {})
  }
}

function catalog(userDataPath: string): PublicKnownRuntimeEnvironment[] {
  return listEnvironments(userDataPath).map(publicRuntimeEnvironmentWithHostKey)
}

let userDataPath = ''

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-cloud-pairing-continuity-'))
})

afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('a cloud project reopen must not read as a machine replacement', () => {
  it('sign-in then openWorkspace keeps one pairing revision, so nothing is retired', () => {
    registerCloudRuntimeEnvironment(userDataPath, registration(link('a')), 100)
    const afterSignIn = catalog(userDataPath)
    registerCloudRuntimeEnvironment(
      userDataPath,
      registration(link('a'), '/home/zhangsan/work/checkout-svc'),
      200
    )
    const afterOpen = catalog(userDataPath)
    expect(replacedRuntimeEnvironmentIds(afterSignIn, afterOpen)).toEqual([])
    expect(afterOpen[0]?.hostKeyFingerprint).toBe(afterSignIn[0]?.hostKeyFingerprint)
  })

  it('a re-pair to a host with another key still reads as a replacement to retire', () => {
    registerCloudRuntimeEnvironment(userDataPath, registration(link('a')), 100)
    const before = catalog(userDataPath)
    registerCloudRuntimeEnvironment(userDataPath, registration(link('b')), 200)
    const after = catalog(userDataPath)
    expect(replacedRuntimeEnvironmentIds(before, after)).toEqual([after[0]?.id])
    expect(after[0]?.hostKeyFingerprint).not.toBe(before[0]?.hostKeyFingerprint)
  })
})
