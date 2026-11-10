import { Directory, File, Paths } from 'expo-file-system'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import { safeLocalFileName } from './file-download-naming'

export const DOWNLOAD_CHUNK_BYTES = 384 * 1024
export const DOWNLOAD_MAX_BYTES = 256 * 1024 * 1024
/** SAF writes decode the whole file to base64 in JS; larger files go through the share sheet. */
export const SAF_MAX_BYTES = 16 * 1024 * 1024
export const DOWNLOAD_CACHE_RETENTION_MS = 24 * 60 * 60 * 1000
export const DOWNLOAD_CACHE_MAX_BYTES = 512 * 1024 * 1024
export const DOWNLOAD_CACHE_DIRECTORY = 'orca-file-actions'

/** Metadata lives beside the payload directories, never inside one, so a file cannot shadow it. */
const CACHE_METADATA_DIRECTORY = '.orca-meta'
const invalidationListeners = new Set<(directoryNames: ReadonlySet<string> | null) => void>()

export type PreparedCachedFile = {
  targetKey: string
  fileName: string
  uri: string
  directoryUri: string
  size: number
  sha256: string
  mimeType: string
  uti: string
  createdAt: number
  usedAt: number
}

type CacheMetadata = {
  fileName: string
  size: number
  sha256: string
  createdAt: number
  usedAt: number
}

export type DownloadCacheEntry = {
  directoryName: string
  size: number
  usedAt: number
  complete: boolean
}

export type DownloadCacheEvictionInput = {
  maxBytes: number
  retentionMs: number
  now: number
}

/**
 * Which cache directories to remove: incomplete ones, ones past the 24h retention, then the
 * least-recently-used until the total is back under the cap.
 */
export function planDownloadCacheEviction(
  entries: readonly DownloadCacheEntry[],
  { maxBytes, retentionMs, now }: DownloadCacheEvictionInput
): string[] {
  const remove = new Set<string>()
  let remaining = 0
  const retained: DownloadCacheEntry[] = []
  for (const entry of entries) {
    if (!entry.complete || now - entry.usedAt > retentionMs) {
      remove.add(entry.directoryName)
    } else {
      retained.push(entry)
      remaining += entry.size
    }
  }
  retained.sort((a, b) => a.usedAt - b.usedAt)
  for (const entry of retained) {
    if (remaining <= maxBytes) {
      break
    }
    remove.add(entry.directoryName)
    remaining -= entry.size
  }
  return [...remove]
}

export function createSha256Digest(): { update(bytes: Uint8Array): void; hex(): string } {
  const hash = sha256.create()
  return {
    update: (bytes) => hash.update(bytes),
    hex: () => bytesToHex(hash.digest())
  }
}

export function downloadCacheRoot(): Directory {
  return new Directory(Paths.cache, DOWNLOAD_CACHE_DIRECTORY)
}

/** One unique directory per prepare; a concurrent or repeated prepare never reuses a file. */
export function createPreparedCacheFile(requestedName: string): {
  file: File
  directory: Directory
  fileName: string
} {
  const root = downloadCacheRoot()
  root.create({ intermediates: true, idempotent: true })
  const directory = new Directory(root, uniqueDirectoryName())
  directory.create({ intermediates: false })
  const fileName = safeLocalFileName(requestedName)
  const file = new File(directory, fileName)
  file.create({ intermediates: true, overwrite: true })
  return { file, directory, fileName }
}

export function appendChunkBase64(file: File, contentBase64: string): void {
  file.write(contentBase64, { encoding: 'base64', append: true })
}

export function writePreparedText(file: File, text: string): void {
  file.write(text)
}

export function completedCachedFile(args: {
  targetKey: string
  fileName: string
  file: File
  directory: Directory
  size: number
  sha256: string
  mimeType: string
  uti: string
}): PreparedCachedFile {
  const now = Date.now()
  const prepared: PreparedCachedFile = {
    targetKey: args.targetKey,
    fileName: args.fileName,
    uri: args.file.uri,
    directoryUri: args.directory.uri,
    size: args.size,
    sha256: args.sha256,
    mimeType: args.mimeType,
    uti: args.uti,
    createdAt: now,
    usedAt: now
  }
  writeCacheMetadata(args.directory, {
    fileName: prepared.fileName,
    size: prepared.size,
    sha256: prepared.sha256,
    createdAt: prepared.createdAt,
    usedAt: prepared.usedAt
  })
  enforceDownloadCacheLimit(now)
  return prepared
}

/** Runtime cap: evicts only completed entries, so a concurrent prepare is never deleted. */
export function enforceDownloadCacheLimit(now = Date.now()): void {
  const entries = readCacheEntries().filter((entry) => entry.complete)
  const evicted = planDownloadCacheEviction(entries, {
    maxBytes: DOWNLOAD_CACHE_MAX_BYTES,
    retentionMs: Number.POSITIVE_INFINITY,
    now
  })
  for (const name of evicted) {
    deleteCacheDirectoryByName(name)
  }
  notifyDownloadCacheInvalidation(new Set(evicted))
}

