import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CLOUD_HOST_CREDENTIAL_FILENAME } from '../cloud-platform/cloud-host-enrollment'
import { beginHostCredentialReenrollment } from './host-credential-reenrollment'

const CREDENTIAL = { hostId: 'h1', hostName: 'host-a', credential: 'old', registeredAt: 1 }
const DESIGN_BACKUP_PREFIX = 'orca-cloud-host.replaced-'
const LEGACY_BACKUP_PREFIX = `${CLOUD_HOST_CREDENTIAL_FILENAME}.bak-`

function temporaryDataRoot(): string {
  return mkdtempSync(join(tmpdir(), 'orca-reenroll-'))
}

function seedCredential(dataRoot: string): string {
  const path = join(dataRoot, CLOUD_HOST_CREDENTIAL_FILENAME)
  writeFileSync(path, JSON.stringify(CREDENTIAL), { mode: 0o600 })
  return path
}

function replacementBackups(dataRoot: string): string[] {
  return readdirSync(dataRoot).filter((entry) => entry.startsWith(DESIGN_BACKUP_PREFIX))
}

function backupPathOf(dataRoot: string): string {
  const name = replacementBackups(dataRoot)[0]
  return join(dataRoot, name ?? `${DESIGN_BACKUP_PREFIX}missing.json`)
}

describe('--reenroll credential transaction', () => {
  it('renames the old credential to a 0600 orca-cloud-host.replaced-<epoch>.json backup', () => {
    const dataRoot = temporaryDataRoot()
    const credentialPath = seedCredential(dataRoot)

    const transaction = beginHostCredentialReenrollment(dataRoot, () => 1_700_000_000_000)

    expect(transaction).not.toBeNull()
    expect(existsSync(credentialPath)).toBe(false)
    // Rename is the atomic step: exactly one new file, no temp/partial artifact.
    expect(readdirSync(dataRoot)).toEqual([`${DESIGN_BACKUP_PREFIX}1700000000000.json`])
    const backupPath = join(dataRoot, `${DESIGN_BACKUP_PREFIX}1700000000000.json`)
    expect(JSON.parse(readFileSync(backupPath, 'utf8'))).toEqual(CREDENTIAL)
    expect(statSync(backupPath).mode & 0o777).toBe(0o600)
  })

  it('restores the old credential when re-registration fails', () => {
    const dataRoot = temporaryDataRoot()
    const credentialPath = seedCredential(dataRoot)

    beginHostCredentialReenrollment(dataRoot)?.rollback()

    expect(JSON.parse(readFileSync(credentialPath, 'utf8'))).toEqual(CREDENTIAL)
    expect(replacementBackups(dataRoot)).toEqual([])
  })

  it('keeps a credential written after a late failure and removes the dead backup', () => {
    const dataRoot = temporaryDataRoot()
    const credentialPath = seedCredential(dataRoot)
    const transaction = beginHostCredentialReenrollment(dataRoot)
    const replacement = { ...CREDENTIAL, credential: 'new', registeredAt: 2 }
    writeFileSync(credentialPath, JSON.stringify(replacement), { mode: 0o600 })

    transaction?.rollback()

    expect(JSON.parse(readFileSync(credentialPath, 'utf8'))).toEqual(replacement)
    expect(existsSync(backupPathOf(dataRoot))).toBe(false)
  })

  it('deletes the old backup once re-registration succeeds', () => {
    const dataRoot = temporaryDataRoot()
    const credentialPath = seedCredential(dataRoot)
    const transaction = beginHostCredentialReenrollment(dataRoot)
    writeFileSync(credentialPath, JSON.stringify({ ...CREDENTIAL, credential: 'new' }), {
      mode: 0o600
    })

    transaction?.commit()

    expect(existsSync(backupPathOf(dataRoot))).toBe(false)
  })

  it('keeps the backup when commit runs without a stored replacement', () => {
    const dataRoot = temporaryDataRoot()
    seedCredential(dataRoot)
    const transaction = beginHostCredentialReenrollment(dataRoot)

    transaction?.commit()

    expect(existsSync(backupPathOf(dataRoot))).toBe(true)
  })

  it('does nothing when there is no credential to replace', () => {
    expect(beginHostCredentialReenrollment(temporaryDataRoot())).toBeNull()
  })

  it('removes legacy .bak- leftovers once the live credential is moved aside', () => {
    const dataRoot = temporaryDataRoot()
    seedCredential(dataRoot)
    writeFileSync(join(dataRoot, `${LEGACY_BACKUP_PREFIX}1`), '{"dead":true}')
    writeFileSync(join(dataRoot, `${LEGACY_BACKUP_PREFIX}2`), '{"dead":true}')

    beginHostCredentialReenrollment(dataRoot)

    expect(readdirSync(dataRoot).filter((name) => name.startsWith(LEGACY_BACKUP_PREFIX))).toEqual(
      []
    )
    expect(replacementBackups(dataRoot)).toHaveLength(1)
  })

  it('keeps legacy .bak- leftovers when there is no live credential to replace', () => {
    const dataRoot = temporaryDataRoot()
    const legacy = join(dataRoot, `${LEGACY_BACKUP_PREFIX}1`)
    writeFileSync(legacy, '{"only-copy":true}')

    expect(beginHostCredentialReenrollment(dataRoot)).toBeNull()

    // It may be the only recoverable credential; never delete it blind.
    expect(existsSync(legacy)).toBe(true)
  })

  it('leaves the credential and legacy backups intact when the atomic rename fails', () => {
    const dataRoot = temporaryDataRoot()
    const credentialPath = seedCredential(dataRoot)
    const legacy = join(dataRoot, `${LEGACY_BACKUP_PREFIX}1`)
    writeFileSync(legacy, '{"dead":true}')
    // A directory at the target path makes rename(2) fail before anything moves.
    const blocked = join(dataRoot, `${DESIGN_BACKUP_PREFIX}1700000000000.json`)
    mkdirSync(blocked)

    expect(() => beginHostCredentialReenrollment(dataRoot, () => 1_700_000_000_000)).toThrow()

    expect(JSON.parse(readFileSync(credentialPath, 'utf8'))).toEqual(CREDENTIAL)
    expect(existsSync(legacy)).toBe(true)
  })
})
