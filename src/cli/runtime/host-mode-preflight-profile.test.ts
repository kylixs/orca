import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { preflightHostModeProfile } from './host-mode-preflight-profile'
import { ORCAD_LOCK_FILE_NAME } from '../../main/orcad/orcad-instance-lock'

const temporaryRoots: string[] = []

async function temporaryProfile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-profile-preflight-'))
  temporaryRoots.push(root)
  return join(root, 'profile')
}

function lockRecord(pid: number): string {
  return JSON.stringify({
    pid,
    startedAtMs: null,
    identity: 'test',
    version: 'test',
    acquiredAt: new Date().toISOString(),
    nonce: 'test-nonce',
    role: 'orcad'
  })
}

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

describe('preflightHostModeProfile', () => {
  it('passes a writable profile without leaving a probe file', async () => {
    const profile = await temporaryProfile()

    const check = await preflightHostModeProfile(profile)

    expect(check).toEqual({ id: 'profile', ok: true, detail: profile })
    expect(await readdir(profile)).toEqual([])
  })

  it('refuses a profile whose live holder published the instance lock', async () => {
    const profile = await temporaryProfile()
    await mkdir(profile, { recursive: true })
    await writeFile(join(profile, ORCAD_LOCK_FILE_NAME), lockRecord(process.pid))

    const check = await preflightHostModeProfile(profile)

    expect(check.ok).toBe(false)
    expect(check.detail).toContain('profile_in_use')
    expect(check.detail).toContain(`pid ${process.pid}`)
  })

  it('treats a dead holder as free and reclaimable', async () => {
    const profile = await temporaryProfile()
    await mkdir(profile, { recursive: true })
    await writeFile(join(profile, ORCAD_LOCK_FILE_NAME), lockRecord(2_147_483_646))

    const check = await preflightHostModeProfile(profile)

    expect(check).toMatchObject({ id: 'profile', ok: true })
  })

  it.skipIf(process.platform === 'win32')(
    'refuses a profile the current user cannot write',
    async () => {
      const profile = await temporaryProfile()
      await mkdir(profile, { recursive: true })
      await chmod(profile, 0o500)
      try {
        const check = await preflightHostModeProfile(profile)

        expect(check.ok).toBe(false)
        expect(check.detail).toContain('profile_unwritable')
      } finally {
        await chmod(profile, 0o700)
      }
    }
  )
})
