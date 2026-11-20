import {
  closeSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeSync
} from 'node:fs'

/**
 * Leader lease for a pair of audit writers (G-04 standby).
 *
 * One writer may append at a time or the chain forks. The holder refreshes the
 * lease file's mtime; a standby takes over once the mtime is older than the TTL,
 * which is what makes the writer replaceable after a crash. This is a lease with
 * a fencing check per batch, not consensus: the takeover race is narrowed by the
 * holder re-reading the file before it writes, so a promoted standby's new owner
 * stamp makes the old holder step down.
 */

export type WriterLease = {
  holderId: string
  isLeader: () => boolean
  /** Tries once to take the lease; true when this process holds it. */
  acquire: () => boolean
  /** Re-reads the lease before a write; false means another process took over. */
  assertLeadership: () => boolean
  release: () => void
}

type LeaseRecord = { holderId: string; since: number }

function readLease(path: string): LeaseRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return null
    const holderId = Reflect.get(parsed, 'holderId')
    const since = Reflect.get(parsed, 'since')
    if (typeof holderId !== 'string' || typeof since !== 'number') return null
    return { holderId, since }
  } catch {
    return null
  }
}

export function createWriterLease(options: {
  path: string
  holderId: string
  ttlMs: number
  now?: () => number
}): WriterLease {
  const now = options.now ?? (() => Date.now())
  let leader = false

  const create = (): boolean => {
    let fd: number
    try {
      fd = openSync(options.path, 'wx', 0o600)
    } catch {
      return false
    }
    try {
      const record: LeaseRecord = { holderId: options.holderId, since: now() }
      writeSync(fd, JSON.stringify(record))
    } finally {
      closeSync(fd)
    }
    return true
  }

  const stale = (): boolean => {
    try {
      return now() - statSync(options.path).mtimeMs > options.ttlMs
    } catch {
      // Gone already: the next create decides.
      return true
    }
  }

  return {
    holderId: options.holderId,
    isLeader: () => leader,
    acquire: () => {
      if (leader) return true
      let taken = create()
      if (!taken && stale()) {
        // A dead holder's stamp is stale; remove it and let the create race decide.
        try {
          unlinkSync(options.path)
          taken = create()
        } catch {
          taken = false
        }
      }
      if (taken) leader = true
      return taken
    },
    assertLeadership: () => {
      if (!leader) return false
      const record = readLease(options.path)
      if (!record || record.holderId !== options.holderId) {
        leader = false
        return false
      }
      try {
        const at = new Date(now())
        utimesSync(options.path, at, at)
      } catch {
        leader = false
        return false
      }
      return true
    },
    release: () => {
      if (!leader) return
      leader = false
      const record = readLease(options.path)
      if (record?.holderId === options.holderId) {
        try {
          unlinkSync(options.path)
        } catch {
          // Already gone; nothing to release.
        }
      }
    }
  }
}
