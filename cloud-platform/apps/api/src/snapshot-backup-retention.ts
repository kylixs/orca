import fs from 'node:fs'
import path from 'node:path'

/** U249 P3: repeated unreadable starts must not accumulate full snapshots forever. */
const CORRUPT_BACKUP_LIMIT = 3

/** Keeps the newest corrupt backups; pruning is best-effort and never blocks startup. */
export function pruneCorruptBackups(file: string): void {
  try {
    const dir = path.dirname(file)
    const prefix = `${path.basename(file)}.corrupt-`
    const backups = fs.readdirSync(dir)
      .filter((name) => name.startsWith(prefix))
      .map((name) => ({ name, ts: Number(name.slice(prefix.length)) }))
      .filter((entry) => Number.isFinite(entry.ts))
      .sort((left, right) => right.ts - left.ts)
    for (const stale of backups.slice(CORRUPT_BACKUP_LIMIT)) {
      fs.rmSync(path.join(dir, stale.name), { force: true })
    }
  } catch {
    // Ignore: retention must not fail startup.
  }
}