/** A share target may read the file long after the sheet closes (or after the app is killed). */
export function touchPreparedCacheFile(prepared: PreparedCachedFile, now = Date.now()): void {
  try {
    const directory = new Directory(prepared.directoryUri)
    writeCacheMetadata(directory, {
      fileName: prepared.fileName,
      size: prepared.size,
      sha256: prepared.sha256,
      createdAt: prepared.createdAt,
      usedAt: now
    })
    prepared.usedAt = now
  } catch {
    // A cache directory the OS already reclaimed needs no touch; the action itself succeeded.
  }
}

export function deletePreparedCacheFile(prepared: PreparedCachedFile): void {
  deletePreparedCacheDirectory(prepared.directoryUri)
}

export function deletePreparedCacheDirectory(directoryUri: string): void {
  try {
    new Directory(directoryUri).delete()
  } catch {
    // Already gone is the same state the caller wanted.
  }
}

export function deleteCacheDirectoryByName(directoryName: string): void {
  try {
    new Directory(downloadCacheRoot(), directoryName).delete()
  } catch {
    // Already gone.
  }
}

export function clearDownloadCache(): void {
  const root = downloadCacheRoot()
  if (root.exists) {
    for (const entry of root.list()) {
      try {
        entry.delete()
      } catch {
        // A locked or vanished entry must not stop the rest of the clear.
      }
    }
  }
  notifyDownloadCacheInvalidation(null)
}

export function downloadCacheSize(): number {
  return readCacheEntries().reduce((total, entry) => total + entry.size, 0)
}

/** Startup sweep: incomplete prepares and entries older than the retention window. */
export function cleanupDownloadCacheOnStartup(now = Date.now()): void {
  const root = downloadCacheRoot()
  if (!root.exists) {
    return
  }
  const entries = readCacheEntries()
  const evicted = planDownloadCacheEviction(entries, {
    maxBytes: DOWNLOAD_CACHE_MAX_BYTES,
    retentionMs: DOWNLOAD_CACHE_RETENTION_MS,
    now
  })
  for (const name of evicted) {
    deleteCacheDirectoryByName(name)
  }
  notifyDownloadCacheInvalidation(new Set(evicted))
}

function readCacheEntries(): DownloadCacheEntry[] {
  const root = downloadCacheRoot()
  if (!root.exists) {
    return []
  }
  const entries: DownloadCacheEntry[] = []
  for (const entry of root.list()) {
    if (!(entry instanceof Directory) || entry.name === CACHE_METADATA_DIRECTORY) {
      continue
    }
    const metadata = readCacheMetadata(entry)
    const directoryName = entry.name
    if (!metadata) {
      entries.push({ directoryName, size: 0, usedAt: 0, complete: false })
      continue
    }
    entries.push({
      directoryName,
      size: metadata.size,
      usedAt: metadata.usedAt,
      complete: true
    })
  }
  return entries
}

export function subscribeDownloadCacheInvalidation(
  listener: (directoryNames: ReadonlySet<string> | null) => void
): () => void {
  invalidationListeners.add(listener)
  return () => {
    invalidationListeners.delete(listener)
  }
}

/** The per-download directory name, as it appears in the cache root. */
export function downloadCacheDirectoryName(directoryUri: string): string {
  const tail = directoryUri.split('/').pop() ?? ''
  try {
    return decodeURIComponent(tail)
  } catch {
    return tail
  }
}

function notifyDownloadCacheInvalidation(directoryNames: ReadonlySet<string> | null): void {
  for (const listener of invalidationListeners) {
    listener(directoryNames)
  }
}

function cacheMetadataFile(directory: Directory): File {
  return new File(
    new Directory(downloadCacheRoot(), CACHE_METADATA_DIRECTORY),
    `${directory.name}.json`
  )
}

function writeCacheMetadata(directory: Directory, metadata: CacheMetadata): void {
  new Directory(downloadCacheRoot(), CACHE_METADATA_DIRECTORY).create({
    intermediates: true,
    idempotent: true
  })
  cacheMetadataFile(directory).write(JSON.stringify(metadata))
}

function readCacheMetadata(directory: Directory): CacheMetadata | null {
  try {
    const file = cacheMetadataFile(directory)
    if (!file.exists) {
      return null
    }
    const parsed: unknown = JSON.parse(file.textSync())
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !('fileName' in parsed) ||
      typeof parsed.fileName !== 'string' ||
      !('size' in parsed) ||
      typeof parsed.size !== 'number' ||
      !('sha256' in parsed) ||
      typeof parsed.sha256 !== 'string' ||
      !('createdAt' in parsed) ||
      typeof parsed.createdAt !== 'number' ||
      !('usedAt' in parsed) ||
      typeof parsed.usedAt !== 'number'
    ) {
      return null
    }
    return {
      fileName: parsed.fileName,
      size: parsed.size,
      sha256: parsed.sha256,
      createdAt: parsed.createdAt,
      usedAt: parsed.usedAt
    }
  } catch {
    return null
  }
}

function uniqueDirectoryName(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
