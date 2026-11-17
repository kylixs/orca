import { existsSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { hardenExistingSecureFile } from '../../shared/secure-file'
import { CLOUD_HOST_CREDENTIAL_FILENAME } from '../cloud-platform/cloud-host-enrollment'

export type HostCredentialReenrollment = {
  /** Restores the renamed credential unless registration already persisted a replacement. */
  rollback(): void
  /** Drops the old backup once a replacement credential exists; a dead secret must not linger. */
  commit(): void
}

/**
 * Moves the current credential aside so enrolment registers again.
 *
 * Call only while holding the orcad instance lock: renaming under a live host leaves it
 * with a credential the platform invalidates on the next restart.
 */
export function beginHostCredentialReenrollment(
  userDataPath: string,
  now: () => number = Date.now
): HostCredentialReenrollment | null {
  const credentialPath = join(userDataPath, CLOUD_HOST_CREDENTIAL_FILENAME)
  if (!existsSync(credentialPath)) {
    return null
  }
  const backupPath = `${credentialPath}.bak-${now()}`
  renameSync(credentialPath, backupPath)
  hardenExistingSecureFile(backupPath)
  const dropBackup = () => {
    try {
      rmSync(backupPath, { force: true })
    } catch {
      // Best-effort cleanup; a lingering dead credential never blocks startup.
    }
  }
  return {
    rollback: () => {
      // A stored replacement means registration succeeded; the old credential is already dead.
      if (existsSync(credentialPath)) {
        dropBackup()
        return
      }
      if (!existsSync(backupPath)) {
        return
      }
      renameSync(backupPath, credentialPath)
    },
    commit: () => {
      if (existsSync(credentialPath)) {
        dropBackup()
      }
    }
  }
}
