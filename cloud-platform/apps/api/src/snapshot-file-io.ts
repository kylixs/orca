import fs from 'node:fs'
import path from 'node:path'

/** Returns the snapshot bytes, or null when no snapshot file exists yet. */
export function readSnapshotText(file: string): string | null {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
}

export function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, file)
}

/** Moves an unreadable snapshot aside; returns the backup path for logging. */
export function renameToCorruptBackup(file: string): string {
  const backup = `${file}.corrupt-${Date.now()}`
  fs.renameSync(file, backup)
  return backup
}
