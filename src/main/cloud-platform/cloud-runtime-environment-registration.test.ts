import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ownEntries, parseJsonText, readField } from '../../shared/json-fields'
import { PAIRING_OFFER_VERSION } from '../../shared/pairing'
import { getRuntimeEnvironmentSidecarPath } from '../../shared/runtime-environment-sidecar'
import { readEnvironmentStore } from '../../shared/runtime-environment-store-file'
import { cloudWorkspacePathOf } from '../../shared/runtime-environments'
import type { CloudProjectLink } from './cloud-pairing-offer'
import {
  registerCloudRuntimeEnvironment,
  removeCloudRuntimeEnvironments
} from './cloud-runtime-environment'

/** Registration only persists the link, so a fixed offer stands in for a prepared ticket. */

const link: CloudProjectLink = {
  offer: {
    v: PAIRING_OFFER_VERSION,
    endpoint: 'wss://host.example/runtime',
    deviceToken: 'placeholder-device-token',
    publicKeyB64: Buffer.alloc(32, 1).toString('base64'),
    scope: 'runtime'
  },
  cloudUpgrade: { credential: 'ticket', devicePubKey: 'device-key' },
  route: 'direct',
  workspaceRoot: '/srv/work',
  projectRoot: '/srv/payment-service',
  expiresIn: 60
}

function registration(workspacePath?: string) {
  return {
    projectId: 'project-1',
    projectKey: 'checkout-svc',
    projectName: 'Checkout Service',
    hostId: 'host-1',
    link,
    ...(workspacePath ? { workspacePath } : {})
  }
}

describe('cloud environment registration carries the checkout path', () => {
  let userDataPath: string
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-cloud-registration-'))
  })
  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  function stored(environmentId: string) {
    const environment = readEnvironmentStore(userDataPath).environments.find(
      (entry) => entry.id === environmentId
    )
    if (!environment) {
      throw new Error(`environment ${environmentId} is not stored`)
    }
    return environment
  }

  function sidecarCloudProject(environmentId: string): unknown {
    const entries = readField(
      parseJsonText(readFileSync(getRuntimeEnvironmentSidecarPath(userDataPath), 'utf8')),
      'entries'
    )
    return readField(readField(entries, environmentId), 'cloudProject')
  }

  it('omits workspacePath while it is unknown, so old sidecar shapes are unchanged', () => {
    const environment = registerCloudRuntimeEnvironment(userDataPath, registration(), 100)
    expect(cloudWorkspacePathOf(stored(environment.id))).toBeNull()
    expect(ownEntries(sidecarCloudProject(environment.id)).map(([key]) => key)).not.toContain(
      'workspacePath'
    )
  })

  it('a re-registration without a checkout keeps the path a previous open recorded', () => {
    const first = registerCloudRuntimeEnvironment(
      userDataPath,
      registration('/home/zhangsan/work/checkout-svc'),
      100
    )
    // Signing in again registers environments without opening a workspace.
    const second = registerCloudRuntimeEnvironment(userDataPath, registration(), 200)
    expect(second.id).toBe(first.id)
    expect(cloudWorkspacePathOf(stored(first.id))).toBe('/home/zhangsan/work/checkout-svc')
  })

  it('sign-out retires every cloud environment', () => {
    registerCloudRuntimeEnvironment(userDataPath, registration(), 100)
    registerCloudRuntimeEnvironment(
      userDataPath,
      {
        ...registration(),
        projectId: 'project-2',
        projectKey: 'payments',
        projectName: 'Payments'
      },
      200
    )
    expect(removeCloudRuntimeEnvironments(userDataPath).sort()).toEqual(['project-1', 'project-2'])
    expect(readEnvironmentStore(userDataPath).environments).toEqual([])
    // Idempotent: nothing left to remove.
    expect(removeCloudRuntimeEnvironments(userDataPath)).toEqual([])
  })

  it('updates the stored path on reopen and keeps the environment id', () => {
    const first = registerCloudRuntimeEnvironment(userDataPath, registration(), 100)
    const second = registerCloudRuntimeEnvironment(
      userDataPath,
      registration('/home/zhangsan/work/checkout-svc'),
      200
    )
    expect(second.id).toBe(first.id)
    expect(cloudWorkspacePathOf(stored(first.id))).toBe('/home/zhangsan/work/checkout-svc')
  })
})
