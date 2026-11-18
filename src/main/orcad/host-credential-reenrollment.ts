import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { hardenExistingSecureFile } from '../../shared/secure-file'
import { CLOUD_HOST_CREDENTIAL_FILENAME } from '../cloud-platform/cloud-host-enrollment'

export type HostCredentialReenrollment = {
  /** Restores the renamed credential unless registration already persisted a replacement. */
  rollback(): void
  /** Drops the old backup once a replacement credential exists; a dead secret must not linger. */
  commit(): void
}

/** Design name: orca-cloud-host.replaced-<epoch>.json. */
const REPLACEMENT_BACKUP_PREFIX = CLOUD_HOST_CREDENTIAL_FILENAME.replace(/\.json$/, '.replaced-')
/** Older releases used orca-cloud-host.json.bak-<epoch>; those are dead leftovers now. */
const LEGACY_BACKUP_PREFIX = `${CLOUD_HOST_CREDENTIAL_FILENAME}.bak-`

function replacementBackupPath(userDataPath: string, epoch: number): string {
  return join(userDataPath, `${REPLACEMENT_BACKUP_PREFIX}${epoch}.json`)
}

/** Dead secrets from the previous naming scheme, only once a live credential was here. */
function removeLegacyBackups(userDataPath: string): void {
  try {
    for (const name of readdirSync(userDataPath)) {
      if (name.startsWith(LEGACY_BACKUP_PREFIX)) {
        removeQuietly(join(userDataPath, name))
      }
    }
  } catch {
    // Cleanup is best-effort; the credential transaction must not fail on it.
  }
}

function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch {
    // Best-effort cleanup; a lingering dead credential never blocks startup.
  }
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
    // No live credential: a legacy backup may be the only recoverable copy, so keep it.
    return null
  }
  const backupPath = replacementBackupPath(userDataPath, now())
  try {
    renameSync(credentialPath, backupPath)
    hardenExistingSecureFile(backupPath)
  } catch (error) {
    try {
      if (existsSync(backupPath) && !existsSync(credentialPath)) {
        renameSync(backupPath, credentialPath)
      }
    } catch {
      // Keep the original failure as the verdict; the old credential still sits at the backup.
    }
    throw error
  }
  // The live credential is safely aside, so any old-name backup is a dead secret.
  removeLegacyBackups(userDataPath)
  return {
    rollback: () => {
      // A stored replacement means registration succeeded; the old credential is already dead.
      if (existsSync(credentialPath)) {
        removeQuietly(backupPath)
        return
      }
      if (!existsSync(backupPath)) {
        return
      }
      renameSync(backupPath, credentialPath)
    },
    commit: () => {
      if (existsSync(credentialPath)) {
        removeQuietly(backupPath)
      }
    }
  }
}
