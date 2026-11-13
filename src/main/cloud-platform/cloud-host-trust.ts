import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ownEntries, readField, readNumber, readString } from '../../shared/json-fields'
import { writeSecureJsonFile } from '../../shared/secure-file'

/**
 * Trust-on-first-use pinning of a host's E2EE public key (design §10.4, §14.2).
 *
 * The platform is the key distributor, so without a local pin it could swap a
 * host's key without the user noticing. The first key seen for a host is
 * recorded here; a later, different key closes the connection with 4433 and
 * demands re-verification instead of silently trusting the new one.
 */

export const CLOUD_HOST_TRUST_FILENAME = 'orca-cloud-host-trust.json'

export type PinnedHostKey = {
  fingerprint: string
  e2eePublicKeyB64: string
  pinnedAtMs: number
}

export type HostTrustStore = {
  version: 1
  hosts: Record<string, PinnedHostKey>
}

export type HostKeyVerdict =
  | { state: 'first_use'; fingerprint: string }
  | { state: 'trusted'; fingerprint: string }
  | { state: 'mismatch'; pinnedFingerprint: string; seenFingerprint: string }

/** `sha256:<hex>` over the raw key bytes — stable across base64 re-encodings. */
export function hostKeyFingerprint(e2eePublicKeyB64: string): string {
  const digest = createHash('sha256').update(Buffer.from(e2eePublicKeyB64, 'base64')).digest('hex')
  return `sha256:${digest}`
}

/** Grouped uppercase form for the confirmation dialog and diagnostics. */
export function formatFingerprint(fingerprint: string): string {
  const body = fingerprint.replace(/^sha256:/, '').toUpperCase()
  return body.match(/.{1,4}/g)?.join(' ') ?? body
}

export function emptyHostTrust(): HostTrustStore {
  return { version: 1, hosts: {} }
}

function readPinned(value: unknown): PinnedHostKey | null {
  const fingerprint = readString(value, 'fingerprint')
  const e2eePublicKeyB64 = readString(value, 'e2eePublicKeyB64')
  const pinnedAtMs = readNumber(value, 'pinnedAtMs')
  if (fingerprint === null || e2eePublicKeyB64 === null || pinnedAtMs === null) {
    return null
  }
  return { fingerprint, e2eePublicKeyB64, pinnedAtMs }
}

/** A corrupt file means "nothing pinned yet": re-pinning is safer than trusting a guess. */
export function loadHostTrust(userDataPath: string | undefined): HostTrustStore {
  const store = emptyHostTrust()
  if (!userDataPath) {
    return store
  }
  const path = join(userDataPath, CLOUD_HOST_TRUST_FILENAME)
  if (!existsSync(path)) {
    return store
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    for (const [hostId, value] of ownEntries(readField(parsed, 'hosts'))) {
      const pinned = readPinned(value)
      if (pinned) {
        store.hosts[hostId] = pinned
      }
    }
    return store
  } catch {
    return store
  }
}

export function saveHostTrust(userDataPath: string | undefined, store: HostTrustStore): void {
  if (!userDataPath) {
    return
  }
  writeSecureJsonFile(join(userDataPath, CLOUD_HOST_TRUST_FILENAME), store)
}

export function hostKeyVerdict(
  store: HostTrustStore,
  hostId: string,
  e2eePublicKeyB64: string
): HostKeyVerdict {
  const seenFingerprint = hostKeyFingerprint(e2eePublicKeyB64)
  const pinned = store.hosts[hostId]
  if (!pinned) {
    return { state: 'first_use', fingerprint: seenFingerprint }
  }
  if (pinned.fingerprint === seenFingerprint) {
    return { state: 'trusted', fingerprint: seenFingerprint }
  }
  return {
    state: 'mismatch',
    pinnedFingerprint: pinned.fingerprint,
    seenFingerprint
  }
}

export function pinHostKey(
  store: HostTrustStore,
  hostId: string,
  e2eePublicKeyB64: string,
  nowMs: number
): PinnedHostKey {
  const pinned: PinnedHostKey = {
    fingerprint: hostKeyFingerprint(e2eePublicKeyB64),
    e2eePublicKeyB64,
    pinnedAtMs: nowMs
  }
  store.hosts[hostId] = pinned
  return pinned
}

/** Re-verification after a mismatch: the user accepted the new key. */
export function replaceHostKey(
  store: HostTrustStore,
  hostId: string,
  e2eePublicKeyB64: string,
  nowMs: number
): PinnedHostKey {
  return pinHostKey(store, hostId, e2eePublicKeyB64, nowMs)
}
