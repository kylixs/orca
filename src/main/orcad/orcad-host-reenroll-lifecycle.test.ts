import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../persistence/profile-state/profile-state-access', () => ({
  acquireProfileStateRuntimeAdmission: () => ({ release: vi.fn() })
}))
vi.mock('./orcad-browser-startup', () => ({
  startOrcadBrowserProvider: () => ({ ready: Promise.resolve(), stop: async () => {} })
}))
vi.mock('../runtime/runtime-browser-commands-factory', () => ({
  setRuntimeBrowserCommandsFactory: vi.fn()
}))

import {
  CLOUD_HOST_CREDENTIAL_FILENAME,
  CloudHostEnrolmentFailure,
  storeHostCredential,
  type CloudHostCredential
} from '../cloud-platform/cloud-host-enrollment'
import { resolveOrcadExitCode } from './orcad-exit-code'
import { acquireOrcadInstanceLock } from './orcad-instance-lock'
import { startOrcadWithHost } from './orcad-lifecycle'

const OLD: CloudHostCredential = {
  hostId: 'h1',
  hostName: 'host-a',
  credential: 'old',
  registeredAt: 1
}
const NEW: CloudHostCredential = {
  hostId: 'h2',
  hostName: 'host-a',
  credential: 'new',
  registeredAt: 2
}

function dataRootWithCredential(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-reenroll-lock-'))
  writeFileSync(join(root, CLOUD_HOST_CREDENTIAL_FILENAME), JSON.stringify(OLD), { mode: 0o600 })
  return root
}

function backups(root: string): string[] {
  return readdirSync(root).filter((name) =>
    name.startsWith(`${CLOUD_HOST_CREDENTIAL_FILENAME}.bak-`)
  )
}

describe('--reenroll enforcement under a live instance lock', () => {
  it('refuses a live holder with 78 without touching the credential', async () => {
    const root = dataRootWithCredential()
    const held = acquireOrcadInstanceLock(root)
    const start = vi.fn(async () => ({}))

    let failure: unknown
    try {
      await startOrcadWithHost(root, start, () => {}, { reenroll: true })
    } catch (error) {
      failure = error
    } finally {
      held.release()
    }

    expect(resolveOrcadExitCode(failure)).toBe(78)
    expect(start).not.toHaveBeenCalled()
    expect(JSON.parse(readFileSync(join(root, CLOUD_HOST_CREDENTIAL_FILENAME), 'utf8'))).toEqual(
      OLD
    )
    expect(backups(root)).toEqual([])
  })
})

describe('--reenroll after the instance lock is acquired', () => {
  it('backs up the old credential and keeps the new 0600 one', async () => {
    const root = dataRootWithCredential()

    await startOrcadWithHost(
      root,
      async () => {
        expect(existsSync(join(root, CLOUD_HOST_CREDENTIAL_FILENAME))).toBe(false)
        expect(backups(root)).toHaveLength(1)
        storeHostCredential(root, NEW)
        return {}
      },
      () => {},
      { reenroll: true }
    )

    expect(JSON.parse(readFileSync(join(root, CLOUD_HOST_CREDENTIAL_FILENAME), 'utf8'))).toEqual(
      NEW
    )
    expect(statSync(join(root, CLOUD_HOST_CREDENTIAL_FILENAME)).mode & 0o777).toBe(0o600)
    expect(backups(root)).toHaveLength(1)
  })

  it('leaves the old credential intact when re-registration fails', async () => {
    const root = dataRootWithCredential()

    await expect(
      startOrcadWithHost(
        root,
        async () => {
          throw new CloudHostEnrolmentFailure({
            code: 'host_token_invalid',
            retryable: false,
            httpStatus: 401
          })
        },
        () => {},
        { reenroll: true }
      )
    ).rejects.toBeInstanceOf(CloudHostEnrolmentFailure)

    expect(JSON.parse(readFileSync(join(root, CLOUD_HOST_CREDENTIAL_FILENAME), 'utf8'))).toEqual(
      OLD
    )
    expect(backups(root)).toEqual([])
  })
})
