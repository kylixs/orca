import { randomUUID } from 'node:crypto'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { HostModePreflightCheck } from '../../shared/host-mode-contract'
import {
  ORCAD_LOCK_FILE_NAME,
  readOrcadInstanceLockRecord
} from '../../main/orcad/orcad-instance-lock'
import { orcadProcessStartTimeMatches } from '../../main/orcad/orcad-process-start-time'
import { isProcessAlive } from '../../main/daemon/daemon-process-inspection'

/**
 * Profile half of `--preflight`: the data root the host would take must be writable, and no
 * live host may already own it. Reads the lock only; never creates, reclaims or releases it.
 * Writes one disposable probe file and deletes it — credentials are never touched.
 */
export async function preflightHostModeProfile(
  userDataPath: string
): Promise<HostModePreflightCheck> {
  const holder = liveOrcadInstanceLockHolder(userDataPath)
  if (holder !== null) {
    return {
      id: 'profile',
      ok: false,
      detail:
        `profile_in_use: another host is already running on ${userDataPath} ` +
        `(pid ${holder.pid}); stop it or use a different ORCA_USER_DATA_PATH.`
    }
  }
  try {
    await assertProfileWritable(userDataPath)
    return { id: 'profile', ok: true, detail: userDataPath }
  } catch (error) {
    return {
      id: 'profile',
      ok: false,
      detail: `profile_unwritable: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

function liveOrcadInstanceLockHolder(userDataPath: string): { pid: number } | null {
  const record = readOrcadInstanceLockRecord(join(userDataPath, ORCAD_LOCK_FILE_NAME))
  if (
    record !== null &&
    isProcessAlive(record.pid) &&
    orcadProcessStartTimeMatches(record.pid, record.startedAtMs)
  ) {
    return { pid: record.pid }
  }
  return null
}

async function assertProfileWritable(userDataPath: string): Promise<void> {
  await mkdir(userDataPath, { recursive: true, mode: 0o700 })
  const probe = join(userDataPath, `.orcad-profile-preflight-${process.pid}-${randomUUID()}`)
  try {
    await writeFile(probe, '', { flag: 'wx', mode: 0o600 })
  } finally {
    await unlink(probe).catch(() => {})
  }
}
