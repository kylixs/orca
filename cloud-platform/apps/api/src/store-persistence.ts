import { pruneCorruptBackups } from './snapshot-backup-retention.ts'
import { readSnapshotText, renameToCorruptBackup, writeAtomic } from './snapshot-file-io.ts'
import { restoreSnapshot } from './snapshot-restore-codec.ts'
import { DEFAULT_AUDIT_LIMIT, serializeSnapshot } from './snapshot-serialize.ts'
import type { Store } from './store.ts'

/** Kept here because the e2e restart seed imports it from this module. */
export { serializeSnapshot }

/**
 * U131: dev-store snapshot on disk.
 *
 * The API store is in-memory, so a `--platform-only` restart used to come back
 * with no hosts: heartbeats for unknown ids answer 404 and a running host cannot
 * re-enrol. The snapshot keeps the store across restarts. Off by default — only
 * `ORCA_PLATFORM_STORE_FILE` enables it — so tests and the hosted platform keep
 * their current in-memory behaviour.
 */

const DEFAULT_SNAPSHOT_INTERVAL_MS = 2_000

type WarnLog = { warn: (...args: unknown[]) => void }

export type StorePersistenceOptions = {
  file: string
  intervalMs?: number
  auditLimit?: number
  log?: WarnLog
  /** Test seam replacing the atomic writer. */
  writeFile?: (file: string, text: string) => void
}

export type StorePersistenceHandle = {
  /** Writes synchronously when the serialized state changed since the last write. */
  flushNow: () => void
  /** Stops the timer and removes the signal handlers; does not delete the file. */
  stop: () => void
}

/**
 * Restores the snapshot (if any) and schedules change-only flushes. A missing file
 * starts empty. An unreadable one (corrupt JSON or unsupported version) is renamed
 * to `<file>.corrupt-<ts>` so the only copy survives the first flush, then the
 * platform boots with an empty store and writes a fresh snapshot.
 */
export function attachStorePersistence(
  store: Store,
  options: StorePersistenceOptions
): StorePersistenceHandle {
  const { file } = options
  const intervalMs = options.intervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS
  const auditLimit = options.auditLimit ?? DEFAULT_AUDIT_LIMIT
  const log = options.log ?? console
  const writeFile = options.writeFile ?? writeAtomic

  let lastWritten: string | null = null
  let restoredText: string | null = null
  try {
    restoredText = readSnapshotText(file)
    if (restoredText !== null) {
      restoreSnapshot(store, restoredText, auditLimit)
    }
  } catch (error) {
    // U249 P2-2: preserve the unreadable bytes before any flush can overwrite
    // them; the fresh snapshot then lands on the now-free original path.
    restoredText = null
    try {
      const backup = renameToCorruptBackup(file)
      log.warn(`[store-persistence] ignoring ${file}: ${String(error)} (kept as ${backup})`)
      pruneCorruptBackups(file)
    } catch (renameError) {
      log.warn(
        `[store-persistence] ignoring ${file}: ${String(error)} (backup failed: ${String(renameError)})`
      )
    }
  }
  if (restoredText !== null) {
    try {
      const serialized = serializeSnapshot(store, auditLimit)
      if (serialized !== restoredText) {
        // Only a successful restore reaches here. Clean a legacy (plaintext or
        // v1) file now, since change-only flushes would otherwise leave the old
        // bytes on disk indefinitely.
        writeFile(file, serialized)
      }
      lastWritten = serialized
    } catch (error) {
      // Keep the restored memory state; `lastWritten` stays null so the next flush retries.
      log.warn(`[store-persistence] rewrite failed for ${file}: ${String(error)}`)
    }
  }

  const flushNow = (): void => {
    try {
      const text = serializeSnapshot(store, auditLimit)
      if (text === lastWritten) {
        return
      }
      writeFile(file, text)
      lastWritten = text
    } catch (error) {
      log.warn(`[store-persistence] write failed for ${file}: ${String(error)}`)
    }
  }

  const timer = setInterval(flushNow, intervalMs)
  timer.unref()
  // Why exit: installing a signal listener suppresses Node's default termination,
  // so the flush must be followed by an explicit exit or SIGTERM would be ignored.
  const onSignal = (): void => {
    flushNow()
    process.exit(0)
  }
  process.once('SIGTERM', onSignal)
  process.once('SIGINT', onSignal)

  return {
    flushNow,
    stop: () => {
      clearInterval(timer)
      process.removeListener('SIGTERM', onSignal)
      process.removeListener('SIGINT', onSignal)
    }
  }
}
