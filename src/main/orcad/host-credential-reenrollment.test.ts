import {
  existsSync,
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

function temporaryDataRoot(): string {
  return mkdtempSync(join(tmpdir(), 'orca-reenroll-'))
}

function seedCredential(dataRoot: string): string {
  const path = join(dataRoot, CLOUD_HOST_CREDENTIAL_FILENAME)
  writeFileSync(path, JSON.stringify(CREDENTIAL), { mode: 0o600 })
  return path
}

function backupPathOf(dataRoot: string): string {
  const name = readdirSync(dataRoot).find((entry) =>
    entry.startsWith(`${CLOUD_HOST_CREDENTIAL_FILENAME}.bak-`)
  )
  return join(dataRoot, name ?? `${CLOUD_HOST_CREDENTIAL_FILENAME}.bak-missing`)
}

describe('--reenroll credential transaction', () => {
  it('renames the old credential to a 0600 backup before re-registration', () => {
    const dataRoot = temporaryDataRoot()
    const credentialPath = seedCredential(dataRoot)

    const transaction = beginHostCredentialReenrollment(dataRoot, () => 1_700_000_000_000)

    expect(transaction).not.toBeNull()
    expect(existsSync(credentialPath)).toBe(false)
    const backupPath = join(dataRoot, `${CLOUD_HOST_CREDENTIAL_FILENAME}.bak-1700000000000`)
    expect(JSON.parse(readFileSync(backupPath, 'utf8'))).toEqual(CREDENTIAL)
    expect(statSync(backupPath).mode & 0o777).toBe(0o600)
  })

  it('restores the old credential when re-registration fails', () => {
    const dataRoot = temporaryDataRoot()
    const credentialPath = seedCredential(dataRoot)

    beginHostCredentialReenrollment(dataRoot)?.rollback()

    expect(JSON.parse(readFileSync(credentialPath, 'utf8'))).toEqual(CREDENTIAL)
    expect(existsSync(join(dataRoot, `${CLOUD_HOST_CREDENTIAL_FILENAME}.bak-${Date.now()}`))).toBe(
      false
    )
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
})
